/**
 * CONFLUENCE BACKTEST — Railway service
 * -------------------------------------
 * Finds every coin that BOTH watched wallets bought within the window
 * over the lookback period, then pulls price history for each and scores:
 *   - entry price (at the moment the SECOND wallet bought = your alert moment)
 *   - peak multiple within 24h of entry
 *   - price now vs entry
 *
 * Required env vars:  HELIUS_API_KEY, WATCH_WALLETS (comma-separated, 2 wallets)
 * Optional:           LOOKBACK_DAYS (30), CONFLUENCE_WINDOW_SECONDS (600)
 */

import http from "http";

const CONFIG = {
  HELIUS_API_KEY: process.env.HELIUS_API_KEY || "",
  WATCH_WALLETS: (process.env.WATCH_WALLETS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  LOOKBACK_DAYS: Number(process.env.LOOKBACK_DAYS || 30),
  WINDOW: Number(process.env.CONFLUENCE_WINDOW_SECONDS || 600),
  PORT: Number(process.env.PORT || 3000),
};

const QUOTE_MINTS = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

const state = {
  phase: "idle",
  message: "Waiting to start",
  apiCalls: 0,
  startedAt: null,
  finishedAt: null,
  confluences: [],
  results: [],
  summary: null,
  log: [],
};

function logLine(msg) {
  const line = `${new Date().toISOString().slice(11, 19)}  ${msg}`;
  state.log.push(line);
  if (state.log.length > 200) state.log.shift();
  console.log(line);
}

/* ── HTTP helpers ─────────────────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, attempt = 1) {
  const MAX = 5;
  try {
    state.apiCalls++;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (res.status === 429) {
      if (attempt >= MAX) return null;
      await sleep(2500 * attempt);
      return getJson(url, attempt + 1);
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      if (attempt >= MAX) return null;
      await sleep(800 * attempt);
      return getJson(url, attempt + 1);
    }
    return await res.json();
  } catch {
    if (attempt >= MAX) return null;
    await sleep(800 * attempt);
    return getJson(url, attempt + 1);
  }
}

function txUrl(address, { before, limit = 100 } = {}) {
  const p = new URLSearchParams({ "api-key": CONFIG.HELIUS_API_KEY, limit: String(limit) });
  if (before) p.set("before", before);
  return `https://api.helius.xyz/v0/addresses/${address}/transactions?${p.toString()}`;
}

/* ── buy detection (three paths, as the finder) ───────── */

function extractBuy(tx, wallet) {
  const transfers = tx.tokenTransfers || [];
  const paidNative = (tx.nativeTransfers || []).some(
    (t) => t.fromUserAccount === wallet && Number(t.amount) > 1_000_000
  );
  const paidToken = transfers.some(
    (t) => t.fromUserAccount === wallet && QUOTE_MINTS.has(t.mint)
  );
  const paid = paidNative || paidToken;

  const direct = transfers.find(
    (t) => t.toUserAccount === wallet && t.mint && !QUOTE_MINTS.has(t.mint)
  );
  if (direct && paid) return { mint: direct.mint };

  const swap = tx.events && tx.events.swap;
  if (swap && tx.feePayer === wallet) {
    const outs = (swap.tokenOutputs || []).filter((o) => o.mint && !QUOTE_MINTS.has(o.mint));
    const soldNonQuote = (swap.tokenInputs || []).some((i) => i.mint && !QUOTE_MINTS.has(i.mint));
    if (outs.length && !soldNonQuote) return { mint: outs[0].mint };
  }

  if (tx.feePayer === wallet && paid) {
    const routed = transfers.find(
      (t) => t.mint && !QUOTE_MINTS.has(t.mint) && t.fromUserAccount !== wallet
    );
    if (routed) return { mint: routed.mint };
  }
  return null;
}

async function fetchFirstBuysByMint(wallet, cutoffTs) {
  const firstByMint = new Map();
  let before;
  for (let page = 1; page <= 200; page++) {
    const batch = (await getJson(txUrl(wallet, { before }))) || [];
    if (!batch.length) break;

    let hitCutoff = false;
    for (const tx of batch) {
      if (!tx.timestamp) continue;
      if (tx.timestamp < cutoffTs) { hitCutoff = true; break; }
      const buy = extractBuy(tx, wallet);
      if (buy) {
        const prev = firstByMint.get(buy.mint);
        if (!prev || tx.timestamp < prev) firstByMint.set(buy.mint, tx.timestamp);
      }
    }
    state.message = `Reading ${wallet.slice(0, 4)}… — page ${page}, ${firstByMint.size} tokens`;
    if (hitCutoff) break;
    before = batch[batch.length - 1].signature;
    await sleep(120);
  }
  return firstByMint;
}

/* ── price scoring via GeckoTerminal ──────────────────── */

const GT = "https://api.geckoterminal.com/api/v2";

async function scoreCoin(conf) {
  const { mint, entryTs } = conf;

  const pools = await getJson(`${GT}/networks/solana/tokens/${mint}/pools?page=1`);
  const pool = pools && pools.data && pools.data[0];
  if (!pool) return { ...conf, status: "dead", note: "No pool found — died on the launchpad or rugged" };

  const poolAddr = pool.id.replace(/^solana_/, "");
  const priceNow = Number(pool.attributes.base_token_price_usd) || 0;
  const symbol =
    (pool.attributes.name || "").split("/")[0].trim() || mint.slice(0, 6);

  await sleep(2200); // GeckoTerminal free tier: ~30 calls/min

  const endTs = Math.min(Math.floor(Date.now() / 1000), entryTs + 86400 + 3600);
  const ohlcv = await getJson(
    `${GT}/networks/solana/pools/${poolAddr}/ohlcv/minute?aggregate=5&before_timestamp=${endTs}&limit=300&currency=usd`
  );
  const list =
    (ohlcv && ohlcv.data && ohlcv.data.attributes && ohlcv.data.attributes.ohlcv_list) || [];
  const candles = list
    .map(([ts, o, h, l, c]) => ({ ts: Number(ts), h: Number(h), c: Number(c) }))
    .sort((a, b) => a.ts - b.ts);

  const entryCandle = candles.find((c) => c.ts >= entryTs - 300);
  if (!entryCandle || !entryCandle.c) {
    return {
      ...conf, status: "no-data", symbol, priceNow,
      note: "Pool exists but no candles at entry time (likely still on bonding curve then)",
    };
  }

  const entryPrice = entryCandle.c;
  const after = candles.filter((c) => c.ts >= entryCandle.ts && c.ts <= entryTs + 86400);
  const peak = Math.max(...after.map((c) => c.h), entryPrice);
  const peakX = peak / entryPrice;
  const peakCandle = after.find((c) => c.h === peak);
  const minsToPeak = peakCandle ? Math.round((peakCandle.ts - entryTs) / 60) : 0;
  const nowX = priceNow > 0 ? priceNow / entryPrice : 0;

  return {
    ...conf, status: "scored", symbol, entryPrice,
    peakX: +peakX.toFixed(2), minsToPeak, nowX: +nowX.toFixed(3), priceNow,
  };
}

/* ── the run ──────────────────────────────────────────── */

async function runAnalysis() {
  if (state.phase === "running") return;
  if (!CONFIG.HELIUS_API_KEY) {
    state.phase = "blocked";
    state.message = "Add HELIUS_API_KEY in Railway variables.";
    return;
  }
  if (CONFIG.WATCH_WALLETS.length < 2) {
    state.phase = "blocked";
    state.message = "WATCH_WALLETS needs two comma-separated addresses.";
    return;
  }

  Object.assign(state, {
    phase: "running", message: "Starting", startedAt: Date.now(), finishedAt: null,
    apiCalls: 0, confluences: [], results: [], summary: null, log: [],
  });

  try {
    const cutoffTs = Math.floor(Date.now() / 1000) - CONFIG.LOOKBACK_DAYS * 86400;
    const [wA, wB] = CONFIG.WATCH_WALLETS;

    logLine(`Wallet A: ${wA}`);
    const buysA = await fetchFirstBuysByMint(wA, cutoffTs);
    logLine(`  ${buysA.size} unique tokens`);

    logLine(`Wallet B: ${wB}`);
    const buysB = await fetchFirstBuysByMint(wB, cutoffTs);
    logLine(`  ${buysB.size} unique tokens`);

    const confluences = [];
    for (const [mint, tsA] of buysA) {
      const tsB = buysB.get(mint);
      if (tsB === undefined) continue;
      const gap = Math.abs(tsA - tsB);
      if (gap <= CONFIG.WINDOW) {
        confluences.push({ mint, gap, entryTs: Math.max(tsA, tsB) });
      }
    }
    confluences.sort((a, b) => a.entryTs - b.entryTs);
    state.confluences = confluences;
    logLine(`${confluences.length} confluence coins inside ${CONFIG.WINDOW}s window`);

    const results = [];
    for (const [i, conf] of confluences.entries()) {
      state.message = `Pricing coin ${i + 1}/${confluences.length}`;
      results.push(await scoreCoin(conf));
      await sleep(2200);
    }

    const scored = results.filter((r) => r.status === "scored");
    const deadOrNoData = results.length - scored.length;
    const xs = scored.map((r) => r.peakX).sort((a, b) => a - b);
    const medianPeak = xs.length ? xs[Math.floor(xs.length / 2)] : 0;

    state.results = results.sort((a, b) => (b.peakX || 0) - (a.peakX || 0));
    state.summary = {
      total: results.length,
      scored: scored.length,
      deadOrNoData,
      hit2x: scored.filter((r) => r.peakX >= 2).length,
      hit5x: scored.filter((r) => r.peakX >= 5).length,
      hit10x: scored.filter((r) => r.peakX >= 10).length,
      medianPeak: +medianPeak.toFixed(2),
      stillUpNow: scored.filter((r) => r.nowX >= 1).length,
    };

    state.phase = "done";
    state.finishedAt = Date.now();
    state.message = `${results.length} confluence coins scored`;
    logLine("Finished.");
  } catch (err) {
    state.phase = "error";
    state.message = err.message;
    logLine(`ERROR: ${err.message}`);
  }
}

/* ── page ─────────────────────────────────────────────── */

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

function renderPage() {
  const running = state.phase === "running";
  const s = state.summary;

  const summaryBlock = s
    ? `<div class="cards">
        <div class="card"><b>${s.total}</b><span>confluences</span></div>
        <div class="card"><b>${s.hit2x}/${s.scored}</b><span>hit 2x+</span></div>
        <div class="card"><b>${s.hit5x}</b><span>hit 5x+</span></div>
        <div class="card"><b>${s.hit10x}</b><span>hit 10x+</span></div>
        <div class="card"><b>${s.medianPeak}x</b><span>median peak</span></div>
        <div class="card"><b>${s.deadOrNoData}</b><span>dead / no data</span></div>
       </div>`
    : "";

  const rows = state.results
    .map((r) => {
      if (r.status !== "scored") {
        return `<li class="row dead"><div class="body">
          <div class="addr">${esc(r.symbol || r.mint)}</div>
          <div class="meta">${esc(r.note)}</div>
          <div class="meta mono">${esc(r.mint)}</div>
        </div></li>`;
      }
      const cls = r.peakX >= 5 ? "big" : r.peakX >= 2 ? "good" : "flat";
      return `<li class="row ${cls}"><div class="body">
        <div class="head"><span class="sym">${esc(r.symbol)}</span><span class="x">${r.peakX}x peak</span></div>
        <div class="meta">gap ${r.gap}s · peak after ${r.minsToPeak}m · now ${r.nowX}x vs entry</div>
        <div class="meta mono">${esc(r.mint)}</div>
      </div></li>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Confluence Backtest</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
${running ? '<meta http-equiv="refresh" content="8">' : ""}
<style>
  :root{--ground:#12151F;--panel:#1A1F2E;--edge:#2A3145;--amber:#E8A33D;--cyan:#4DD0C7;--slate:#6B7489;--clay:#C4574A;--ink:#E4E7EF}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--ground);color:var(--ink);font-family:'IBM Plex Mono',monospace;font-size:13px;line-height:1.5;padding:20px 16px 60px}
  h1{font-family:'Space Grotesk',sans-serif;font-size:24px;margin-bottom:10px}
  h1 em{font-style:normal;color:var(--amber)}
  .status{padding:12px 14px;background:var(--panel);border-left:2px solid var(--amber);font-size:13px;margin-bottom:18px}
  .status .sub{color:var(--slate);font-size:11.5px;margin-top:4px}
  .cards{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px}
  .card{background:var(--panel);border:1px solid var(--edge);padding:10px 12px;min-width:96px;flex:1}
  .card b{font-size:17px;display:block}
  .card span{color:var(--slate);font-size:10px;text-transform:uppercase;letter-spacing:.08em}
  ul{list-style:none}
  .row{background:var(--panel);border:1px solid var(--edge);border-left:2px solid var(--slate);padding:12px;margin-bottom:8px}
  .row.big{border-left-color:var(--cyan)}
  .row.good{border-left-color:var(--amber)}
  .row.dead{opacity:.5;border-left-color:var(--clay)}
  .head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px}
  .sym{font-weight:600}
  .x{font-family:'Space Grotesk',sans-serif;font-size:16px;font-weight:700;color:var(--cyan)}
  .row.good .x{color:var(--amber)}
  .row.flat .x{color:var(--slate)}
  .meta{color:var(--slate);font-size:11px;margin-top:2px}
  .mono{word-break:break-all;font-size:10px}
  .note{margin-top:22px;color:var(--slate);font-size:11.5px;border-top:1px solid var(--edge);padding-top:14px}
</style></head><body>
  <h1>Confluence <em>backtest</em></h1>
  <div class="status">
    <div>${esc(state.message)}</div>
    <div class="sub">${CONFIG.LOOKBACK_DAYS}d lookback · ${CONFIG.WINDOW}s window · ${state.apiCalls} API calls</div>
  </div>
  ${summaryBlock}
  ${rows ? `<ul>${rows}</ul>` : ""}
  <div class="note">
    Peak x is the absolute top tick within 24h of the second bot's buy — a ceiling,
    not a realistic exit. "Now" shows what holding to today would look like.
    Dead / no-data coins should be counted as losses when judging the strategy.
  </div>
</body></html>`;
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200); return res.end("ok"); }
  if (req.url === "/run") {
    if (state.phase !== "running") runAnalysis();
    res.writeHead(302, { Location: "/" });
    return res.end();
  }
  if (req.url === "/results.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ summary: state.summary, results: state.results }, null, 2));
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(renderPage());
});

server.listen(CONFIG.PORT, () => {
  logLine(`Backtest service up on ${CONFIG.PORT}`);
  runAnalysis();
});
