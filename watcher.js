/**
 * CONFLUENCE WATCHER — Railway service
 * ------------------------------------
 * Watches two (or more) wallets via Helius webhook. When BOTH buy the
 * same token within CONFLUENCE_WINDOW_SECONDS, sends one Telegram alert.
 *
 * Required env vars:
 *   WATCH_WALLETS            comma-separated wallet addresses (2+)
 *   TELEGRAM_BOT_TOKEN       from @BotFather
 *   TELEGRAM_CHAT_ID         your chat id
 * Optional:
 *   CONFLUENCE_WINDOW_SECONDS  default 600 (10 minutes)
 *   WEBHOOK_SECRET             if set, Helius must send it as Authorization header
 */

import http from "http";

const CONFIG = {
  WATCH_WALLETS: (process.env.WATCH_WALLETS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  WINDOW: Number(process.env.CONFLUENCE_WINDOW_SECONDS || 600),
  TG_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  TG_CHAT: process.env.TELEGRAM_CHAT_ID || "",
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || "",
  PORT: Number(process.env.PORT || 3000),
};

const QUOTE_MINTS = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

/* ── state ─────────────────────────────────────────────── */

// mint -> Map(wallet -> firstBuyTimestamp)
const buysByMint = new Map();
// mints already alerted (never alert twice per coin)
const alerted = new Set();
// rolling logs for the status page
const recentBuys = [];   // {ts, wallet, mint}
const recentAlerts = []; // {ts, mint, gapSec, first, second}
let webhookHits = 0;

const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const now = () => Math.floor(Date.now() / 1000);

function prune() {
  const cutoff = now() - CONFIG.WINDOW * 2;
  for (const [mint, wallets] of buysByMint) {
    for (const [w, ts] of wallets) if (ts < cutoff) wallets.delete(w);
    if (!wallets.size) buysByMint.delete(mint);
  }
  while (recentBuys.length > 100) recentBuys.shift();
  while (recentAlerts.length > 50) recentAlerts.shift();
}
setInterval(prune, 60_000);

/* ── buy detection (same three paths as the source finder) ── */

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

/* ── telegram ──────────────────────────────────────────── */

async function sendTelegram(text) {
  if (!CONFIG.TG_TOKEN || !CONFIG.TG_CHAT) {
    console.log("TELEGRAM NOT CONFIGURED — alert:", text);
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${CONFIG.TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CONFIG.TG_CHAT,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
  } catch (e) {
    console.error("Telegram send failed:", e.message);
  }
}

/* ── confluence logic ──────────────────────────────────── */

function recordBuy(wallet, mint, ts) {
  recentBuys.push({ ts, wallet, mint });

  if (!buysByMint.has(mint)) buysByMint.set(mint, new Map());
  const wallets = buysByMint.get(mint);
  if (!wallets.has(wallet)) wallets.set(wallet, ts);

  if (alerted.has(mint)) return;

  // confluence: 2+ distinct watched wallets on the same mint within the window
  const entries = [...wallets.entries()].filter(([, t]) => ts - t <= CONFIG.WINDOW);
  if (entries.length >= 2) {
    alerted.add(mint);
    entries.sort((a, b) => a[1] - b[1]);
    const [firstW, firstTs] = entries[0];
    const [secondW, secondTs] = entries[entries.length - 1];
    const gap = secondTs - firstTs;

    recentAlerts.push({ ts, mint, gapSec: gap, first: firstW, second: secondW });

    const msg =
      `🚨 <b>CONFLUENCE</b>\n\n` +
      `Both wallets bought the same coin ${gap}s apart.\n\n` +
      `<b>Token:</b>\n<code>${mint}</code>\n\n` +
      `First: <code>${short(firstW)}</code>\n` +
      `Then:  <code>${short(secondW)}</code>\n\n` +
      `📊 dexscreener.com/solana/${mint}\n` +
      `🔎 solscan.io/token/${mint}`;

    sendTelegram(msg);
    console.log(`ALERT ${mint} gap=${gap}s`);
  }
}

function handleWebhookPayload(payload) {
  const txs = Array.isArray(payload) ? payload : [payload];
  for (const tx of txs) {
    if (!tx || !tx.signature) continue;
    const ts = tx.timestamp || now();
    for (const wallet of CONFIG.WATCH_WALLETS) {
      const buy = extractBuy(tx, wallet);
      if (buy) recordBuy(wallet, buy.mint, ts);
    }
  }
}

/* ── status page ───────────────────────────────────────── */

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

function renderPage() {
  const fmtAgo = (ts) => {
    const s = now() - ts;
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
  };

  const alertRows = [...recentAlerts].reverse().map((a) =>
    `<li class="row alert"><div>
      <div class="addr">${esc(a.mint)}</div>
      <div class="meta">${fmtAgo(a.ts)} · ${a.gapSec}s gap · ${esc(short(a.first))} → ${esc(short(a.second))}</div>
    </div></li>`
  ).join("");

  const buyRows = [...recentBuys].reverse().slice(0, 30).map((b) =>
    `<li class="row"><div>
      <div class="addr">${esc(b.mint)}</div>
      <div class="meta">${fmtAgo(b.ts)} · ${esc(short(b.wallet))}</div>
    </div></li>`
  ).join("");

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Confluence Watcher</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<meta http-equiv="refresh" content="30">
<style>
  :root{--ground:#12151F;--panel:#1A1F2E;--edge:#2A3145;--amber:#E8A33D;--cyan:#4DD0C7;--slate:#6B7489;--ink:#E4E7EF}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--ground);color:var(--ink);font-family:'IBM Plex Mono',monospace;font-size:13px;line-height:1.5;padding:20px 16px 60px}
  h1{font-family:'Space Grotesk',sans-serif;font-size:24px;margin-bottom:4px}
  h1 em{font-style:normal;color:var(--cyan)}
  .sub{color:var(--slate);font-size:11.5px;margin-bottom:20px}
  h2{font-family:'Space Grotesk',sans-serif;font-size:14px;margin:24px 0 10px}
  ul{list-style:none}
  .row{background:var(--panel);border:1px solid var(--edge);border-left:2px solid var(--amber);padding:10px 12px;margin-bottom:8px}
  .row.alert{border-left-color:var(--cyan)}
  .addr{font-size:11px;word-break:break-all}
  .meta{color:var(--slate);font-size:10.5px;margin-top:4px}
  .none{color:var(--slate);font-size:12px;padding:12px;background:var(--panel);border:1px dashed var(--edge)}
</style></head><body>
  <h1>Confluence <em>watcher</em></h1>
  <div class="sub">
    ${CONFIG.WATCH_WALLETS.map((w) => esc(short(w))).join(" + ")} ·
    ${CONFIG.WINDOW}s window · ${webhookHits} webhook hits ·
    ${CONFIG.TG_TOKEN ? "telegram ✓" : "TELEGRAM NOT SET"}
  </div>
  <h2>Alerts (${recentAlerts.length})</h2>
  ${alertRows ? `<ul>${alertRows}</ul>` : `<div class="none">No confluence yet. Expect roughly one a day — the page refreshes itself.</div>`}
  <h2>Recent buys seen</h2>
  ${buyRows ? `<ul>${buyRows}</ul>` : `<div class="none">Nothing yet. If this stays empty for hours, check the Helius webhook is pointed at /webhook on this domain.</div>`}
</body></html>`;
}

/* ── server ────────────────────────────────────────────── */

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
    sendTelegram("✅ Confluence watcher test — Telegram is wired up.");
    res.writeHead(200); return res.end("test alert sent (check Telegram)");
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(renderPage());
});

server.listen(CONFIG.PORT, () => {
  console.log(`Watcher up on ${CONFIG.PORT}, watching ${CONFIG.WATCH_WALLETS.length} wallets, window ${CONFIG.WINDOW}s`);
  if (CONFIG.WATCH_WALLETS.length < 2) console.warn("WARNING: fewer than 2 wallets — confluence can never fire.");
});
