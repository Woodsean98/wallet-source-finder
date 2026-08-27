/**
 * WALLET SOURCE FINDER — Railway service
 * --------------------------------------
 * Runs the source-wallet analysis once on boot, then serves the results
 * as a mobile page so you can read them on a phone instead of in deploy logs.
 *
 * Deploy as its OWN Railway service. Do not merge into the Narrative Sniper
 * worker — this would re-run the full analysis on every restart of that worker.
 *
 * Required env vars:  HELIUS_API_KEY, TARGET_WALLETS
 */

import http from "http";

/* ────────────────────────────────────────────────────────────────
   CONFIG — all from Railway environment variables
   ──────────────────────────────────────────────────────────────── */

const CONFIG = {
  HELIUS_API_KEY: process.env.HELIUS_API_KEY || "",
  TARGET_WALLETS: (process.env.TARGET_WALLETS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  LOOKBACK_DAYS: Number(process.env.LOOKBACK_DAYS || 30),
  WINDOW_SECONDS: Number(process.env.WINDOW_SECONDS || 90),
  MAX_BUYS_PER_WALLET: Number(process.env.MAX_BUYS_PER_WALLET || 300),
  MIN_HITS: Number(process.env.MIN_HITS || 3),
  CONCURRENCY: Number(process.env.CONCURRENCY || 5),
  AUTORUN: process.env.AUTORUN !== "false",
  PORT: Number(process.env.PORT || 3000),
};

const DENYLIST = new Set([
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS",
  "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
]);

const QUOTE_MINTS = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

/* ────────────────────────────────────────────────────────────────
   Shared run state — read by the web page
   ──────────────────────────────────────────────────────────────── */

const state = {
  phase: "idle",
  message: "Waiting to start",
  currentTarget: null,
  targetIndex: 0,
  targetCount: 0,
  progressDone: 0,
  progressTotal: 0,
  apiCalls: 0,
  buysAnalysed: 0,
  startedAt: null,
  finishedAt: null,
  results: [],
  error: null,
  log: [],
};

function logLine(msg) {
  const line = `${new Date().toISOString().slice(11, 19)}  ${msg}`;
  state.log.push(line);
  if (state.log.length > 200) state.log.shift();
  console.log(line);
}

/* ────────────────────────────────────────────────────────────────
   HTTP layer
   ──────────────────────────────────────────────────────────────── */

const BASE = "https://api.helius.xyz/v0";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function heliusGet(url, attempt = 1) {
  const MAX_ATTEMPTS = 5;
  try {
    state.apiCalls++;
    const res = await fetch(url);

    if (res.status === 429) {
      if (attempt >= MAX_ATTEMPTS) return [];
      await sleep(1000 * attempt);
      return heliusGet(url, attempt + 1);
    }
    if (res.status === 404) return [];
    if (res.status === 401) {
      throw new Error("Helius rejected the API key (401). Check HELIUS_API_KEY.");
    }
    if (!res.ok) {
      if (attempt >= MAX_ATTEMPTS) return [];
      await sleep(600 * attempt);
      return heliusGet(url, attempt + 1);
    }

    const json = await res.json();
    return Array.isArray(json) ? json : [];
  } catch (err) {
    if (err.message.includes("401")) throw err;
    if (attempt >= MAX_ATTEMPTS) return [];
    await sleep(600 * attempt);
    return heliusGet(url, attempt + 1);
  }
}

function txUrl(address, { before, limit = 100 } = {}) {
  const params = new URLSearchParams({
    "api-key": CONFIG.HELIUS_API_KEY,
    limit: String(limit),
  });
  if (before) params.set("before", before);
  return `${BASE}/addresses/${address}/transactions?${params.toString()}`;
}

async function mapLimit(items, limit, fn) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

/* ────────────────────────────────────────────────────────────────
   Buy detection
   ──────────────────────────────────────────────────────────────── */

function extractBuy(tx, wallet) {
  const transfers = tx.tokenTransfers || [];
  if (!transfers.length) return null;

  const received = transfers.find(
    (t) => t.toUserAccount === wallet && t.mint && !QUOTE_MINTS.has(t.mint)
  );
  if (!received) return null;

  const paidToken = transfers.some(
    (t) => t.fromUserAccount === wallet && QUOTE_MINTS.has(t.mint)
  );
  const paidNative = (tx.nativeTransfers || []).some(
    (t) => t.fromUserAccount === wallet && Number(t.amount) > 1_000_000
  );
  if (!paidToken && !paidNative) return null;

  return { mint: received.mint, timestamp: tx.timestamp, signature: tx.signature };
}

function extractBuyersOfMint(tx, mint) {
  const buyers = new Set();
  for (const t of tx.tokenTransfers || []) {
    if (t.mint !== mint) continue;
    if (!t.toUserAccount || DENYLIST.has(t.toUserAccount)) continue;
    buyers.add(t.toUserAccount);
  }
  if (tx.feePayer && !DENYLIST.has(tx.feePayer) && buyers.size) buyers.add(tx.feePayer);
  return [...buyers];
}

async function fetchWalletBuys(wallet, cutoffTs) {
  const buys = [];
  let before;
  for (let page = 1; page <= 200; page++) {
    const batch = await heliusGet(txUrl(wallet, { before }));
    if (!batch.length) break;

    let hitCutoff = false;
    for (const tx of batch) {
      if (!tx.timestamp) continue;
      if (tx.timestamp < cutoffTs) { hitCutoff = true; break; }
      const buy = extractBuy(tx, wallet);
      if (buy) buys.push(buy);
    }

    state.message = `Reading history — page ${page}, ${buys.length} buys found`;
    if (hitCutoff) break;
    before = batch[batch.length - 1].signature;
    await sleep(120);
  }
  return buys;
}

async function fetchPrecedingBuyers(buy) {
  const windowStart = buy.timestamp - CONFIG.WINDOW_SECONDS;
  const found = new Map();
  let before = buy.signature;

  for (let page = 0; page < 5; page++) {
    const batch = await heliusGet(txUrl(buy.mint, { before, limit: 100 }));
    if (!batch.length) break;

    let past = false;
    for (const tx of batch) {
      if (!tx.timestamp || tx.timestamp >= buy.timestamp) continue;
      if (tx.timestamp < windowStart) { past = true; break; }
      const lead = buy.timestamp - tx.timestamp;
      for (const b of extractBuyersOfMint(tx, buy.mint)) {
        if (!found.has(b) || found.get(b) > lead) found.set(b, lead);
      }
    }
    if (past) break;
    before = batch[batch.length - 1].signature;
  }
  return found;
}

function sample(buys, max) {
  if (buys.length <= max) return buys;
  const step = buys.length / max;
  return Array.from({ length: max }, (_, i) => buys[Math.floor(i * step)]);
}

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/* ────────────────────────────────────────────────────────────────
   The run
   ──────────────────────────────────────────────────────────────── */

async function runAnalysis() {
  if (state.phase === "running") return;

  if (!CONFIG.HELIUS_API_KEY) {
    state.phase = "blocked";
    state.message = "No Helius API key. Add HELIUS_API_KEY in Railway variables, then redeploy.";
    return;
  }
  if (!CONFIG.TARGET_WALLETS.length) {
    state.phase = "blocked";
    state.message = "No wallets set. Add TARGET_WALLETS in Railway variables as a comma-separated list.";
    return;
  }

  Object.assign(state, {
    phase: "running",
    message: "Starting",
    startedAt: Date.now(),
    finishedAt: null,
    results: [],
    error: null,
    apiCalls: 0,
    buysAnalysed: 0,
    targetCount: CONFIG.TARGET_WALLETS.length,
    log: [],
  });

  try {
    const cutoffTs = Math.floor(Date.now() / 1000) - CONFIG.LOOKBACK_DAYS * 86400;
    const targetSet = new Set(CONFIG.TARGET_WALLETS);
    const tally = new Map();
    let totalAnalysed = 0;

    for (const [idx, wallet] of CONFIG.TARGET_WALLETS.entries()) {
      state.currentTarget = wallet;
      state.targetIndex = idx + 1;
      logLine(`Target ${idx + 1}/${CONFIG.TARGET_WALLETS.length}: ${wallet}`);

      const allBuys = await fetchWalletBuys(wallet, cutoffTs);
      if (!allBuys.length) {
        logLine(`  no buys found — check the address`);
        continue;
      }

      const firstByMint = new Map();
      for (const b of [...allBuys].sort((a, c) => a.timestamp - c.timestamp)) {
        if (!firstByMint.has(b.mint)) firstByMint.set(b.mint, b);
      }

      const buys = sample([...firstByMint.values()], CONFIG.MAX_BUYS_PER_WALLET);
      logLine(`  ${firstByMint.size} unique tokens, analysing ${buys.length}`);

      state.progressDone = 0;
      state.progressTotal = buys.length;

      await mapLimit(buys, CONFIG.CONCURRENCY, async (buy) => {
        const preceding = await fetchPrecedingBuyers(buy);
        for (const [addr, lead] of preceding) {
          if (targetSet.has(addr) || DENYLIST.has(addr)) continue;
          if (!tally.has(addr)) {
            tally.set(addr, { hits: 0, leads: [], mints: new Set(), perTarget: new Map() });
          }
          const rec = tally.get(addr);
          rec.hits++;
          rec.leads.push(lead);
          rec.mints.add(buy.mint);
          rec.perTarget.set(wallet, (rec.perTarget.get(wallet) || 0) + 1);
        }
        state.progressDone++;
        state.message = `Cross-referencing ${state.progressDone}/${buys.length}`;
      });

      totalAnalysed += buys.length;
      state.buysAnalysed = totalAnalysed;
      logLine(`  done — ${buys.length} buys cross-referenced`);
    }

    const ranked = [...tally.entries()]
      .filter(([, r]) => r.hits >= CONFIG.MIN_HITS)
      .map(([address, r]) => {
        const medLead = median(r.leads);
        const targetsSeen = r.perTarget.size;
        const likelyBot = medLead <= 3 && r.hits > totalAnalysed * 0.25;
        return {
          address,
          hits: r.hits,
          pct: +((r.hits / Math.max(totalAnalysed, 1)) * 100).toFixed(1),
          medianLeadSec: medLead,
          uniqueTokens: r.mints.size,
          targetsPreceded: targetsSeen,
          classification: likelyBot ? "bot" : targetsSeen > 1 ? "strong" : "candidate",
          perTarget: Object.fromEntries(r.perTarget),
        };
      })
      .sort((a, b) => b.targetsPreceded - a.targetsPreceded || b.hits - a.hits);

    state.results = ranked;
    state.phase = "done";
    state.finishedAt = Date.now();
    state.message = ranked.length
      ? `${ranked.length} candidates found`
      : "No wallet met the threshold";
    logLine(`Finished. ${ranked.length} candidates, ${state.apiCalls} API calls.`);
  } catch (err) {
    state.phase = "error";
    state.error = err.message;
    state.message = err.message;
    logLine(`ERROR: ${err.message}`);
  }
}

/* ────────────────────────────────────────────────────────────────
   Results page
   ──────────────────────────────────────────────────────────────── */

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

function renderPage() {
  const { phase, message, results } = state;
  const running = phase === "running";
  const elapsed = state.startedAt
    ? Math.round(((state.finishedAt || Date.now()) - state.startedAt) / 1000)
    : 0;

  const maxLead = Math.max(CONFIG.WINDOW_SECONDS, ...results.map((r) => r.medianLeadSec), 1);

  const rows = results
    .map((r, i) => {
      const width = Math.max(2, (r.medianLeadSec / maxLead) * 100);
      const cls = r.classification;
      const label =
        cls === "bot" ? "Likely bot"
        : cls === "strong" ? `Precedes ${r.targetsPreceded} targets`
        : "Candidate";
      return `
      <li class="row ${cls}">
        <div class="rank">${String(i + 1).padStart(2, "0")}</div>
        <div class="body">
          <div class="addr">${esc(r.address)}</div>
          <div class="trace">
            <div class="bar" style="width:${width.toFixed(1)}%"></div>
            <span class="lead">${r.medianLeadSec}s ahead</span>
          </div>
          <div class="meta">
            <span><b>${r.hits}</b> hits</span>
            <span><b>${r.pct}%</b> of buys</span>
            <span><b>${r.uniqueTokens}</b> tokens</span>
          </div>
          <div class="tag ${cls}">${label}</div>
        </div>
      </li>`;
    })
    .join("");

  const empty =
    phase === "done" && !results.length
      ? `<div class="empty">
           <h3>Nothing crossed the threshold</h3>
           <p>That is a real answer, not a failure. Your target may not be copy-trading.
              Try raising LOOKBACK_DAYS or lowering MIN_HITS before you conclude either way.</p>
         </div>`
      : "";

  const blocked =
    phase === "blocked" || phase === "error"
      ? `<div class="empty alarm"><h3>Can't run</h3><p>${esc(message)}</p></div>`
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Source Finder</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
${running ? '<meta http-equiv="refresh" content="6">' : ""}
<style>
  :root{
    --ground:#12151F;
    --panel:#1A1F2E;
    --edge:#2A3145;
    --amber:#E8A33D;
    --cyan:#4DD0C7;
    --slate:#6B7489;
    --clay:#C4574A;
    --ink:#E4E7EF;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{
    background:var(--ground);color:var(--ink);
    font-family:'IBM Plex Mono',ui-monospace,monospace;
    font-size:14px;line-height:1.5;
    padding:20px 16px 60px;
    -webkit-font-smoothing:antialiased;
  }
  header{border-bottom:1px solid var(--edge);padding-bottom:18px;margin-bottom:22px}
  .eyebrow{
    font-size:11px;letter-spacing:.22em;text-transform:uppercase;
    color:var(--slate);margin-bottom:8px;
  }
  h1{
    font-family:'Space Grotesk',sans-serif;
    font-size:27px;font-weight:700;letter-spacing:-.02em;line-height:1.1;
  }
  h1 em{font-style:normal;color:var(--amber)}
  .status{
    margin-top:14px;padding:12px 14px;
    background:var(--panel);border-left:2px solid var(--amber);
    font-size:13px;
  }
  .status.live{border-left-color:var(--cyan)}
  .status .msg{color:var(--ink)}
  .status .sub{color:var(--slate);font-size:11.5px;margin-top:5px}
  .pulse{
    display:inline-block;width:7px;height:7px;border-radius:50%;
    background:var(--cyan);margin-right:7px;vertical-align:middle;
    animation:pulse 1.4s ease-in-out infinite;
  }
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}
  @media (prefers-reduced-motion:reduce){.pulse{animation:none}}

  .legend{
    font-size:11px;color:var(--slate);margin:20px 0 10px;
    display:flex;gap:14px;flex-wrap:wrap;
  }
  .legend span::before{
    content:"";display:inline-block;width:8px;height:2px;
    margin-right:5px;vertical-align:middle;
  }
  .legend .l-strong::before{background:var(--cyan)}
  .legend .l-cand::before{background:var(--amber)}
  .legend .l-bot::before{background:var(--clay)}

  ul{list-style:none}
  .row{
    display:flex;gap:12px;
    background:var(--panel);border:1px solid var(--edge);
    padding:14px;margin-bottom:10px;
  }
  .row.strong{border-left:2px solid var(--cyan)}
  .row.candidate{border-left:2px solid var(--amber)}
  .row.bot{border-left:2px solid var(--clay);opacity:.55}
  .rank{
    font-size:11px;color:var(--slate);padding-top:2px;
    font-variant-numeric:tabular-nums;
  }
  .body{flex:1;min-width:0}
  .addr{
    font-size:12px;word-break:break-all;color:var(--ink);
    font-weight:500;margin-bottom:10px;
  }
  .trace{
    position:relative;height:20px;
    border-right:1px solid var(--slate);
    margin-bottom:9px;display:flex;align-items:center;
  }
  .bar{height:3px;background:var(--amber)}
  .row.strong .bar{background:var(--cyan)}
  .row.bot .bar{background:var(--clay)}
  .lead{
    font-size:10.5px;color:var(--slate);margin-left:8px;white-space:nowrap;
  }
  .meta{
    display:flex;gap:14px;font-size:11px;color:var(--slate);
    flex-wrap:wrap;margin-bottom:8px;
  }
  .meta b{color:var(--ink);font-weight:600}
  .tag{
    display:inline-block;font-size:10px;letter-spacing:.1em;
    text-transform:uppercase;padding:3px 7px;
  }
  .tag.strong{background:rgba(77,208,199,.13);color:var(--cyan)}
  .tag.candidate{background:rgba(232,163,61,.13);color:var(--amber)}
  .tag.bot{background:rgba(196,87,74,.13);color:var(--clay)}

  .empty{
    background:var(--panel);border:1px solid var(--edge);
    padding:20px;margin-top:8px;
  }
  .empty.alarm{border-color:var(--clay)}
  .empty h3{
    font-family:'Space Grotesk',sans-serif;font-size:16px;
    margin-bottom:8px;color:var(--amber);
  }
  .empty.alarm h3{color:var(--clay)}
  .empty p{color:var(--slate);font-size:12.5px}

  .actions{margin-top:26px;display:flex;gap:10px;flex-wrap:wrap}
  a.btn,button.btn{
    font-family:inherit;font-size:12px;letter-spacing:.05em;
    background:transparent;color:var(--ink);
    border:1px solid var(--edge);padding:10px 15px;
    text-decoration:none;cursor:pointer;
  }
  a.btn:hover,button.btn:hover{border-color:var(--amber);color:var(--amber)}
  a.btn:focus-visible,button.btn:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}

  .guide{
    margin-top:30px;padding-top:18px;border-top:1px solid var(--edge);
    font-size:11.5px;color:var(--slate);
  }
  .guide h4{
    font-family:'Space Grotesk',sans-serif;color:var(--ink);
    font-size:12px;margin-bottom:9px;letter-spacing:.04em;
  }
  .guide li{margin-bottom:6px;padding-left:14px;position:relative;list-style:none}
  .guide li::before{content:"·";position:absolute;left:3px;color:var(--amber)}
</style>
</head>
<body>
  <header>
    <div class="eyebrow">On-chain attribution</div>
    <h1>Who moves <em>before</em> your targets</h1>
    <div class="status ${running ? "live" : ""}">
      <div class="msg">${running ? '<span class="pulse"></span>' : ""}${esc(message)}</div>
      <div class="sub">
        ${state.targetCount} target${state.targetCount === 1 ? "" : "s"} ·
        ${CONFIG.LOOKBACK_DAYS}d lookback ·
        ${CONFIG.WINDOW_SECONDS}s window ·
        ${state.apiCalls} API calls ·
        ${elapsed}s elapsed
      </div>
    </div>
  </header>

  ${blocked}
  ${empty}

  ${results.length ? `
  <div class="legend">
    <span class="l-strong">Precedes multiple targets</span>
    <span class="l-cand">Single-target candidate</span>
    <span class="l-bot">Likely bot</span>
  </div>
  <ul>${rows}</ul>` : ""}

  <div class="actions">
    <a class="btn" href="/results.json">Download JSON</a>
    <a class="btn" href="/results.csv">Download CSV</a>
    ${!running ? '<a class="btn" href="/run">Run again</a>' : ""}
  </div>

  <div class="guide">
    <h4>Reading the trace</h4>
    <ul>
      <li>The bar shows how far ahead of your target that wallet bought. The right edge is the moment your target bought.</li>
      <li>A long bar with a high hit rate is what you're hunting — 5 to 90 seconds ahead, appearing on 20%+ of buys.</li>
      <li>A stub bar at near-zero with a huge hit rate is a sniper bot front-running everyone. Not a source.</li>
      <li>Preceding more than one of your targets is the strongest signal here. Start at the top.</li>
      <li>Check any candidate on Solscan before you follow it. This finds correlation, not proof.</li>
    </ul>
  </div>
</body>
</html>`;
}

function toCsv() {
  const head = "address,hits,pct,median_lead_sec,unique_tokens,targets_preceded,classification";
  const body = state.results.map((r) =>
    [r.address, r.hits, r.pct, r.medianLeadSec, r.uniqueTokens, r.targetsPreceded, r.classification].join(",")
  );
  return [head, ...body].join("\n");
}

/* ────────────────────────────────────────────────────────────────
   Server
   ──────────────────────────────────────────────────────────────── */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/results.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ phase: state.phase, results: state.results }, null, 2));
  }

  if (url.pathname === "/results.csv") {
    res.writeHead(200, {
      "Content-Type": "text/csv",
      "Content-Disposition": 'attachment; filename="source-wallets.csv"',
    });
    return res.end(toCsv());
  }

  if (url.pathname === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      phase: state.phase, message: state.message,
      done: state.progressDone, total: state.progressTotal,
      apiCalls: state.apiCalls, candidates: state.results.length,
    }));
  }

  if (url.pathname === "/run") {
    if (state.phase !== "running") runAnalysis();
    res.writeHead(302, { Location: "/" });
    return res.end();
  }

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(renderPage());
});

server.listen(CONFIG.PORT, () => {
  logLine(`Server up on port ${CONFIG.PORT}`);
  if (CONFIG.AUTORUN) {
    logLine("Autorun enabled — starting analysis");
    runAnalysis();
  } else {
    state.message = "Autorun off. Open /run to start.";
  }
});
