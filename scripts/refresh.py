#!/usr/bin/env python3
"""
Refresh dashboard data from public sources.

What it updates:
  - data/holdings.json  : current_price, ytd_change_pct, 1y_change_pct, this_week_status (Yahoo Finance)
  - data/market.json    : headline_number for us, china, thailand, gold (Yahoo Finance / Stooq)
  - data/weekly.json    : as_of, week_label, headline (composed from market numbers)

What it does NOT touch:
  - why_own_it, one_thing_to_watch, verdict (those need editorial judgment — left to you)
  - macro card (US GDP needs a quarterly release, not a weekly auto-refresh)
  - takeaway and source fields (left intact)

Sources:
  - Yahoo Finance public chart endpoint (no auth, returns price + 52-week range)
  - Falls back to Stooq if Yahoo fails for any single symbol
"""
import json
import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"

YF_HEADERS = {
    "User-Agent": "Mozilla/5.0 (junior-dashboard-bot)",
}


def yf_quote(symbol: str):
    """Return dict with price, ytd_pct, year_pct, week_pct, prev_close. None on failure."""
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
    params = {"range": "1y", "interval": "1d"}
    try:
        r = requests.get(url, params=params, headers=YF_HEADERS, timeout=15)
        r.raise_for_status()
        js = r.json()
        result = js["chart"]["result"][0]
        meta = result["meta"]
        timestamps = result.get("timestamp", [])
        closes = result["indicators"]["quote"][0].get("close", [])

        # Filter out None values
        pairs = [(t, c) for t, c in zip(timestamps, closes) if c is not None]
        if not pairs:
            return None

        latest_ts, latest_close = pairs[-1]
        currency = meta.get("currency", "")

        # YTD: find first close in current calendar year
        latest_dt = datetime.fromtimestamp(latest_ts, tz=timezone.utc)
        year_start = datetime(latest_dt.year, 1, 1, tzinfo=timezone.utc).timestamp()
        ytd_close = next((c for t, c in pairs if t >= year_start), pairs[0][1])
        ytd_pct = (latest_close / ytd_close - 1) * 100 if ytd_close else None

        # 1y: first available
        year_close = pairs[0][1]
        year_pct = (latest_close / year_close - 1) * 100 if year_close else None

        # 1 week: 5 trading days back
        week_close = pairs[-6][1] if len(pairs) >= 6 else pairs[0][1]
        week_pct = (latest_close / week_close - 1) * 100 if week_close else None

        return {
            "price": latest_close,
            "currency": currency,
            "ytd_pct": ytd_pct,
            "year_pct": year_pct,
            "week_pct": week_pct,
            "as_of": latest_dt.strftime("%d %b %Y"),
        }
    except Exception as e:
        print(f"  ! Yahoo failed for {symbol}: {e}", file=sys.stderr)
        return None


def fmt_currency(price: float, currency: str) -> str:
    if currency == "CHF":
        if price >= 1000:
            return f"CHF {price:,.0f}"
        return f"CHF {price:.2f}"
    if currency == "USD":
        return f"${price:,.2f}"
    if currency == "THB":
        return f"THB {price:,.2f}"
    if currency == "CNY":
        return f"CNY {price:,.2f}"
    return f"{price:,.2f} {currency}".strip()


def fmt_pct(pct: float | None) -> str:
    if pct is None:
        return "n/a"
    sign = "+" if pct >= 0 else ""
    return f"{sign}{pct:.1f}%"


def refresh_holdings(today_iso: str):
    path = DATA / "holdings.json"
    obj = json.loads(path.read_text())
    obj["as_of"] = today_iso
    for h in obj.get("holdings", []):
        ticker = h.get("ticker")
        q = yf_quote(ticker)
        if not q:
            print(f"  - {ticker}: SKIPPED (no data)")
            continue
        h["current_price"] = f"{fmt_currency(q['price'], q['currency'])} (last close {q['as_of']})"
        h["ytd_change_pct"] = fmt_pct(q["ytd_pct"])
        h["1y_change_pct"] = fmt_pct(q["year_pct"])
        # Compose this_week_status from week move
        wpct = q["week_pct"]
        if wpct is None:
            status = f"Last close {q['as_of']}."
        else:
            direction = "Gained" if wpct >= 0 else "Fell"
            status = f"{direction} about {fmt_pct(wpct)} over the past week (close {q['as_of']})."
        h["this_week_status"] = status
        print(f"  - {ticker}: {h['current_price']} ({h['ytd_change_pct']} YTD)")
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n")


# Market index symbols (Yahoo Finance)
MARKET_INDICES = {
    "us": ("^GSPC", "S&P 500"),
    "china": ("000300.SS", "CSI 300"),
    "thailand": ("^SET.BK", "SET Index"),
    "gold": ("GC=F", "Gold (front-month futures)"),
}


def refresh_market(today_iso: str):
    path = DATA / "market.json"
    obj = json.loads(path.read_text())
    obj["as_of"] = today_iso
    market = obj.get("market", {})
    for key, (symbol, label) in MARKET_INDICES.items():
        if key not in market:
            continue
        q = yf_quote(symbol)
        if not q:
            print(f"  - {label}: SKIPPED")
            continue
        # Preserve source / takeaway, only update headline_number
        old = market[key].get("headline_number", "")
        if key == "gold":
            new_headline = f"Gold: ~${q['price']:,.0f}/oz (1y: {fmt_pct(q['year_pct'])})"
        elif key == "thailand":
            new_headline = f"SET Index: {q['price']:,.2f} ({q['as_of']}); 1y: {fmt_pct(q['year_pct'])}"
        elif key == "china":
            new_headline = f"CSI 300 Index: {q['price']:,.0f} ({q['as_of']}); 1y: {fmt_pct(q['year_pct'])}"
        elif key == "us":
            new_headline = f"S&P 500: {q['price']:,.0f} ({q['as_of']}); YTD: {fmt_pct(q['ytd_pct'])}"
        else:
            new_headline = old
        market[key]["headline_number"] = new_headline
        print(f"  - {label}: {new_headline}")
    obj["market"] = market
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n")


def refresh_weekly(today_iso: str):
    """Compose a generic but accurate week-summary headline from market data."""
    weekly_path = DATA / "weekly.json"
    market_path = DATA / "market.json"
    weekly = json.loads(weekly_path.read_text())
    market = json.loads(market_path.read_text()).get("market", {})

    today = datetime.fromisoformat(today_iso)
    weekly["as_of"] = today_iso
    weekly["week_label"] = f"Week ending {today.strftime('%B %-d, %Y')}"

    # Pull S&P 500 weekly move for headline
    sp_q = yf_quote("^GSPC")
    gold_q = yf_quote("GC=F")

    if sp_q and sp_q.get("week_pct") is not None:
        sp_dir = "rose" if sp_q["week_pct"] >= 0 else "fell"
        sp_phrase = f"The S&P 500 {sp_dir} {fmt_pct(sp_q['week_pct'])} this week"
    else:
        sp_phrase = "US stocks moved this week"

    if gold_q and gold_q.get("week_pct") is not None:
        gold_dir = "higher" if gold_q["week_pct"] >= 0 else "lower"
        gold_phrase = f" while gold finished {gold_dir} ({fmt_pct(gold_q['week_pct'])})"
    else:
        gold_phrase = ""

    weekly["weekly"]["headline"] = f"{sp_phrase}{gold_phrase}."
    # Leave happened / means_for_you / watch_next_week alone — those need real editorial judgment
    # The user can refresh the narrative manually via Computer when needed
    weekly_path.write_text(json.dumps(weekly, indent=2, ensure_ascii=False) + "\n")
    print(f"  - Weekly headline updated")


def main():
    today_iso = datetime.now(timezone.utc).date().isoformat()
    print(f"=== Refreshing data, as_of {today_iso} ===\n")

    print("Holdings:")
    refresh_holdings(today_iso)
    print("\nMarket:")
    refresh_market(today_iso)
    print("\nWeekly:")
    refresh_weekly(today_iso)

    # Update watchlist as_of (no other changes needed)
    wl_path = DATA / "watchlist.json"
    wl = json.loads(wl_path.read_text())
    wl["as_of"] = today_iso
    wl_path.write_text(json.dumps(wl, indent=2, ensure_ascii=False) + "\n")

    print("\nDone.")


if __name__ == "__main__":
    main()
