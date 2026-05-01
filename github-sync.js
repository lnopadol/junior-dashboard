// GitHub sync — commits dashboard changes directly to the repo via the GitHub Contents API.
// The personal access token is stored only in this browser's localStorage.
//
// Required token scopes: classic PAT with `repo`, OR fine-grained PAT with
// "Contents: Read and write" on the lnopadol/junior-dashboard repo.
//
// Sync model: per-file full-replace. When a file's data changes locally, we queue a save
// for that path. On flush we fetch the latest remote SHA, PUT the new content with that SHA.
// Conflicts retry with exponential backoff. Multi-device safe enough for low edit volume.

const GH = {
  owner: "lnopadol",
  repo: "junior-dashboard",
  branch: "main",
  STORAGE_KEY: "junior_gh_token",
  SAVE_DELAY_MS: 1500,
  REFRESH_INTERVAL_MS: 60000,
};

GH.getToken = () => localStorage.getItem(GH.STORAGE_KEY) || null;
GH.setToken = (t) => localStorage.setItem(GH.STORAGE_KEY, t);
GH.clearToken = () => localStorage.removeItem(GH.STORAGE_KEY);
GH.isSignedIn = () => !!GH.getToken();

GH.headers = () => ({
  "Authorization": `Bearer ${GH.getToken()}`,
  "Accept": "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
});

// Fetch with a hard timeout so the UI never hangs forever on a stalled request.
GH.fetchT = async (url, opts = {}, timeoutMs = 10000) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
};

GH.verify = async () => {
  console.log("[GH.verify] start");
  let res;
  try {
    res = await GH.fetchT("https://api.github.com/repos/" + GH.owner + "/" + GH.repo, { headers: GH.headers() });
  } catch (e) {
    console.error("[GH.verify] network error", e);
    throw new Error("Network error reaching GitHub. Check your internet connection.");
  }
  console.log("[GH.verify] repo status", res.status);
  if (res.status === 401) throw new Error("Token is invalid or expired (401). Generate a new one.");
  if (res.status === 403) throw new Error("Token rejected (403). Fine-grained tokens may need to be approved by the repo owner.");
  if (res.status === 404) throw new Error("Repo not found (404). Token may not have access to lnopadol/junior-dashboard. For fine-grained tokens, make sure you selected this repo under 'Repository access'.");
  if (!res.ok) throw new Error("GitHub error " + res.status + ". Check your token permissions.");
  const repoData = await res.json();
  // Fine-grained tokens with Contents:write set permissions.push:true. Same for classic 'repo' scope.
  if (!repoData.permissions || !repoData.permissions.push) {
    throw new Error("Token can read but not write. Add 'Contents: Read and write' (fine-grained) or 'repo' scope (classic).");
  }
  // Also need Actions:write for the Refresh button to dispatch workflows. Probe by trying a HEAD.
  // (We don't fail sign-in on this — Refresh button will surface its own error if Actions perm is missing.)
  let login = "unknown";
  try {
    const userRes = await GH.fetchT("https://api.github.com/user", { headers: GH.headers() });
    if (userRes.ok) {
      const u = await userRes.json();
      login = u.login || "unknown";
    }
  } catch (_) { /* ignore — /user requires extra scope on fine-grained tokens */ }
  console.log("[GH.verify] success, login=", login);
  return { login };
};

GH.fromB64 = (b64) => {
  const bin = atob(b64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
};

GH.b64 = (str) => {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
};

GH.getFile = async (path) => {
  const url = `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${path}?ref=${GH.branch}&t=${Date.now()}`;
  const res = await fetch(url, { headers: GH.headers(), cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getFile ${path} failed: ${res.status}`);
  const data = await res.json();
  return { sha: data.sha, content: GH.fromB64(data.content) };
};

GH.sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- Per-path save queue ----
// pendingByPath[path] = { content, message }
const pendingByPath = {};
let saveTimer = null;
let isFlushing = false;
let rerunAfterFlush = false;

GH.saveFile = (path, contentString, message) => {
  if (!GH.isSignedIn()) return;
  pendingByPath[path] = { content: contentString, message };
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(GH.flush, GH.SAVE_DELAY_MS);
  GH.setStatus("pending");
};

GH.commitOne = async (path, contentString, message, attempt = 1) => {
  const MAX = 5;
  const existing = await GH.getFile(path);
  const url = `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${path}`;
  const body = {
    message: message || `Update ${path}`,
    content: GH.b64(contentString),
    branch: GH.branch,
  };
  if (existing) body.sha = existing.sha;
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...GH.headers(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) return res.json();

  const retryable = [409, 422, 500, 502, 503, 504].includes(res.status);
  if (retryable && attempt < MAX) {
    const delay = Math.min(2000, 200 * Math.pow(2, attempt));
    console.warn(`commit ${path} got ${res.status}, retrying in ${delay}ms`);
    await GH.sleep(delay);
    return GH.commitOne(path, contentString, message, attempt + 1);
  }
  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
    throw new Error("Rate limited. Try again in a minute.");
  }
  const errText = await res.text();
  throw new Error(`Commit ${path} failed (${res.status}): ${errText.slice(0, 200)}`);
};

GH.flush = async () => {
  if (isFlushing) { rerunAfterFlush = true; return; }
  const paths = Object.keys(pendingByPath);
  if (paths.length === 0) return;
  isFlushing = true;
  GH.setStatus("saving");
  try {
    for (const path of paths) {
      const { content, message } = pendingByPath[path];
      await GH.commitOne(path, content, message);
      delete pendingByPath[path];
    }
    GH.setStatus("saved");
  } catch (e) {
    console.error(e);
    GH.setStatus("error", e.message);
    if (!/rate limit/i.test(e.message)) {
      setTimeout(() => { if (Object.keys(pendingByPath).length > 0) GH.flush(); }, 5000);
    }
  } finally {
    isFlushing = false;
    if (rerunAfterFlush) {
      rerunAfterFlush = false;
      setTimeout(GH.flush, 100);
    }
  }
};

// ---- Refresh trigger (calls GitHub Actions repository_dispatch) ----
GH.triggerRefresh = async () => {
  if (!GH.isSignedIn()) throw new Error("Sign in first");
  const url = `https://api.github.com/repos/${GH.owner}/${GH.repo}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...GH.headers(), "Content-Type": "application/json" },
    body: JSON.stringify({ event_type: "refresh-dashboard" }),
  });
  if (res.status === 204) return true;
  const errText = await res.text();
  throw new Error(`Refresh trigger failed (${res.status}): ${errText.slice(0, 200)}`);
};

// Polls Actions API for latest run, returns { status, conclusion, html_url } or null.
GH.getLatestActionRun = async () => {
  const url = `https://api.github.com/repos/${GH.owner}/${GH.repo}/actions/runs?per_page=1&t=${Date.now()}`;
  const res = await fetch(url, { headers: GH.headers(), cache: "no-store" });
  if (!res.ok) throw new Error(`getLatestActionRun failed: ${res.status}`);
  const js = await res.json();
  return js.workflow_runs && js.workflow_runs[0] ? js.workflow_runs[0] : null;
};

GH.setStatus = (state, msg = "") => {
  const el = document.getElementById("syncStatus");
  if (!el) return;
  const labels = {
    "signed-out": "🔒 Read-only",
    "pending": "● Unsaved",
    "saving": "⟳ Saving…",
    "saved": "✓ Synced",
    "error": "⚠ " + (msg || "Sync error"),
  };
  el.className = `sync-status sync-${state}`;
  el.textContent = labels[state] || state;
  el.title = msg || "";
};

// Flush before unload if anything pending
window.addEventListener("beforeunload", (e) => {
  if (Object.keys(pendingByPath).length > 0) {
    GH.flush();
    e.preventDefault();
    e.returnValue = "";
  }
});
