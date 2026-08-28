/**
 * CONFLUENCE PAPER TRADER — Railway service (v2)
 * ----------------------------------------------
 * v2 fix: exits with no price data no longer book as total losses.
 * They enter a "settling" state, retry pricing for 5 minutes, and
 * only then either book at the found price or get flagged UNPRICED
 * and excluded from P&L.
 *
 * Required env vars:
 *   WATCH_WALLETS              comma-separated wallet addresses (2)
 * Optional:
 *   POSITION_SOL               default 0.3
 *   SLIPPAGE_PCT               default 3 (applied on both entry and exit)
 *   MAX_HOLD_MIN               default 60
 *   CONFLUENCE_WINDOW_SECONDS  default 600
 *   SOL_GBP                    default 80 (for the £ column)
 *   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID   for alerts
 *   WEBHOOK_SECRET             if set, Helius must send it as Authorization
 */

import http from "http";

const CONFIG = {
  WATCH_WALLETS: (process.env.WATCH_WALLETS || "")
    .split(",").map((s) => s.trim()).filter(Boolean),
  WINDOW: Number(process.env.CONFLUENCE_WINDOW_SECONDS || 600),
  POSITION_SOL: Number(process.env.POSITION_SOL || 0.3),
  SLIPPAGE: Number(process.env.SLIPPAGE_PCT || 3) / 100,
  MAX_HOLD_MIN: Number(process.env.MAX_HOLD_MIN || 60),
  SOL_GBP: Number(process.env.SOL_GBP || 80),
  TG_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  TG_CHAT: process.env.TELEGRAM_CHAT_ID || "",
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || "",
  PORT: Number(process.env.PORT || 3000),
  SETTLE_TRIES: 10,        // price retries before giving up
  SETTLE_INTERVAL_MS: 30_000,
};

const QUOTE_MINTS = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

/* ── state ──────────────────────────────────────────────── */

const buysByMint = new Map();     // mint -> Map(wallet -> ts)
const alerted = new Set();        // mints already traded/alerted
const openPositions = new Map();  // mint -> position
const settling = new Map();       // mint -> { pos, reason, tries, startedAt }
const closedTrades = [];          // newest last
const recentBuys = [];
let webhookHits = 0;

const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const now = () => Math.floor(Date.now() / 1000);

/* ── helpers ────────────────────────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function priceFromDexscreener(mint) {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
  if (!res.ok) throw new Error(`dexscreener ${res.status}`);
  const j = await res.json();
  const pairs = (j.pairs || []).filter((p) => p.chainId === "solana");
  if (!pairs.length) return null;
  pairs.sort((a, b) => (Number(b.liquidity?.usd) || 0) - (Number(a.liquidity?.usd) || 0));
  const px = Number(pairs[0].priceNative);
  return px > 0 ? px : null;
}

async function priceFromGecko(mint) {
  const res = await fetch(
    `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools?page=1`
  );
  if (!res.ok) throw new Error(`gecko ${res.status}`);
  const j = await res.json();
  const pools = j.data || [];
  if (!pools.length) return null;
  const best = pools[0];
  const usd = Number(best.attributes?.base_token_price_usd);
  const usdPerSol = Number(best.attributes?.base_token_price_quote_token)
    ? usd / Number(best.attributes.base_token_price_quote_token)
    : null;
  if (usd > 0 && usdPerSol > 0) return usd / usdPerSol;
  const quote = Number(best.attributes?.base_token_price_quote_token);
  return quote > 0 ? quote : null;
}

async function fetchPriceSol(mint) {
  try { const p = await priceFromDexscreener(mint); if (p) return p; } catch {}
  await sleep(400);
  try { const p = await priceFromGecko(mint); if (p) return p; } catch {}
  return null;
}

async function sendTelegram(text) {
  if (!CONFIG.TG_TOKEN || !CONFIG.TG_CHAT) { console.log("TG off:", text.slice(0, 120)); return; }
  try {
    await fetch(`https://api.telegram.org/bot${CONFIG.TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CONFIG.TG_CHAT, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
  } catch (e) { console.error("TG failed:", e.message); }
}

/* ── buy/sell detection ─────────────────────────────────── */

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

function extractSell(tx, wallet) {
  const transfers = tx.tokenTransfers || [];
  const sentToken = transfers.find(
    (t) => t.fromUserAccount === wallet && t.mint && !QUOTE_MINTS.has(t.mint)
  );
  if (sentToken) return { mint: sentToken.mint };

  const swap = tx.events && tx.events.swap;
  if (swap && tx.feePayer === wallet) {
    const ins = (swap.tokenInputs || []).filter((i) => i.mint && !QUOTE_MINTS.has(i.mint));
    if (ins.length) return { mint: ins[0].mint };
  }
  return null;
}

/* ── paper book ─────────────────────────────────────────── */

function stats() {
  const priced = closedTrades.filter((t) => !t.unpriced);
  const wins = priced.filter((t) => t.pnlSol > 0).length;
  const totalPnl = priced.reduce((s, t) => s + t.pnlSol, 0);
  const openRisk = (openPositions.size + settling.size) * CONFIG.POSITION_SOL;
  return {
    open: openPositions.size, settling: settling.size,
    closed: priced.length, unpriced: closedTrades.length - priced.length,
    wins, losses: priced.length - wins,
    winRate: priced.length ? Math.round((wins / priced.length) * 100) : 0,
    totalPnlSol: +totalPnl.toFixed(4),
    totalPnlGbp: +(totalPnl * CONFIG.SOL_GBP).toFixed(2),
    openRisk: +openRisk.toFixed(2),
  };
}

async function openPosition(mint, gap, firstW, secondW) {
  const px = await fetchPriceSol(mint);
  if (!px) {
    console.log(`SKIP ${mint} — no price available at entry`);
    sendTelegram(`⚠️ Confluence on <code>${mint}</code> (gap ${gap}s) but no entry price — trade skipped.`);
    return;
  }
  const entryPrice = px * (1 + CONFIG.SLIPPAGE);
  const tokens = CONFIG.POSITION_SOL / entryPrice;
  const pos = {
    mint, entryPrice, tokens, gap,
    openedAt: now(), first: firstW, second: secondW,
    peakPrice: px,
  };
  openPositions.set(mint, pos);

  sendTelegram(
    `🟢 <b>PAPER BUY</b> ${CONFIG.POSITION_SOL} SOL\n\n` +
    `<code>${mint}</code>\n` +
    `Gap ${gap}s · entry ${entryPrice.toExponential(3)} SOL\n` +
    `📊 dexscreener.com/solana/${mint}`
  );
  console.log(`PAPER BUY ${mint} @ ${entryPrice}`);
}

function finalizeTrade(pos, reason, exitRaw, unpriced = false) {
  const exitPrice = unpriced ? 0 : exitRaw * (1 - CONFIG.SLIPPAGE);
  const proceeds = pos.tokens * exitPrice;
  const pnlSol = unpriced ? 0 : proceeds - CONFIG.POSITION_SOL;
  const mult = !unpriced && pos.entryPrice > 0 ? exitPrice / pos.entryPrice : 0;
  const heldMin = Math.round((now() - pos.openedAt) / 60);

  const trade = {
    mint: pos.mint, reason, heldMin,
    entryPrice: pos.entryPrice, exitPrice,
    mult: +mult.toFixed(3),
    pnlSol: +pnlSol.toFixed(4),
    closedAt: now(), gap: pos.gap,
    unpriced,
  };
  closedTrades.push(trade);
  while (closedTrades.length > 300) closedTrades.shift();

  const s = stats();
  if (unpriced) {
    sendTelegram(
      `⚪️ <b>UNPRICED EXIT</b> (${reason})\n\n<code>${pos.mint}</code>\n` +
      `No price found after ${CONFIG.SETTLE_TRIES} tries — excluded from P&L.`
    );
    console.log(`UNPRICED ${pos.mint} (${reason})`);
  } else {
    const emoji = pnlSol >= 0 ? "✅" : "🔻";
    sendTelegram(
      `${emoji} <b>PAPER SELL</b> (${reason})\n\n` +
      `<code>${pos.mint}</code>\n` +
      `${trade.mult}x · ${pnlSol >= 0 ? "+" : ""}${trade.pnlSol} SOL · held ${heldMin}m\n\n` +
      `Book: ${s.totalPnlSol >= 0 ? "+" : ""}${s.totalPnlSol} SOL (£${s.totalPnlGbp}) · ${s.winRate}% wins · ${s.closed} trades`
    );
    console.log(`PAPER SELL ${pos.mint} ${trade.mult}x pnl=${trade.pnlSol} (${reason})`);
  }
}

async function closePosition(mint, reason) {
  const pos = openPositions.get(mint);
  if (!pos) return;
  openPositions.delete(mint);

  const px = await fetchPriceSol(mint);
  if (px) { finalizeTrade(pos, reason, px); return; }

  // No price yet — coin probably too new for the indexers. Settle later.
  settling.set(mint, { pos, reason, tries: 0, startedAt: now() });
  console.log(`SETTLING ${mint} — no price yet, will retry`);
}

/* settling retry loop */
setInterval(async () => {
  for (const [mint, s] of [...settling]) {
    s.tries++;
    const px = await fetchPriceSol(mint);
    if (px) {
      settling.delete(mint);
      finalizeTrade(s.pos, s.reason, px);
    } else if (s.tries >= CONFIG.SETTLE_TRIES) {
      settling.delete(mint);
      finalizeTrade(s.pos, s.reason, 0, true);
    }
  }
}, CONFIG.SETTLE_INTERVAL_MS);

/* timeout sweep + peak tracking + housekeeping */
setInterval(async () => {
  const cutoff = now() - CONFIG.MAX_HOLD_MIN * 60;
  for (const [mint, pos] of [...openPositions]) {
    if (pos.openedAt < cutoff) {
      await closePosition(mint, "timeout");
    } else {
      const px = await fetchPriceSol(mint);
      if (px && px > pos.peakPrice) pos.peakPrice = px;
    }
  }
  const c = now() - CONFIG.WINDOW * 2;
  for (const [mint, wallets] of buysByMint) {
    for (const [w, ts] of wallets) if (ts < c) wallets.delete(w);
    if (!wallets.size) buysByMint.delete(mint);
  }
  while (recentBuys.length > 100) recentBuys.shift();
}, 60_000);

/* ── webhook handling ───────────────────────────────────── */

function recordBuy(wallet, mint, ts) {
  recentBuys.push({ ts, wallet, mint });
  if (!buysByMint.has(mint)) buysByMint.set(mint, new Map());
  const wallets = buysByMint.get(mint);
  if (!wallets.has(wallet)) wallets.set(wallet, ts);

  if (alerted.has(mint)) return;

  const entries = [...wallets.entries()].filter(([, t]) => ts - t <= CONFIG.WINDOW);
  if (entries.length >= 2) {
    alerted.add(mint);
    entries.sort((a, b) => a[1] - b[1]);
    const gap = entries[entries.length - 1][1] - entries[0][1];
    openPosition(mint, gap, entries[0][0], entries[entries.length - 1][0]);
  }
}

function handleWebhookPayload(payload) {
  const txs = Array.isArray(payload) ? payload : [payload];
  for (const tx of txs) {
    if (!tx || !tx.signature) continue;
    const ts = tx.timestamp || now();
    for (const wallet of CONFIG.WATCH_WALLETS) {
      const buy = extractBuy(tx, wallet);
      if (buy) { recordBuy(wallet, buy.mint, ts); continue; }
      const sell = extractSell(tx, wallet);
      if (sell && openPositions.has(sell.mint)) {
        closePosition(sell.mint, `${short(wallet)} sold`);
      }
    }
  }
}

/* ── page ───────────────────────────────────────────────── */

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

function renderPage() {
  const s = stats();
  const fmtAgo = (ts) => {
    const d = now() - ts;
    if (d < 60) return `${d}s ago`;
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    return `${Math.floor(d / 3600)}h ago`;
  };

  const openRows = [...openPositions.values()].map((p) => {
    const peakX = (p.peakPrice / p.entryPrice).toFixed(2);
    return `<li class="row open"><div class="body">
      <div class="head"><span class="sym">${esc(short(p.mint))}</span><span class="x">peak ${peakX}x</span></div>
      <div class="meta">opened ${fmtAgo(p.openedAt)} · gap ${p.gap}s · ${CONFIG.POSITION_SOL} SOL in</div>
      <div class="meta mono">${esc(p.mint)}</div>
    </div></li>`;
  }).join("");

  const settleRows = [...settling.values()].map((sp) => {
    return `<li class="row settle"><div class="body">
      <div class="head"><span class="sym">${esc(short(sp.pos.mint))}</span><span class="x">settling ${sp.tries}/${CONFIG.SETTLE_TRIES}</span></div>
      <div class="meta">exit "${esc(sp.reason)}" — waiting for indexers to price it</div>
      <div class="meta mono">${esc(sp.pos.mint)}</div>
    </div></li>`;
  }).join("");

  const tradeRows = [...closedTrades].reverse().map((t) => {
    const cls = t.unpriced ? "flat" : t.pnlSol >= 0 ? "win" : "loss";
    const headline = t.unpriced
      ? "unpriced · excluded"
      : `${t.mult}x · ${t.pnlSol >= 0 ? "+" : ""}${t.pnlSol} SOL`;
    return `<li class="row ${cls}"><div class="body">
      <div class="head"><span class="sym">${esc(short(t.mint))}</span>
        <span class="x">${headline}</span></div>
      <div class="meta">${fmtAgo(t.closedAt)} · held ${t.heldMin}m · ${esc(t.reason)}</div>
      <div class="meta mono">${esc(t.mint)}</div>
    </div></li>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Paper Trader</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<meta http-equiv="refresh" content="30">
<style>
  :root{--ground:#12151F;--panel:#1A1F2E;--edge:#2A3145;--amber:#E8A33D;--cyan:#4DD0C7;--slate:#6B7489;--clay:#C4574A;--ink:#E4E7EF}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--ground);color:var(--ink);font-family:'IBM Plex Mono',monospace;font-size:13px;line-height:1.5;padding:20px 16px 60px}
  h1{font-family:'Space Grotesk',sans-serif;font-size:24px;margin-bottom:4px}
  h1 em{font-style:normal;color:var(--cyan)}
  .sub{color:var(--slate);font-size:11.5px;margin-bottom:16px}
  .cards{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px}
  .card{background:var(--panel);border:1px solid var(--edge);padding:10px 12px;min-width:92px;flex:1}
  .card b{font-size:17px;display:block}
  .card span{color:var(--slate);font-size:10px;text-transform:uppercase;letter-spacing:.08em}
  h2{font-family:'Space Grotesk',sans-serif;font-size:14px;margin:22px 0 10px}
  ul{list-style:none}
  .row{background:var(--panel);border:1px solid var(--edge);border-left:2px solid var(--slate);padding:11px 12px;margin-bottom:8px}
  .row.open{border-left-color:var(--amber)}
  .row.settle{border-left-color:var(--slate)}
  .row.win{border-left-color:var(--cyan)}
  .row.loss{border-left-color:var(--clay)}
  .row.flat{border-left-color:var(--edge);opacity:.65}
  .head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px}
  .sym{font-weight:600}
  .x{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:14px}
  .row.win .x{color:var(--cyan)}
  .row.loss .x{color:var(--clay)}
  .row.open .x{color:var(--amber)}
  .row.settle .x,.row.flat .x{color:var(--slate)}
  .meta{color:var(--slate);font-size:10.5px;margin-top:2px}
  .mono{word-break:break-all;font-size:9.5px}
  .none{color:var(--slate);font-size:12px;padding:12px;background:var(--panel);border:1px dashed var(--edge)}
</style></head><body>
  <h1>Paper <em>trader</em></h1>
  <div class="sub">
    v2 · ${CONFIG.WATCH_WALLETS.map((w) => esc(short(w))).join(" + ")} ·
    ${CONFIG.POSITION_SOL} SOL/trade · exit on their sell or ${CONFIG.MAX_HOLD_MIN}m ·
    ${CONFIG.SLIPPAGE * 100}% slippage both ways · ${webhookHits} webhook hits ·
    ${CONFIG.TG_TOKEN ? "telegram ✓" : "TELEGRAM NOT SET"}
  </div>
  <div class="cards">
    <div class="card"><b style="color:${s.totalPnlSol >= 0 ? "var(--cyan)" : "var(--clay)"}">${s.totalPnlSol >= 0 ? "+" : ""}${s.totalPnlSol}</b><span>P&amp;L SOL</span></div>
    <div class="card"><b style="color:${s.totalPnlGbp >= 0 ? "var(--cyan)" : "var(--clay)"}">£${s.totalPnlGbp}</b><span>P&amp;L GBP</span></div>
    <div class="card"><b>${s.winRate}%</b><span>win rate</span></div>
    <div class="card"><b>${s.closed}</b><span>closed${s.unpriced ? ` (+${s.unpriced} unpriced)` : ""}</span></div>
    <div class="card"><b>${s.open + s.settling}</b><span>open/settling (${s.openRisk} SOL)</span></div>
  </div>
  <h2>Open positions</h2>
  ${openRows || settleRows
    ? `<ul>${openRows}${settleRows}</ul>`
    : `<div class="none">None open. Waiting for the next confluence.</div>`}
  <h2>Closed trades</h2>
  ${tradeRows ? `<ul>${tradeRows}</ul>` : `<div class="none">No completed trades yet.</div>`}
</body></html>`;
}

/* ── server ─────────────────────────────────────────────── */

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/webhook") {
    if (CONFIG.WEBHOOK_SECRET && req.headers["authorization"] !== CONFIG.WEBHOOK_SECRET) {
      res.writeHead(401); return res.end("nope");
    }
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 5_000_000) req.destroy(); });
    req.on("end", () => {
      webhookHits++;
      try { handleWebhookPayload(JSON.parse(body)); } catch (e) { console.error("bad payload:", e.message); }
      res.writeHead(200); res.end("ok");
    });
    return;
  }

  if (req.url === "/health") { res.writeHead(200); return res.end("ok"); }
  if (req.url === "/test-alert") {
    sendTelegram("✅ Paper trader test — Telegram is wired up.");
    res.writeHead(200); return res.end("test sent");
  }
  if (req.url === "/book.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      stats: stats(),
      open: [...openPositions.values()],
      settling: [...settling.values()],
      closed: closedTrades,
    }, null, 2));
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(renderPage());
});

server.listen(CONFIG.PORT, () => {
  console.log(`Paper trader v2 up on ${CONFIG.PORT} — ${CONFIG.POSITION_SOL} SOL/trade, ${CONFIG.WATCH_WALLETS.length} wallets`);
  if (CONFIG.WATCH_WALLETS.length < 2) console.warn("WARNING: fewer than 2 wallets — confluence can never fire.");
});
