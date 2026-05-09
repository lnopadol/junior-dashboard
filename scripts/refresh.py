#!/usr/bin/env python3
"""
Refresh Holdings and Watchlist data on every Refresh button click.

Pipeline:
  1. PRICES (fast, free): Yahoo Finance for any ticker that resolves there.
     Updates current_price, ytd_change_pct, 1y_change_pct, this_week_status.
     Falls through gracefully for non-Yahoo tickers (Thai mutual funds, etc.) —
     leaves price field for the AI step to handle.

  2. EDITORIAL (Perplexity sonar-pro): for each holding, asks for:
       what_it_does (1 sentence)
       why_own_it (3 short bullet sentences for a beginner)
       one_thing_to_watch (1 sentence)
       dividend_yield_pct (string like "~3.5% (TTM)")
       verdict (Healthy | Caution | Concern)
       sources (2-3 reputable: company IR, Reuters, Bloomberg, etc.)
     Plus, if Yahoo failed for the ticker, a current price string from the AMC site.

  3. WATCHLIST: same pipeline but verdict ∈ (Buy | Wait | Ignore) and
     fields are why, key_risk, what_it_does, price, sources.

The Market and Weekly tabs are NOT touched here — those are the cron's job.
"""
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"

YF_HEADERS = {"User-Agent": "Mozilla/5.0 (junior-dashboard-bot)"}
PPLX_KEY = os.environ.get("PPLX_API_KEY", "").strip()
PPLX_ENDPOINT = "https://api.perplexity.ai/chat/completions"
PPLX_MODEL = "sonar-pro"


# ============================================================
# Yahoo Finance (prices)
# ============================================================

def yf_quote(symbol: str):
    """Returns dict or None on failure (e.g. ticker not on Yahoo)."""
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
    try:
        r = requests.get(url, params={"range": "1y", "interval": "1d"},
                         headers=YF_HEADERS, timeout=15)
        if r.status_code == 404:
            return None
        r.raise_for_status()
        js = r.json()
        result = js["chart"]["result"][0]
        meta = result["meta"]
        timestamps = result.get("timestamp", [])
        closes = result["indicators"]["quote"][0].get("close", [])
        pairs = [(t, c) for t, c in zip(timestamps, closes) if c is not None]
        if not pairs:
            return None

        latest_ts, latest_close = pairs[-1]
        currency = meta.get("currency", "")
        latest_dt = datetime.fromtimestamp(latest_ts, tz=timezone.utc)

        year_start = datetime(latest_dt.year, 1, 1, tzinfo=timezone.utc).timestamp()
        ytd_close = next((c for t, c in pairs if t >= year_start), pairs[0][1])
        ytd_pct = (latest_close / ytd_close - 1) * 100 if ytd_close else None
        year_pct = (latest_close / pairs[0][1] - 1) * 100 if pairs[0][1] else None
        week_close = pairs[-6][1] if len(pairs) >= 6 else pairs[0][1]
        week_pct = (latest_close / week_close - 1) * 100 if week_close else None

        return {
            "price": latest_close, "currency": currency,
            "ytd_pct": ytd_pct, "year_pct": year_pct, "week_pct": week_pct,
            "as_of": latest_dt.strftime("%d %b %Y"),
        }
    except Exception as e:
        print(f"  ! Yahoo failed for {symbol}: {e}", file=sys.stderr)
        return None


def fmt_currency(price: float, currency: str) -> str:
    if currency == "CHF":
        return f"CHF {price:,.0f}" if price >= 1000 else f"CHF {price:.2f}"
    if currency == "USD": return f"${price:,.2f}"
    if currency == "THB": return f"THB {price:,.2f}"
    if currency == "CNY": return f"CNY {price:,.2f}"
    return f"{price:,.2f} {currency}".strip()


def fmt_pct(pct):
    if pct is None: return "n/a"
    return f"{'+' if pct >= 0 else ''}{pct:.1f}%"


# ============================================================
# Source whitelist (filters out aggregators / blogs the model loves to cite)
# ============================================================

SOURCE_WHITELIST_DOMAINS = (
    # Official IR / company
    "roche.com", "nestle.com", "givaudan.com", "novartis.com",
    # News
    "reuters.com", "bloomberg.com", "ft.com", "wsj.com", "cnbc.com",
    "marketwatch.com", "economist.com", "barrons.com",
    # Exchanges / regulators
    "sec.gov", "six-group.com", "set.or.th", "hkex.com.hk",
    "federalreserve.gov", "bea.gov", "bls.gov", "bot.or.th",
    "gold.org",
    # Thai fund providers
    "krungsriasset.com", "settrade.com", "efinancethai.com",
    "kasikornassetmanagement.com", "scbam.com", "uobam.co.th",
)

BLACKLIST_HINTS = ("digrin", "biggo", "seekingalpha", "reddit", "medium.com",
                   "investing.com", "yahoo.com", "benzinga", "motleyfool",
                   "stockanalysis", "fool.com")


def filter_sources(sources):
    """Keep only whitelisted, drop empty/blacklisted. Returns at most 3."""
    out = []
    for src in sources or []:
        if not isinstance(src, dict): continue
        url = (src.get("url") or "").lower().strip()
        name = (src.get("name") or "").strip()
        if not url or not name: continue
        if any(bad in url for bad in BLACKLIST_HINTS): continue
        if any(good in url for good in SOURCE_WHITELIST_DOMAINS):
            out.append({"name": src["name"], "url": src["url"]})
    return out[:3]


# ============================================================
# Perplexity API (editorial research)
# ============================================================

def pplx_research(prompt: str, max_retries: int = 2) -> dict:
    """Calls Perplexity sonar-pro and returns parsed JSON from the response.

    The model is asked to return a JSON object. We extract the first {...} block.
    """
    if not PPLX_KEY:
        raise RuntimeError("PPLX_API_KEY is not set. Add it as a repo secret.")

    headers = {
        "Authorization": f"Bearer {PPLX_KEY}",
        "Content-Type": "application/json",
    }
    body = {
        "model": PPLX_MODEL,
        "messages": [
            {"role": "system", "content": (
                "You research investments for a beginner investor. "
                "Use ONLY reputable sources: company IR pages, Reuters, Bloomberg, FT, "
                "WSJ, official exchanges, central banks. "
                "Never use blogs, Seeking Alpha, or opinion sites. "
                "Always respond with a single valid JSON object — no prose, no markdown fences."
            )},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.2,
        "max_tokens": 1500,
    }

    last_err = None
    for attempt in range(max_retries + 1):
        try:
            r = requests.post(PPLX_ENDPOINT, headers=headers, json=body, timeout=60)
            r.raise_for_status()
            content = r.json()["choices"][0]["message"]["content"]
            # Extract first JSON object from the response
            match = re.search(r"\{.*\}", content, re.DOTALL)
            if not match:
                raise ValueError(f"No JSON in response: {content[:200]}")
            return json.loads(match.group(0))
        except Exception as e:
            last_err = e
            if attempt < max_retries:
                time.sleep(2 + attempt * 2)
                continue
            raise


def research_holding(ticker: str, company_hint: str, needs_price: bool, today_iso: str):
    """Returns dict with editorial fields (and price string if needs_price)."""
    price_clause = (
        " 'current_price' (string, today's NAV or close price with currency, e.g. 'THB 12.34 (NAV 8 May 2026)'),\n  - 'ytd_change_pct' (string like '+5.2%' or '-1.0%' or 'N/A')\n  - '1y_change_pct' (string like '+12.0%' or 'N/A')"
        if needs_price else ""
    )
    prompt = f"""Research the security with ticker "{ticker}" (hint: company/fund name "{company_hint}") for a beginner long-term investor. Today is {today_iso}.

Return ONE JSON object with EXACTLY these fields:
- "company": string, official company or fund name
- "what_it_does": string, one sentence in plain English explaining what the company/fund does
- "why_own_it": ARRAY OF EXACTLY 3 STRINGS — no more, no fewer, no empty strings. Each is a single beginner-friendly sentence explaining why a long-term investor would hold this.
- "one_thing_to_watch": string, one sentence about the single biggest risk to monitor
- "dividend_yield_pct": string like "~3.5% (TTM)" or "N/A (no dividend)" or "~1.8% (FY2025 proposed)"
- "verdict": one of EXACTLY "Healthy", "Caution", or "Concern"
- "this_week_status": string, one sentence on the most recent week's price action and any news driving it. Use the actual current week ending {today_iso}, NOT past months.{price_clause}
- "sources": array of 2-3 objects {{"name", "url"}}. SOURCES MUST BE FROM THIS WHITELIST ONLY: official company IR pages (e.g. roche.com/investors, nestle.com/investors), Reuters (reuters.com), Bloomberg (bloomberg.com), Financial Times (ft.com), Wall Street Journal (wsj.com), CNBC (cnbc.com), official exchanges (six-group.com, set.or.th, krungsriasset.com for Thai funds, settrade.com). NEVER use Digrin, BigGo, Seeking Alpha, blogs, Reddit, or aggregator sites.

The ticker "{ticker}" may be a Thai mutual fund (Krungsri, K Plus, SCB, etc.) — if so, find NAV from krungsriasset.com or settrade.com.

Output a single valid JSON object. No markdown, no prose, no code fences."""

    print(f"  [pplx] researching {ticker}...")
    return pplx_research(prompt)


def research_watchlist(ticker: str, company_hint: str, needs_price: bool, today_iso: str):
    price_clause = (
        " 'price' (string, today's quote/NAV with currency, e.g. 'THB 7.45 (NAV 8 May 2026)'),"
        if needs_price else ""
    )
    prompt = f"""Research the security with ticker "{ticker}" (hint: "{company_hint}") for a beginner investor deciding whether to BUY, WAIT, or IGNORE. Today is {today_iso}.

Return ONE JSON object with EXACTLY these fields:
- "company": string
- "what_it_does": string, one sentence in plain English
- "verdict": one of EXACTLY "Buy", "Wait", or "Ignore"
- "why": string, one to two sentences justifying the verdict
- "key_risk": string, one sentence on the single biggest risk{price_clause}
- "sources": array of 2-3 {{"name", "url"}}. SOURCES MUST BE FROM: official company IR, Reuters, Bloomberg, FT, WSJ, CNBC, official exchanges (set.or.th, six-group.com), Thai AMC sites (krungsriasset.com, settrade.com). NEVER use Digrin, BigGo, Seeking Alpha, blogs, or aggregators.

Output a single valid JSON object. No markdown, no prose, no code fences."""

    print(f"  [pplx] researching watchlist {ticker}...")
    return pplx_research(prompt)


# ============================================================
# Holdings refresh
# ============================================================

def refresh_holdings(today_iso: str):
    path = DATA / "holdings.json"
    obj = json.loads(path.read_text())
    obj["as_of"] = today_iso

    for h in obj.get("holdings", []):
        ticker = (h.get("ticker") or "").strip()
        # Sanitize duplicate-ticker bug ("ABC ABC" -> "ABC")
        parts = ticker.split()
        if len(parts) == 2 and parts[0] == parts[1]:
            ticker = parts[0]
            h["ticker"] = ticker
        company_hint = h.get("company") or ""

        # 1) Try Yahoo for prices
        yahoo_ok = False
        q = yf_quote(ticker) if ticker else None
        if q:
            yahoo_ok = True
            h["current_price"] = f"{fmt_currency(q['price'], q['currency'])} (last close {q['as_of']})"
            h["ytd_change_pct"] = fmt_pct(q["ytd_pct"])
            h["1y_change_pct"] = fmt_pct(q["year_pct"])
            wpct = q["week_pct"]
            if wpct is not None:
                direction = "Gained" if wpct >= 0 else "Fell"
                h["this_week_status"] = f"{direction} about {fmt_pct(wpct)} over the past week (close {q['as_of']})."
            print(f"  [yahoo] {ticker}: {h['current_price']} ({h['ytd_change_pct']} YTD)")

        # 2) Always run editorial research (always-fresh per user request)
        try:
            ed = research_holding(ticker, company_hint, needs_price=not yahoo_ok, today_iso=today_iso)
        except Exception as e:
            print(f"  ! Perplexity research failed for {ticker}: {e}", file=sys.stderr)
            continue

        # Apply editorial fields, preserving anything we already wrote from Yahoo
        if ed.get("company"): h["company"] = ed["company"]
        if ed.get("what_it_does"): h["what_it_does"] = ed["what_it_does"]
        # Sanitize why_own_it: drop empties, cap at 3
        if ed.get("why_own_it"):
            cleaned = [str(x).strip() for x in ed["why_own_it"] if str(x).strip()]
            h["why_own_it"] = cleaned[:3]
        if ed.get("one_thing_to_watch"): h["one_thing_to_watch"] = ed["one_thing_to_watch"]
        if ed.get("dividend_yield_pct"): h["dividend_yield_pct"] = ed["dividend_yield_pct"]
        if ed.get("verdict") in ("Healthy", "Caution", "Concern"):
            h["verdict"] = ed["verdict"]
        # Filter out non-whitelisted sources
        if ed.get("sources"):
            h["sources"] = filter_sources(ed["sources"])
        # Price/this_week_status from AI ONLY if Yahoo couldn't provide it
        if not yahoo_ok:
            if ed.get("current_price"): h["current_price"] = ed["current_price"]
            if ed.get("ytd_change_pct"): h["ytd_change_pct"] = ed["ytd_change_pct"]
            if ed.get("1y_change_pct"): h["1y_change_pct"] = ed["1y_change_pct"]
            if ed.get("this_week_status"): h["this_week_status"] = ed["this_week_status"]
        # When Yahoo provided the price, keep Yahoo's this_week_status — don't let AI overwrite with stale dates

    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n")


# ============================================================
# Watchlist refresh
# ============================================================

def refresh_watchlist(today_iso: str):
    path = DATA / "watchlist.json"
    obj = json.loads(path.read_text())
    obj["as_of"] = today_iso

    for s in obj.get("stocks", []):
        ticker = (s.get("ticker") or "").strip()
        parts = ticker.split()
        if len(parts) == 2 and parts[0] == parts[1]:
            ticker = parts[0]
            s["ticker"] = ticker
        company_hint = s.get("company") or ""

        yahoo_ok = False
        q = yf_quote(ticker) if ticker else None
        if q:
            yahoo_ok = True
            s["price"] = f"{fmt_currency(q['price'], q['currency'])} (last close {q['as_of']})"
            print(f"  [yahoo] {ticker}: {s['price']}")

        try:
            ed = research_watchlist(ticker, company_hint, needs_price=not yahoo_ok, today_iso=today_iso)
        except Exception as e:
            print(f"  ! Perplexity research failed for {ticker}: {e}", file=sys.stderr)
            continue

        if ed.get("company"): s["company"] = ed["company"]
        if ed.get("what_it_does"): s["what_it_does"] = ed["what_it_does"]
        if ed.get("verdict") in ("Buy", "Wait", "Ignore"):
            s["verdict"] = ed["verdict"]
        if ed.get("why"): s["why"] = ed["why"]
        if ed.get("key_risk"): s["key_risk"] = ed["key_risk"]
        if ed.get("sources"):
            s["sources"] = filter_sources(ed["sources"])
        if not yahoo_ok and ed.get("price"):
            s["price"] = ed["price"]

    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n")


# ============================================================
# Main
# ============================================================

def main():
    today_iso = datetime.now(timezone.utc).date().isoformat()
    print(f"=== Refreshing Holdings + Watchlist, as_of {today_iso} ===\n")

    if not PPLX_KEY:
        print("ERROR: PPLX_API_KEY is not set. Add it as a repo secret at:")
        print("  https://github.com/lnopadol/junior-dashboard/settings/secrets/actions")
        sys.exit(1)

    print("Holdings:")
    refresh_holdings(today_iso)
    print("\nWatchlist:")
    refresh_watchlist(today_iso)
    print("\nDone.")


if __name__ == "__main__":
    main()
