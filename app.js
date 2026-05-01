// Investor Dashboard — beginner-friendly 4-tab dashboard
// Data lives in /data/{weekly,market,holdings,watchlist}.json
// Edits to holdings.json and watchlist.json commit to GitHub when signed in.

const STATE = {
  weekly: null,
  market: null,
  holdings: null,
  watchlist: null,
  activeTab: "weekly",
};

// ---- Helpers ----
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

function escapeHtml(s) {
  return (s == null ? "" : String(s)).replace(/[&<>"']/g, (c) =>
    ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])
  );
}
function verdictPill(v) {
  if (!v) return `<span class="pill gray">—</span>`;
  const l = v.toLowerCase();
  if (l === "healthy" || l === "buy") return `<span class="pill green">${escapeHtml(v)}</span>`;
  if (l === "caution" || l === "wait") return `<span class="pill amber">${escapeHtml(v)}</span>`;
  if (l === "concern" || l === "ignore") return `<span class="pill red">${escapeHtml(v)}</span>`;
  return `<span class="pill gray">${escapeHtml(v)}</span>`;
}
function verdictDot(v) {
  if (!v) return `<span class="dot gray"></span>`;
  const l = v.toLowerCase();
  if (l === "healthy" || l === "buy") return `<span class="dot green"></span>`;
  if (l === "caution" || l === "wait") return `<span class="dot amber"></span>`;
  if (l === "concern" || l === "ignore") return `<span class="dot red"></span>`;
  return `<span class="dot gray"></span>`;
}
function fmtSourceList(sources) {
  if (!sources || !sources.length) return "";
  return `<div class="source-list">Sources: ${sources.map(s =>
    `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.name)}</a>`
  ).join(" · ")}</div>`;
}

// ---- Edit-mode plumbing ----
function applyEditMode() {
  const banner = $("#readOnlyBanner");
  if (GH.isSignedIn()) {
    document.body.classList.remove("readonly");
    $("#signInBtn").textContent = "Account";
    GH.setStatus("saved");
    if (banner) banner.hidden = true;
  } else {
    document.body.classList.add("readonly");
    $("#signInBtn").textContent = "Sign in";
    GH.setStatus("signed-out");
    if (banner) banner.hidden = false;
  }
  // Re-render to show/hide edit affordances
  renderActiveTab();
}

// ---- Loading ----
async function loadAll() {
  const fetchJson = async (path, fallback) => {
    try {
      const r = await fetch(path + "?t=" + Date.now(), { cache: "no-store" });
      if (!r.ok) return fallback;
      return await r.json();
    } catch (e) { return fallback; }
  };
  const [weekly, market, holdings, watchlist] = await Promise.all([
    fetchJson("data/weekly.json",   { as_of: "—", week_label: "—", weekly: {} }),
    fetchJson("data/market.json",   { as_of: "—", market: {} }),
    fetchJson("data/holdings.json", { as_of: "—", holdings: [] }),
    fetchJson("data/watchlist.json",{ as_of: "—", stocks: [] }),
  ]);
  STATE.weekly = weekly;
  STATE.market = market;
  STATE.holdings = holdings;
  STATE.watchlist = watchlist;

  $("#subline").textContent =
    `Updated ${weekly.as_of || "—"} · ${weekly.week_label || ""}`;

  renderActiveTab();
}

// ---- Tabs ----
function setActiveTab(tabKey) {
  STATE.activeTab = tabKey;
  $$(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === tabKey));
  $$(".pane").forEach(p => p.classList.toggle("active", p.dataset.pane === tabKey));
  renderActiveTab();
}
function renderActiveTab() {
  switch (STATE.activeTab) {
    case "weekly": renderWeekly(); break;
    case "market": renderMarket(); break;
    case "holdings": renderHoldings(); break;
    case "watchlist": renderWatchlist(); break;
  }
}

// ---- Tab 1: Weekly Update ----
function renderWeekly() {
  const w = STATE.weekly?.weekly || {};
  const label = STATE.weekly?.week_label || "This week";
  const headline = w.headline || "Weekly summary not yet available. Sign in and add this week's update.";
  const blocks = [
    ["What happened", w.happened || "—"],
    ["What it means for you", w.means_for_you || "—"],
    ["Watch next week", w.watch_next_week || "—"],
  ];
  $("#weeklyPane").innerHTML = `
    <div class="weekly-hero">
      <div class="week-label">${escapeHtml(label)}</div>
      <h2>${escapeHtml(headline)}</h2>
      <div class="week-blocks">
        ${blocks.map(([l, t]) => `
          <div class="wb-card">
            <div class="wb-label">${l}</div>
            <div class="wb-text">${escapeHtml(t)}</div>
          </div>`).join("")}
      </div>
    </div>
    <p class="muted" style="font-size:12px">Last updated ${escapeHtml(STATE.weekly?.as_of || "—")}</p>
  `;
}

// ---- Tab 2: Market Update ----
function renderMarket() {
  const m = STATE.market?.market || {};
  const cards = [
    ["macro",    "Macro events"],
    ["gold",     "Gold"],
    ["china",    "China"],
    ["thailand", "Thailand"],
    ["us",       "US"],
  ];
  const html = cards.map(([key, label]) => {
    const c = m[key] || {};
    const src = c.source ? `<div class="mc-src">📎 <a href="${escapeHtml(c.source.url)}" target="_blank" rel="noopener">${escapeHtml(c.source.name)}</a></div>` : "";
    return `
      <div class="market-card">
        <div class="mc-cat">${label}</div>
        <div class="mc-num">${escapeHtml(c.headline_number || "—")}</div>
        <div class="mc-take">${escapeHtml(c.takeaway || "Update pending.")}</div>
        ${src}
      </div>`;
  }).join("");
  $("#marketPane").innerHTML = `
    <div class="section-head">
      <div>
        <h2>Market Update</h2>
        <p>Five quick reads on what moved this week, from reputable sources only.</p>
      </div>
    </div>
    <div class="market-grid">${html}</div>
  `;
}

// ---- Tab 3: My Holdings ----
function renderHoldings() {
  const items = STATE.holdings?.holdings || [];
  const counts = { Healthy: 0, Caution: 0, Concern: 0 };
  items.forEach(h => { if (counts[h.verdict] != null) counts[h.verdict]++; });
  const summary = `
    <div class="summary-row">
      <div class="card"><div class="label">Total holdings</div><div class="val">${items.length}</div></div>
      <div class="card"><div class="label">Healthy</div><div class="val" style="color:var(--green-fg)">${counts.Healthy}</div></div>
      <div class="card"><div class="label">Caution</div><div class="val" style="color:var(--amber-fg)">${counts.Caution}</div></div>
      <div class="card"><div class="label">Concern</div><div class="val" style="color:var(--red-fg)">${counts.Concern}</div></div>
    </div>`;
  const rows = items.map(h => `
    <tr class="row" data-list="holdings" data-id="${escapeHtml(h.ticker)}">
      <td>
        <div class="ticker">${escapeHtml(h.ticker)}</div>
        <div class="company">${escapeHtml(h.company || "")}</div>
      </td>
      <td class="note">${escapeHtml(h.what_it_does || "—")}</td>
      <td>${verdictPill(h.verdict)}</td>
      <td class="note">${escapeHtml(h.this_week_status || "—")}</td>
      <td class="delcol">
        <button class="btn danger del-btn" data-list="holdings" data-id="${escapeHtml(h.ticker)}" title="Remove">×</button>
      </td>
    </tr>`).join("") || `<tr><td colspan="5" class="muted" style="padding:24px;text-align:center">No holdings yet. Sign in and tap "Add holding".</td></tr>`;

  $("#holdingsPane").innerHTML = `
    <div class="section-head">
      <div>
        <h2>My Holdings</h2>
        <p>Your portfolio. Tap any row to see details. Use weekly check to track health.</p>
      </div>
      <div>
        <button class="btn primary" id="addHoldingBtn">+ Add holding</button>
      </div>
    </div>
    ${summary}
    <table class="tbl">
      <thead>
        <tr>
          <th style="width:18%">Asset</th>
          <th>What it is</th>
          <th style="width:110px">Verdict</th>
          <th>This week</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="muted" style="font-size:12px;margin-top:12px">Last updated ${escapeHtml(STATE.holdings?.as_of || "—")}</p>
  `;
  wireListInteractions("holdings");
  $("#addHoldingBtn").onclick = () => openAddModal("holdings");
}

// ---- Tab 4: Stock Watch List ----
function renderWatchlist() {
  const items = STATE.watchlist?.stocks || [];
  const counts = { Buy: 0, Wait: 0, Ignore: 0 };
  items.forEach(s => { if (counts[s.verdict] != null) counts[s.verdict]++; });
  const summary = `
    <div class="summary-row">
      <div class="card"><div class="label">On watch</div><div class="val">${items.length}</div></div>
      <div class="card"><div class="label">Buy</div><div class="val" style="color:var(--green-fg)">${counts.Buy}</div></div>
      <div class="card"><div class="label">Wait</div><div class="val" style="color:var(--amber-fg)">${counts.Wait}</div></div>
      <div class="card"><div class="label">Ignore</div><div class="val" style="color:var(--red-fg)">${counts.Ignore}</div></div>
    </div>`;
  const rows = items.map(s => `
    <tr class="row" data-list="watchlist" data-id="${escapeHtml(s.ticker)}">
      <td>
        <div class="ticker">${escapeHtml(s.ticker)}</div>
        <div class="company">${escapeHtml(s.company || "")}</div>
      </td>
      <td class="note">${escapeHtml(s.what_it_does || "—")}</td>
      <td class="num">${escapeHtml(s.price || "—")}</td>
      <td>${verdictPill(s.verdict)}</td>
      <td class="note">${escapeHtml(s.why || "—")}</td>
      <td class="delcol">
        <button class="btn danger del-btn" data-list="watchlist" data-id="${escapeHtml(s.ticker)}" title="Remove">×</button>
      </td>
    </tr>`).join("") || `<tr><td colspan="6" class="muted" style="padding:24px;text-align:center">No watchlist items yet. Sign in and tap "Add stock".</td></tr>`;

  $("#watchlistPane").innerHTML = `
    <div class="section-head">
      <div>
        <h2>Stock Watch List</h2>
        <p>Stocks to consider. Each gives a clear Buy / Wait / Ignore call with a short reason.</p>
      </div>
      <div>
        <button class="btn primary" id="addWatchBtn">+ Add stock</button>
      </div>
    </div>
    ${summary}
    <table class="tbl">
      <thead>
        <tr>
          <th style="width:14%">Ticker</th>
          <th>What it does</th>
          <th class="num" style="width:110px">Price</th>
          <th style="width:90px">Verdict</th>
          <th>Why</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="muted" style="font-size:12px;margin-top:12px">Last updated ${escapeHtml(STATE.watchlist?.as_of || "—")}</p>
  `;
  wireListInteractions("watchlist");
  $("#addWatchBtn").onclick = () => openAddModal("watchlist");
}

// ---- Row interactions (shared by holdings + watchlist) ----
function wireListInteractions(listName) {
  $$(`tr.row[data-list="${listName}"]`).forEach(tr => {
    tr.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      openDetail(listName, tr.dataset.id);
    });
  });
  $$(`button.del-btn[data-list="${listName}"]`).forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!GH.isSignedIn()) { alert("Sign in to delete."); return; }
      const id = btn.dataset.id;
      if (btn.classList.contains("armed")) {
        clearTimeout(btn._t);
        deleteItem(listName, id);
        return;
      }
      $$(".del-btn.armed").forEach(b => { b.classList.remove("armed"); b.textContent = "×"; clearTimeout(b._t); });
      btn.classList.add("armed");
      btn.textContent = "Confirm?";
      btn._t = setTimeout(() => { btn.classList.remove("armed"); btn.textContent = "×"; }, 3000);
    });
  });
}
document.addEventListener("click", (e) => {
  if (e.target.classList && e.target.classList.contains("del-btn")) return;
  $$(".del-btn.armed").forEach(b => { b.classList.remove("armed"); b.textContent = "×"; clearTimeout(b._t); });
}, { capture: true });

function deleteItem(listName, id) {
  if (listName === "holdings") {
    STATE.holdings.holdings = STATE.holdings.holdings.filter(h => h.ticker !== id);
    saveList("holdings", `remove ${id} from holdings`);
  } else {
    STATE.watchlist.stocks = STATE.watchlist.stocks.filter(s => s.ticker !== id);
    saveList("watchlist", `remove ${id} from watchlist`);
  }
  renderActiveTab();
}

function saveList(listName, message) {
  if (!GH.isSignedIn()) return;
  if (listName === "holdings") {
    STATE.holdings.as_of = new Date().toISOString().slice(0, 10);
    GH.saveFile("data/holdings.json", JSON.stringify(STATE.holdings, null, 2), message);
  } else {
    STATE.watchlist.as_of = new Date().toISOString().slice(0, 10);
    GH.saveFile("data/watchlist.json", JSON.stringify(STATE.watchlist, null, 2), message);
  }
}

// ---- Detail modal ----
function openDetail(listName, id) {
  const item = listName === "holdings"
    ? STATE.holdings.holdings.find(h => h.ticker === id)
    : STATE.watchlist.stocks.find(s => s.ticker === id);
  if (!item) return;

  const html = listName === "holdings"
    ? renderHoldingDetail(item)
    : renderWatchDetail(item);

  $("#detailContent").innerHTML = `
    ${html}
    <div class="modal-actions">
      <button class="btn" id="editDetail">Edit</button>
      <button class="btn primary" id="closeDetail">Close</button>
    </div>`;
  $("#detailModal").hidden = false;
  $("#closeDetail").onclick = () => $("#detailModal").hidden = true;
  $("#editDetail").onclick = () => {
    $("#detailModal").hidden = true;
    openEditModal(listName, id);
  };
}

function renderHoldingDetail(h) {
  const why = (h.why_own_it || []).map(b => `<li>${escapeHtml(b)}</li>`).join("");
  return `
    <div class="detail-head">
      <div>
        <h2>${escapeHtml(h.company || h.ticker)} <span class="muted" style="font-size:14px">${escapeHtml(h.ticker)}</span></h2>
        <div class="meta">${verdictDot(h.verdict)} ${escapeHtml(h.verdict || "—")}</div>
      </div>
      <div class="pricewrap">
        <div class="big">${escapeHtml(h.current_price || "—")}</div>
        <div class="meta">YTD ${escapeHtml(h.ytd_change_pct || "—")} · 1Y ${escapeHtml(h["1y_change_pct"] || "—")}</div>
      </div>
    </div>
    <div class="detail-section">
      <h4>What you own</h4>
      <p>${escapeHtml(h.what_it_does || "—")}</p>
    </div>
    <div class="detail-section">
      <h4>Why you own it</h4>
      <ul>${why || "<li>—</li>"}</ul>
    </div>
    <div class="detail-section">
      <h4>How it's doing</h4>
      <p>${escapeHtml(h.this_week_status || "—")}</p>
      <p class="muted" style="font-size:13px">Dividend: ${escapeHtml(h.dividend_yield_pct || "—")}</p>
    </div>
    <div class="detail-section">
      <h4>One thing to watch</h4>
      <p>${escapeHtml(h.one_thing_to_watch || "—")}</p>
    </div>
    ${fmtSourceList(h.sources)}
  `;
}

function renderWatchDetail(s) {
  return `
    <div class="detail-head">
      <div>
        <h2>${escapeHtml(s.company || s.ticker)} <span class="muted" style="font-size:14px">${escapeHtml(s.ticker)}</span></h2>
        <div class="meta">${verdictDot(s.verdict)} ${escapeHtml(s.verdict || "—")}</div>
      </div>
      <div class="pricewrap">
        <div class="big">${escapeHtml(s.price || "—")}</div>
      </div>
    </div>
    <div class="detail-section">
      <h4>What it does</h4>
      <p>${escapeHtml(s.what_it_does || "—")}</p>
    </div>
    <div class="detail-section">
      <h4>Why ${escapeHtml(s.verdict || "consider")}</h4>
      <p>${escapeHtml(s.why || "—")}</p>
    </div>
    <div class="detail-section">
      <h4>Main risk</h4>
      <p>${escapeHtml(s.key_risk || "—")}</p>
    </div>
    ${fmtSourceList(s.sources)}
  `;
}

// ---- Add / Edit modals ----
function openAddModal(listName) {
  if (!GH.isSignedIn()) {
    alert("Sign in to add items.");
    return;
  }
  const blank = listName === "holdings"
    ? { ticker:"", company:"", what_it_does:"", current_price:"", ytd_change_pct:"", "1y_change_pct":"", dividend_yield_pct:"", why_own_it:["","",""], one_thing_to_watch:"", this_week_status:"", verdict:"Healthy", sources:[] }
    : { ticker:"", company:"", what_it_does:"", price:"", verdict:"Wait", why:"", key_risk:"", sources:[] };
  showEditForm(listName, blank, /*isNew*/true);
}

function openEditModal(listName, id) {
  if (!GH.isSignedIn()) {
    alert("Sign in to edit items.");
    return;
  }
  const item = listName === "holdings"
    ? STATE.holdings.holdings.find(h => h.ticker === id)
    : STATE.watchlist.stocks.find(s => s.ticker === id);
  if (!item) return;
  showEditForm(listName, JSON.parse(JSON.stringify(item)), /*isNew*/false);
}

function showEditForm(listName, item, isNew) {
  const verdictOpts = listName === "holdings"
    ? ["Healthy", "Caution", "Concern"]
    : ["Buy", "Wait", "Ignore"];
  const verdictSel = verdictOpts.map(v => `<option ${item.verdict===v?"selected":""}>${v}</option>`).join("");

  const sourcesText = (item.sources || []).map(s => `${s.name}|${s.url}`).join("\n");

  const fields = listName === "holdings" ? `
    <div class="field-row">
      <div><label>Ticker</label><input id="f_ticker" type="text" value="${escapeHtml(item.ticker)}" ${isNew?"":"readonly"} /></div>
      <div><label>Company name</label><input id="f_company" type="text" value="${escapeHtml(item.company)}" /></div>
    </div>
    <div class="field-block"><label>What it is (one plain-English sentence)</label>
      <textarea id="f_what">${escapeHtml(item.what_it_does)}</textarea></div>
    <div class="field-row">
      <div><label>Current price</label><input id="f_price" type="text" value="${escapeHtml(item.current_price)}" placeholder="CHF 87.74 (1 May 2026)" /></div>
      <div><label>Dividend yield</label><input id="f_div" type="text" value="${escapeHtml(item.dividend_yield_pct)}" placeholder="~4.0%" /></div>
    </div>
    <div class="field-row">
      <div><label>YTD change</label><input id="f_ytd" type="text" value="${escapeHtml(item.ytd_change_pct)}" placeholder="+5.2%" /></div>
      <div><label>1-year change</label><input id="f_1y" type="text" value="${escapeHtml(item["1y_change_pct"])}" placeholder="-3.1%" /></div>
    </div>
    <div class="field-block"><label>Why you own it (one bullet per line)</label>
      <textarea id="f_why" placeholder="One reason per line">${escapeHtml((item.why_own_it||[]).join("\n"))}</textarea></div>
    <div class="field-block"><label>One thing to watch</label>
      <textarea id="f_watch">${escapeHtml(item.one_thing_to_watch)}</textarea></div>
    <div class="field-block"><label>This week's status</label>
      <textarea id="f_status">${escapeHtml(item.this_week_status)}</textarea></div>
    <div class="field-block"><label>Verdict</label>
      <select id="f_verdict">${verdictSel}</select></div>
    <div class="field-block"><label>Sources (one per line, format: Name|URL)</label>
      <textarea id="f_sources" placeholder="Reuters|https://reuters.com/...">${escapeHtml(sourcesText)}</textarea></div>
  ` : `
    <div class="field-row">
      <div><label>Ticker</label><input id="f_ticker" type="text" value="${escapeHtml(item.ticker)}" ${isNew?"":"readonly"} /></div>
      <div><label>Company name</label><input id="f_company" type="text" value="${escapeHtml(item.company)}" /></div>
    </div>
    <div class="field-block"><label>What it does (one plain-English sentence)</label>
      <textarea id="f_what">${escapeHtml(item.what_it_does)}</textarea></div>
    <div class="field-row">
      <div><label>Price</label><input id="f_price" type="text" value="${escapeHtml(item.price)}" placeholder="$120.50" /></div>
      <div><label>Verdict</label><select id="f_verdict">${verdictSel}</select></div>
    </div>
    <div class="field-block"><label>Why this verdict (2-3 sentences)</label>
      <textarea id="f_why">${escapeHtml(item.why)}</textarea></div>
    <div class="field-block"><label>Main risk</label>
      <textarea id="f_risk">${escapeHtml(item.key_risk)}</textarea></div>
    <div class="field-block"><label>Sources (one per line, format: Name|URL)</label>
      <textarea id="f_sources" placeholder="Reuters|https://reuters.com/...">${escapeHtml(sourcesText)}</textarea></div>
  `;

  $("#addContent").innerHTML = `
    <h2>${isNew ? "Add" : "Edit"} ${listName === "holdings" ? "holding" : "stock"}</h2>
    ${fields}
    <div class="modal-actions">
      <button class="btn" id="cancelAdd">Cancel</button>
      <button class="btn primary" id="confirmAdd">${isNew ? "Add" : "Save"}</button>
    </div>
  `;
  $("#addModal").hidden = false;
  $("#cancelAdd").onclick = () => $("#addModal").hidden = true;
  $("#confirmAdd").onclick = () => {
    const ticker = $("#f_ticker").value.trim().toUpperCase();
    if (!ticker) { alert("Ticker required"); return; }
    const company = $("#f_company").value.trim();
    const whatVal = $("#f_what").value.trim();
    const verdict = $("#f_verdict").value;
    const sources = $("#f_sources").value.trim().split("\n")
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const [name, url] = line.split("|").map(x => (x||"").trim());
        return name && url ? { name, url } : null;
      })
      .filter(Boolean);

    let updated;
    if (listName === "holdings") {
      updated = {
        ticker, company,
        what_it_does: whatVal,
        current_price: $("#f_price").value.trim(),
        ytd_change_pct: $("#f_ytd").value.trim(),
        "1y_change_pct": $("#f_1y").value.trim(),
        dividend_yield_pct: $("#f_div").value.trim(),
        why_own_it: $("#f_why").value.trim().split("\n").map(s => s.trim()).filter(Boolean),
        one_thing_to_watch: $("#f_watch").value.trim(),
        this_week_status: $("#f_status").value.trim(),
        verdict,
        sources,
      };
      const arr = STATE.holdings.holdings;
      const idx = arr.findIndex(h => h.ticker === ticker);
      if (idx >= 0) arr[idx] = updated; else arr.push(updated);
      saveList("holdings", `${isNew?"add":"edit"} ${ticker} in holdings`);
    } else {
      updated = {
        ticker, company,
        what_it_does: whatVal,
        price: $("#f_price").value.trim(),
        verdict,
        why: $("#f_why").value.trim(),
        key_risk: $("#f_risk").value.trim(),
        sources,
      };
      const arr = STATE.watchlist.stocks;
      const idx = arr.findIndex(s => s.ticker === ticker);
      if (idx >= 0) arr[idx] = updated; else arr.push(updated);
      saveList("watchlist", `${isNew?"add":"edit"} ${ticker} in watchlist`);
    }
    $("#addModal").hidden = true;
    renderActiveTab();
  };
}

// ---- Sign in ----
$("#signInBtn").onclick = () => {
  $("#tokenInput").value = GH.isSignedIn() ? "•••••••• (saved)" : "";
  $("#signOutBtn").hidden = !GH.isSignedIn();
  $("#signInError").hidden = true;
  $("#signInModal").hidden = false;
  setTimeout(() => $("#tokenInput").focus(), 50);
};
$("#cancelSignIn").onclick = () => $("#signInModal").hidden = true;
$("#signOutBtn").onclick = () => {
  GH.clearToken();
  $("#signInModal").hidden = true;
  applyEditMode();
};
$("#confirmSignIn").onclick = async () => {
  const tok = $("#tokenInput").value.trim();
  if (!tok || tok.startsWith("•")) { $("#signInModal").hidden = true; return; }
  GH.setToken(tok);
  try {
    const user = await GH.verify();
    $("#signInModal").hidden = true;
    applyEditMode();
    GH.setStatus("saved", `Signed in as ${user.login}`);
  } catch (e) {
    GH.clearToken();
    $("#signInError").textContent = e.message;
    $("#signInError").hidden = false;
  }
};

// ---- Tab handlers ----
$$(".tab").forEach(t => t.addEventListener("click", () => setActiveTab(t.dataset.tab)));
// Modal close on backdrop click
$$(".modal").forEach(m => m.addEventListener("click", (e) => { if (e.target === m) m.hidden = true; }));

// ---- Init ----
applyEditMode();
loadAll();
