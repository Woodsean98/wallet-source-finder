/**
 * CONFLUENCE TRADER v3.1 — paper always on, live engine armable
 * -------------------------------------------------------------
 * v3.1: replaced @solana/web3.js (Node 18 dependency clash) with
 * minimal ed25519 signing via tweetnacl + bs58. Same behaviour.
 *
 * LIVE is DISARMED unless WALLET_PRIVATE_KEY + JUPITER_API_KEY +
 * HELIUS_API_KEY are set AND you arm it (LIVE_TRADING=true env, or
 * visit /arm?key=CONTROL_KEY). Disarm: /stop?key=CONTROL_KEY.
 * Auto-disarms if the day's live losses reach LIVE_MAX_DAILY_LOSS_SOL.
 *
 * Env vars: see v3 notes — unchanged.
 */

import http from "http";
import bs58 from "bs58";
import nacl from "tweetnacl";

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
  SETTLE_TRIES: 10,
  SETTLE_INTERVAL_MS: 30_000,
  HELIUS_KEY: process.env.HELIUS_API_KEY || "",
  WALLET_KEY: process.env.WALLET_PRIVATE_KEY || "",
  JUP_KEY: process.env.JUPITER_API_KEY || "",
  CONTROL_KEY: process.env.CONTROL_KEY || "",
  LIVE_ON_BOOT: (process.env.LIVE_TRADING || "false") === "true",
  LIVE_POSITION_SOL: Number(process.env.LIVE_POSITION_SOL || 0.05),
  LIVE_MAX_OPEN: Number(process.env.LIVE_MAX_OPEN || 3),
  LIVE_MAX_DAILY_LOSS: Number(process.env.LIVE_MAX_DAILY_LOSS_SOL || 0.5),
};

const SOL_MINT = "So11111111111111111111111111111111111111112";
const QUOTE_MINTS = new Set([
  SOL_MINT,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);
const LAMPORTS = 1_000_000_000;
const RPC = CONFIG.HELIUS_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${CONFIG.HELIUS_KEY}`
  : "";

/* ── wallet (no web3.js — raw ed25519) ──────────────────── */

let liveWallet = null;   // { secretKey: Uint8Array(64), publicKey: base58 string, publicKeyBytes }
let liveWalletError = "";
try {
  if (CONFIG.WALLET_KEY) {
    const decoded = bs58.decode(CONFIG.WALLET_KEY.trim());
    if (decoded.length !== 64) throw new Error(`key is ${decoded.length} bytes, expected 64`);
    const publicKeyBytes = decoded.slice(32);
    liveWallet = {
      secretKey: decoded,
      publicKeyBytes,
      publicKey: bs58.encode(publicKeyBytes),
    };
  }
} catch (e) {
  liveWalletError = `WALLET_PRIVATE_KEY invalid (${e.message}) — use Phantom's base58 export`;
}

/**
 * Sign a base64 serialized Solana transaction (legacy or v0) with our key.
 * Layout: [compact-u16 sig count][64-byte sigs...][message]
 */
function signTransactionBase64(b64) {
  const buf = Buffer.from(b64, "base64");
  // compact-u16 decode
  let sigCount = 0, sizeBytes = 0;
  for (;;) {
    const b = buf[sizeBytes];
    sigCount |= (b & 0x7f) << (7 * sizeBytes);
    sizeBytes++;
    if ((b & 0x80) === 0) break;
  }
  const msgStart = sizeBytes + 64 * sigCount;
  const message = buf.slice(msgStart);

  // find our slot among required signers
  let o = 0;
  if (message[o] & 0x80) o += 1;             // v0 version byte
  const numRequired = message[o]; o += 3;    // header: required, ro-signed, ro-unsigned
  let keyCount = 0, kSize = 0;
  for (;;) {
    const b = message[o + kSize];
    keyCount |= (b & 0x7f) << (7 * kSize);
    kSize++;
    if ((b & 0x80) === 0) break;
  }
  o += kSize;
  let slot = -1;
  for (let i = 0; i < Math.min(numRequired, keyCount); i++) {
    const key = message.slice(o + i * 32, o + i * 32 + 32);
    if (Buffer.compare(key, Buffer.from(liveWallet.publicKeyBytes)) === 0) { slot = i; break; }
  }
  if (slot === -1) throw new Error("our wallet is not a required signer on this transaction");

  const sig = nacl.sign.detached(new Uint8Array(message), new Uint8Array(liveWallet.secretKey));
  Buffer.from(sig).copy(buf, sizeBytes + 64 * slot);
  return buf.toString("base64");
}

const liveReady = () => !!(liveWallet && CONFIG.JUP_KEY && RPC);
let liveArmed = CONFIG.LIVE_ON_BOOT && liveReady();
let disarmReason = liveArmed ? "" : "boot default";

/* ── state ──────────────────────────────────────────────── */

const buysByMint = new Map();
const alerted = new Set();
const openPositions = new Map();
const settling = new Map();
const closedTrades = [];
const recentBuys = [];
let webhookHits = 0;

const liveOpen = new Map();
const liveClosed = [];
let liveDay = new Date().toISOString().slice(0, 10);
let liveDayPnl = 0;
let walletSol = null;

const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── pricing (paper) ────────────────────────────────────── */

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

/* ── telegram ───────────────────────────────────────────── */

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

/* ── RPC helpers ────────────────────────────────────────── */

async function rpcCall(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

async function getWalletSol() {
  if (!liveWallet || !RPC) return null;
  try {
    const r = await rpcCall("getBalance", [liveWallet.publicKey]);
    return r.value / LAMPORTS;
  } catch { return null; }
}

async function getTokenRawBalance(mint) {
  const r = await rpcCall("getTokenAccountsByOwner", [
    liveWallet.publicKey, { mint }, { encoding: "jsonParsed" },
  ]);
  let total = 0n;
  for (const acc of r.value || []) {
    const amt = acc.account?.data?.parsed?.info?.tokenAmount?.amount;
    if (amt) total += BigInt(amt);
  }
  return total;
}

/* ── Jupiter Ultra ──────────────────────────────────────── */

async function ultraSwap(inputMint, outputMint, rawAmount) {
  const slippageBps = Math.round(CONFIG.SLIPPAGE * 10_000);
  const url =
    `https://api.jup.ag/ultra/v1/order?inputMint=${inputMint}&outputMint=${outputMint}` +
    `&amount=${rawAmount}&taker=${liveWallet.publicKey}&slippageBps=${slippageBps}`;
  const orderRes = await fetch(url, { headers: { "x-api-key": CONFIG.JUP_KEY } });
  const order = await orderRes.json();
  if (!order.transaction || !order.requestId) {
    throw new Error(`order failed: ${order.error || order.message || orderRes.status}`);
  }
  const signedTransaction = signTransactionBase64(order.transaction);

  const execRes = await fetch("https://api.jup.ag/ultra/v1/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": CONFIG.JUP_KEY },
    body: JSON.stringify({ signedTransaction, requestId: order.requestId }),
  });
  const exec = await execRes.json();
  if (exec.status !== "Success") {
    throw new Error(`execute failed: ${exec.error || exec.code || exec.status}`);
  }
  return exec;
}

/* ── live engine ────────────────────────────────────────── */

function rolloverLiveDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== liveDay) { liveDay = today; liveDayPnl = 0; }
}

function disarm(reason) {
  if (!liveArmed) return;
  liveArmed = false;
  disarmReason = reason;
  sendTelegram(`🛑 <b>LIVE DISARMED</b> — ${reason}. Paper continues.`);
  console.log(`LIVE DISARMED: ${reason}`);
}

async function liveBuy(mint, gap) {
  rolloverLiveDay();
  if (!liveArmed) return;
  if (liveOpen.size >= CONFIG.LIVE_MAX_OPEN) {
    console.log(`LIVE skip ${mint} — ${liveOpen.size} positions already open`);
    return;
  }
  const rawIn = Math.round(CONFIG.LIVE_POSITION_SOL * LAMPORTS);
  try {
    const exec = await ultraSwap(SOL_MINT, mint, rawIn);
    const solIn = Number(exec.inputAmountResult ?? rawIn) / LAMPORTS;
    const tokensRaw = String(exec.outputAmountResult ?? "0");
    liveOpen.set(mint, {
      mint, solIn, tokensRaw, sig: exec.signature || "",
      openedAt: now(), status: "open",
    });
    sendTelegram(
      `🔴 <b>LIVE BUY</b> ${solIn.toFixed(4)} SOL\n\n<code>${mint}</code>\n` +
      `gap ${gap}s\n📊 dexscreener.com/solana/${mint}\n🔎 solscan.io/tx/${exec.signature || ""}`
    );
    console.log(`LIVE BUY ${mint} ${solIn} SOL sig=${exec.signature}`);
  } catch (e) {
    sendTelegram(`⚠️ <b>LIVE BUY FAILED</b>\n<code>${mint}</code>\n${e.message}\nNo position opened.`);
    console.error(`LIVE BUY FAILED ${mint}: ${e.message}`);
  }
}

async function liveSell(mint, reason, attempt = 1) {
  const pos = liveOpen.get(mint);
  if (!pos || pos.status === "selling") return;
  pos.status = "selling";
  try {
    let raw = BigInt(pos.tokensRaw || "0");
    try { const chain = await getTokenRawBalance(mint); if (chain > 0n) raw = chain; } catch {}
    if (raw <= 0n) throw new Error("no token balance found on chain");

    const exec = await ultraSwap(mint, SOL_MINT, raw.toString());
    const solOut = Number(exec.outputAmountResult ?? 0) / LAMPORTS;
    const pnlSol = +(solOut - pos.solIn).toFixed(4);

    liveOpen.delete(mint);
    liveClosed.push({
      mint, solIn: pos.solIn, solOut: +solOut.toFixed(4), pnlSol,
      reason, sigBuy: pos.sig, sigSell: exec.signature || "",
      closedAt: now(), stuck: false,
    });
    while (liveClosed.length > 200) liveClosed.shift();
    liveDayPnl += pnlSol;

    const emoji = pnlSol >= 0 ? "✅" : "🔻";
    sendTelegram(
      `${emoji} <b>LIVE SELL</b> (${reason})\n\n<code>${mint}</code>\n` +
      `${pnlSol >= 0 ? "+" : ""}${pnlSol} SOL (in ${pos.solIn.toFixed(4)} → out ${solOut.toFixed(4)})\n` +
      `Day: ${liveDayPnl >= 0 ? "+" : ""}${liveDayPnl.toFixed(4)} SOL\n🔎 solscan.io/tx/${exec.signature || ""}`
    );
    console.log(`LIVE SELL ${mint} pnl=${pnlSol} (${reason})`);

    if (liveDayPnl <= -CONFIG.LIVE_MAX_DAILY_LOSS) {
      disarm(`daily loss cap hit (${liveDayPnl.toFixed(4)} SOL)`);
    }
  } catch (e) {
    console.error(`LIVE SELL FAILED ${mint} (try ${attempt}): ${e.message}`);
    if (attempt < 4) {
      pos.status = "open";
      await sleep(5_000 * attempt);
      return liveSell(mint, reason, attempt + 1);
    }
    pos.status = "stuck";
    sendTelegram(
      `🚨 <b>LIVE POSITION STUCK</b>\n<code>${mint}</code>\n` +
      `Sell failed 4x: ${e.message}\nSell it manually from Phantom, then /clear-stuck?key=…&mint=${mint}`
    );
  }
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

function liveStats() {
  const done = liveClosed.filter((t) => !t.stuck);
  const wins = done.filter((t) => t.pnlSol > 0).length;
  const totalPnl = done.reduce((s, t) => s + t.pnlSol, 0);
  return {
    open: liveOpen.size, closed: done.length, wins,
    winRate: done.length ? Math.round((wins / done.length) * 100) : 0,
    totalPnlSol: +totalPnl.toFixed(4),
    totalPnlGbp: +(totalPnl * CONFIG.SOL_GBP).toFixed(2),
    dayPnl: +liveDayPnl.toFixed(4),
  };
}

async function openPosition(mint, gap, firstW, secondW) {
  const px = await fetchPriceSol(mint);
  if (!px) {
    console.log(`SKIP ${mint} — no price available at entry`);
    sendTelegram(`⚠️ Confluence on <code>${mint}</code> (gap ${gap}s) but no entry price — paper trade skipped.`);
    return;
  }
  const entryPrice = px * (1 + CONFIG.SLIPPAGE);
  const tokens = CONFIG.POSITION_SOL / entryPrice;
  openPositions.set(mint, {
    mint, entryPrice, tokens, gap,
    openedAt: now(), first: firstW, second: secondW,
    peakPrice: px,
  });
  sendTelegram(
    `🟢 <b>PAPER BUY</b> ${CONFIG.POSITION_SOL} SOL\n\n<code>${mint}</code>\n` +
    `Gap ${gap}s · entry ${entryPrice.toExponential(3)} SOL\n📊 dexscreener.com/solana/${mint}`
  );
}

function finalizeTrade(pos, reason, exitRaw, unpriced = false) {
  const exitPrice = unpriced ? 0 : exitRaw * (1 - CONFIG.SLIPPAGE);
  const proceeds = pos.tokens * exitPrice;
  const pnlSol = unpriced ? 0 : proceeds - CONFIG.POSITION_SOL;
  const mult = !unpriced && pos.entryPrice > 0 ? exitPrice / pos.entryPrice : 0;
  const heldMin = Math.round((now() - pos.openedAt) / 60);

  closedTrades.push({
    mint: pos.mint, reason, heldMin,
    entryPrice: pos.entryPrice, exitPrice,
    mult: +mult.toFixed(3), pnlSol: +pnlSol.toFixed(4),
    closedAt: now(), gap: pos.gap, unpriced,
  });
  while (closedTrades.length > 300) closedTrades.shift();

  const s = stats();
  if (unpriced) {
    sendTelegram(`⚪️ <b>UNPRICED EXIT</b> (${reason})\n\n<code>${pos.mint}</code>\nExcluded from P&L.`);
  } else {
    const emoji = pnlSol >= 0 ? "✅" : "🔻";
    sendTelegram(
      `${emoji} <b>PAPER SELL</b> (${reason})\n\n<code>${pos.mint}</code>\n` +
      `${(+mult.toFixed(3))}x · ${pnlSol >= 0 ? "+" : ""}${+pnlSol.toFixed(4)} SOL · held ${heldMin}m\n\n` +
      `Book: ${s.totalPnlSol >= 0 ? "+" : ""}${s.totalPnlSol} SOL (£${s.totalPnlGbp}) · ${s.winRate}% wins · ${s.closed} trades`
    );
  }
}

async function closePosition(mint, reason) {
  const pos = openPositions.get(mint);
  if (!pos) return;
  openPositions.delete(mint);
  const px = await fetchPriceSol(mint);
  if (px) { finalizeTrade(pos, reason, px); return; }
  settling.set(mint, { pos, reason, tries: 0, startedAt: now() });
}

setInterval(async () => {
  for (const [mint, s] of [...settling]) {
    s.tries++;
    const px = await fetchPriceSol(mint);
    if (px) { settling.delete(mint); finalizeTrade(s.pos, s.reason, px); }
    else if (s.tries >= CONFIG.SETTLE_TRIES) { settling.delete(mint); finalizeTrade(s.pos, s.reason, 0, true); }
  }
}, CONFIG.SETTLE_INTERVAL_MS);

setInterval(async () => {
  const cutoff = now() - CONFIG.MAX_HOLD_MIN * 60;
  for (const [mint, pos] of [...openPositions]) {
    if (pos.openedAt < cutoff) await closePosition(mint, "timeout");
    else {
      const px = await fetchPriceSol(mint);
      if (px && px > pos.peakPrice) pos.peakPrice = px;
    }
  }
  for (const [mint, pos] of [...liveOpen]) {
    if (pos.status === "open" && pos.openedAt < cutoff) liveSell(mint, "timeout");
  }
  walletSol = await getWalletSol();
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
    liveBuy(mint, gap);
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
      if (sell) {
        if (openPositions.has(sell.mint)) closePosition(sell.mint, `${short(wallet)} sold`);
        if (liveOpen.has(sell.mint)) liveSell(sell.mint, `${short(wallet)} sold`);
      }
    }
  }
}

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

/* ── page ───────────────────────────────────────────────── */

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

function renderPage() {
  const s = stats();
  const ls = liveStats();
  const fmtAgo = (ts) => {
    const d = now() - ts;
    if (d < 60) return `${d}s ago`;
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    return `${Math.floor(d / 3600)}h ago`;
  };

  let liveBanner;
  if (liveArmed) {
    liveBanner = `<div class="banner armed">🔴 LIVE ARMED — ${CONFIG.LIVE_POSITION_SOL} SOL/trade real money · day ${ls.dayPnl >= 0 ? "+" : ""}${ls.dayPnl} SOL · cap −${CONFIG.LIVE_MAX_DAILY_LOSS} · wallet ${walletSol === null ? "?" : walletSol.toFixed(3)} SOL</div>`;
  } else if (liveReady()) {
    liveBanner = `<div class="banner ready">⚪️ Live engine ready, DISARMED (${esc(disarmReason)}) · wallet ${walletSol === null ? "?" : walletSol.toFixed(3)} SOL · arm via /arm?key=…</div>`;
  } else {
    const missing = [];
    if (!liveWallet) missing.push(liveWalletError || "WALLET_PRIVATE_KEY");
    if (!CONFIG.JUP_KEY) missing.push("JUPITER_API_KEY");
    if (!RPC) missing.push("HELIUS_API_KEY");
    liveBanner = `<div class="banner off">⚪️ Live engine not configured — missing: ${esc(missing.join(", "))}. Paper only.</div>`;
  }

  const openRows = [...openPositions.values()].map((p) => {
    const peakX = (p.peakPrice / p.entryPrice).toFixed(2);
    return `<li class="row open"><div class="body">
      <div class="head"><span class="sym">${esc(short(p.mint))}</span><span class="x">peak ${peakX}x</span></div>
      <div class="meta">opened ${fmtAgo(p.openedAt)} · gap ${p.gap}s · ${CONFIG.POSITION_SOL} SOL in</div>
      <div class="meta mono">${esc(p.mint)}</div>
    </div></li>`;
  }).join("");

  const settleRows = [...settling.values()].map((sp) => `<li class="row settle"><div class="body">
      <div class="head"><span class="sym">${esc(short(sp.pos.mint))}</span><span class="x">settling ${sp.tries}/${CONFIG.SETTLE_TRIES}</span></div>
      <div class="meta">exit "${esc(sp.reason)}" — waiting for price</div>
      <div class="meta mono">${esc(sp.pos.mint)}</div>
    </div></li>`).join("");

  const liveOpenRows = [...liveOpen.values()].map((p) => `<li class="row ${p.status === "stuck" ? "loss" : "live"}"><div class="body">
      <div class="head"><span class="sym">${esc(short(p.mint))}</span><span class="x">${p.status === "stuck" ? "STUCK — sell manually" : `LIVE · ${p.solIn.toFixed(3)} SOL in`}</span></div>
      <div class="meta">opened ${fmtAgo(p.openedAt)} · <a href="https://solscan.io/tx/${esc(p.sig)}">buy tx</a></div>
      <div class="meta mono">${esc(p.mint)}</div>
    </div></li>`).join("");

  const liveTradeRows = [...liveClosed].reverse().map((t) => {
    const cls = t.pnlSol >= 0 ? "win" : "loss";
    return `<li class="row ${cls}"><div class="body">
      <div class="head"><span class="sym">${esc(short(t.mint))}</span>
        <span class="x">${t.pnlSol >= 0 ? "+" : ""}${t.pnlSol} SOL</span></div>
      <div class="meta">${fmtAgo(t.closedAt)} · ${esc(t.reason)} · in ${t.solIn.toFixed(3)} → out ${t.solOut.toFixed(3)}</div>
      <div class="meta mono">${esc(t.mint)}</div>
    </div></li>`;
  }).join("");

  const tradeRows = [...closedTrades].reverse().slice(0, 60).map((t) => {
    const cls = t.unpriced ? "flat" : t.pnlSol >= 0 ? "win" : "loss";
    const headline = t.unpriced ? "unpriced · excluded"
      : `${t.mult}x · ${t.pnlSol >= 0 ? "+" : ""}${t.pnlSol} SOL`;
    return `<li class="row ${cls}"><div class="body">
      <div class="head"><span class="sym">${esc(short(t.mint))}</span><span class="x">${headline}</span></div>
      <div class="meta">${fmtAgo(t.closedAt)} · held ${t.heldMin}m · ${esc(t.reason)}</div>
      <div class="meta mono">${esc(t.mint)}</div>
    </div></li>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Confluence Trader</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<meta http-equiv="refresh" content="30">
<style>
  :root{--ground:#12151F;--panel:#1A1F2E;--edge:#2A3145;--amber:#E8A33D;--cyan:#4DD0C7;--slate:#6B7489;--clay:#C4574A;--ink:#E4E7EF;--red:#E5484D}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--ground);color:var(--ink);font-family:'IBM Plex Mono',monospace;font-size:13px;line-height:1.5;padding:20px 16px 60px}
  h1{font-family:'Space Grotesk',sans-serif;font-size:24px;margin-bottom:4px}
  h1 em{font-style:normal;color:var(--cyan)}
  .sub{color:var(--slate);font-size:11.5px;margin-bottom:12px}
  .banner{padding:10px 12px;font-size:11.5px;margin-bottom:14px;border:1px solid var(--edge)}
  .banner.armed{border-color:var(--red);color:#FFB3B5;background:#2A1518}
  .banner.ready{color:var(--slate)}
  .banner.off{color:var(--slate);opacity:.8}
  .cards{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px}
  .card{background:var(--panel);border:1px solid var(--edge);padding:10px 12px;min-width:92px;flex:1}
  .card b{font-size:17px;display:block}
  .card span{color:var(--slate);font-size:10px;text-transform:uppercase;letter-spacing:.08em}
  h2{font-family:'Space Grotesk',sans-serif;font-size:14px;margin:22px 0 10px}
  ul{list-style:none}
  .row{background:var(--panel);border:1px solid var(--edge);border-left:2px solid var(--slate);padding:11px 12px;margin-bottom:8px}
  .row.open{border-left-color:var(--amber)}
  .row.live{border-left-color:var(--red)}
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
  .row.live .x{color:var(--red)}
  .row.settle .x,.row.flat .x{color:var(--slate)}
  .meta{color:var(--slate);font-size:10.5px;margin-top:2px}
  .meta a{color:var(--slate)}
  .mono{word-break:break-all;font-size:9.5px}
  .none{color:var(--slate);font-size:12px;padding:12px;background:var(--panel);border:1px dashed var(--edge)}
</style></head><body>
  <h1>Confluence <em>trader</em></h1>
  <div class="sub">
    v3.1 · ${CONFIG.WATCH_WALLETS.map((w) => esc(short(w))).join(" + ")} ·
    paper ${CONFIG.POSITION_SOL} SOL/trade · exit on their sell or ${CONFIG.MAX_HOLD_MIN}m ·
    ${CONFIG.SLIPPAGE * 100}% slippage · ${webhookHits} webhook hits ·
    ${CONFIG.TG_TOKEN ? "telegram ✓" : "TELEGRAM NOT SET"}
  </div>
  ${liveBanner}
  ${liveReady() ? `
  <h2>Live book (real money)</h2>
  <div class="cards">
    <div class="card"><b style="color:${ls.totalPnlSol >= 0 ? "var(--cyan)" : "var(--clay)"}">${ls.totalPnlSol >= 0 ? "+" : ""}${ls.totalPnlSol}</b><span>live P&amp;L SOL</span></div>
    <div class="card"><b style="color:${ls.totalPnlGbp >= 0 ? "var(--cyan)" : "var(--clay)"}">£${ls.totalPnlGbp}</b><span>live P&amp;L GBP</span></div>
    <div class="card"><b>${ls.winRate}%</b><span>win rate</span></div>
    <div class="card"><b>${ls.closed}</b><span>closed</span></div>
    <div class="card"><b>${ls.open}</b><span>open</span></div>
  </div>
  ${liveOpenRows ? `<ul>${liveOpenRows}</ul>` : ""}
  ${liveTradeRows ? `<ul>${liveTradeRows}</ul>` : `<div class="none">No live trades yet.</div>`}
  ` : ""}
  <h2>Paper book</h2>
  <div class="cards">
    <div class="card"><b style="color:${s.totalPnlSol >= 0 ? "var(--cyan)" : "var(--clay)"}">${s.totalPnlSol >= 0 ? "+" : ""}${s.totalPnlSol}</b><span>P&amp;L SOL</span></div>
    <div class="card"><b style="color:${s.totalPnlGbp >= 0 ? "var(--cyan)" : "var(--clay)"}">£${s.totalPnlGbp}</b><span>P&amp;L GBP</span></div>
    <div class="card"><b>${s.winRate}%</b><span>win rate</span></div>
    <div class="card"><b>${s.closed}</b><span>closed${s.unpriced ? ` (+${s.unpriced} unpriced)` : ""}</span></div>
    <div class="card"><b>${s.open + s.settling}</b><span>open/settling (${s.openRisk} SOL)</span></div>
  </div>
  <h2>Open positions (paper)</h2>
  ${openRows || settleRows ? `<ul>${openRows}${settleRows}</ul>` : `<div class="none">None open. Waiting for the next confluence.</div>`}
  <h2>Closed trades (paper, last 60)</h2>
  ${tradeRows ? `<ul>${tradeRows}</ul>` : `<div class="none">No completed trades yet.</div>`}
</body></html>`;
}

/* ── server ─────────────────────────────────────────────── */

function urlParams(u) {
  const q = u.split("?")[1] || "";
  return Object.fromEntries(new URLSearchParams(q));
}

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

  const path = req.url.split("?")[0];
  const params = urlParams(req.url);
  const keyOk = CONFIG.CONTROL_KEY && params.key === CONFIG.CONTROL_KEY;

  if (path === "/arm") {
    if (!keyOk) { res.writeHead(403); return res.end("bad key (CONTROL_KEY must be set and match)"); }
    if (!liveReady()) { res.writeHead(400); return res.end("live engine not configured — check WALLET_PRIVATE_KEY / JUPITER_API_KEY / HELIUS_API_KEY"); }
    rolloverLiveDay();
    liveArmed = true; disarmReason = "";
    sendTelegram(`🔴 <b>LIVE ARMED</b> — ${CONFIG.LIVE_POSITION_SOL} SOL/trade, max ${CONFIG.LIVE_MAX_OPEN} open, daily cap −${CONFIG.LIVE_MAX_DAILY_LOSS} SOL.`);
    res.writeHead(200); return res.end("LIVE ARMED. Real money now trading. /stop?key=... to disarm.");
  }
  if (path === "/stop") {
    if (CONFIG.CONTROL_KEY && !keyOk) { res.writeHead(403); return res.end("bad key"); }
    disarm("stopped via /stop");
    res.writeHead(200); return res.end("LIVE DISARMED. Paper continues. Open live positions will still be closed on their sell signals/timeouts.");
  }
  if (path === "/clear-stuck") {
    if (!keyOk) { res.writeHead(403); return res.end("bad key"); }
    const m = params.mint;
    if (m && liveOpen.has(m)) { liveOpen.delete(m); res.writeHead(200); return res.end(`cleared ${m}`); }
    res.writeHead(404); return res.end("mint not found in live positions");
  }

  if (path === "/health") { res.writeHead(200); return res.end("ok"); }
  if (path === "/test-alert") {
    sendTelegram("✅ Trader test — Telegram is wired up.");
    res.writeHead(200); return res.end("test sent");
  }
  if (path === "/book.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      paper: { stats: stats(), open: [...openPositions.values()], closed: closedTrades },
      live: { armed: liveArmed, stats: liveStats(), open: [...liveOpen.values()], closed: liveClosed },
    }, null, 2));
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(renderPage());
});

server.listen(CONFIG.PORT, () => {
  console.log(`Confluence trader v3.1 on ${CONFIG.PORT} — live ${liveArmed ? "ARMED" : "disarmed"}, ready=${liveReady()}`);
  if (CONFIG.WATCH_WALLETS.length < 2) console.warn("WARNING: fewer than 2 wallets — confluence can never fire.");
  if (liveWalletError) console.warn(liveWalletError);
});
