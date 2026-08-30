/**
 * CONFLUENCE TRADER v5.1 — FOLLOW MODE + PER-WALLET PAPER FLAG
 * ------------------------------------------------------------
 * v5.0 + PAPER_ONLY_WALLETS: addresses listed there are followed on paper
 * only and NEVER trade live, even when FOLLOW_LIVE=true and live is armed.
 * Use it to audition a wallet risk-free alongside live ones.
 *
 * FOLLOW_WALLETS      — every wallet to follow (paper book always)
 * PAPER_ONLY_WALLETS  — subset of the above that must never go live
 * FOLLOW_LIVE         — master switch for live follow buys (default false)
 */

import http from "http";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import bs58 from "bs58";
import nacl from "tweetnacl";

const CONFIG = {
  WATCH_WALLETS: (process.env.WATCH_WALLETS || "")
    .split(",").map((s) => s.trim()).filter(Boolean),
  MONITOR_WALLETS: (process.env.MONITOR_WALLETS || "")
    .split(",").map((s) => s.trim()).filter(Boolean),
  FOLLOW_WALLETS: (process.env.FOLLOW_WALLETS || "HcyZxKEeLV7hc2MMWBuJmb1Z2C4E5CVKAiUiGzdCEdj5")
    .split(",").map((s) => s.trim()).filter(Boolean),
  PAPER_ONLY_WALLETS: (process.env.PAPER_ONLY_WALLETS || "")
    .split(",").map((s) => s.trim()).filter(Boolean),
  FOLLOW_LIVE: (process.env.FOLLOW_LIVE || "false") === "true",
  FOLLOW_POSITION_SOL: Number(process.env.FOLLOW_POSITION_SOL || 0.15),
  FOLLOW_PAPER_SOL: Number(process.env.FOLLOW_PAPER_SOL || 0.3),
  FOLLOW_MAX_HOLD_MIN: Number(process.env.FOLLOW_MAX_HOLD_MIN || 720),
  FOLLOW_CORPSE_MIN: Number(process.env.FOLLOW_CORPSE_MIN || 30),
  FOLLOW_CORPSE_MULT: Number(process.env.FOLLOW_CORPSE_MULT || 0.75),
  WINDOW: Number(process.env.CONFLUENCE_WINDOW_SECONDS || 600),
  POSITION_SOL: Number(process.env.POSITION_SOL || 0.3),
  SLIPPAGE: Number(process.env.SLIPPAGE_PCT || 3) / 100,
  LIVE_BUY_SLIP: Number(process.env.LIVE_BUY_SLIPPAGE_PCT || 10) / 100,
  LIVE_SELL_SLIP: Number(process.env.LIVE_SELL_SLIPPAGE_PCT || 20) / 100,
  MAX_HOLD_MIN: Number(process.env.MAX_HOLD_MIN || 30),
  TRAIL_MAX_HOLD_MIN: Number(process.env.TRAIL_MAX_HOLD_MIN || 90),
  CORPSE_MIN: Number(process.env.CORPSE_MIN || 10),
  CORPSE_MULT: Number(process.env.CORPSE_MULT || 0.75),
  NOMO_MIN: Number(process.env.NOMO_MIN || 2),
  NOMO_PEAK: Number(process.env.NOMO_PEAK_MULT || 1.05),
  NOMO_EXIT: Number(process.env.NOMO_EXIT_MULT || 0.85),
  MICRO_ARM: Number(process.env.MICRO_TRAIL_ARM || 1.05),
  MICRO_RETRACE: Number(process.env.MICRO_TRAIL_RETRACE_PCT || 15) / 100,
  TRAIL_ARM: Number(process.env.TRAIL_ARM_MULT || 1.5),
  TRAIL_RETRACE: Number(process.env.TRAIL_RETRACE_PCT || 30) / 100,
  NIGHT_START: Number(process.env.NIGHT_START_HOUR || 23),
  NIGHT_END: Number(process.env.NIGHT_END_HOUR || 7),
  SOL_GBP: Number(process.env.SOL_GBP || 80),
  TG_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  TG_CHAT: process.env.TELEGRAM_CHAT_ID || "",
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || "",
  PORT: Number(process.env.PORT || 3000),
  SETTLE_TRIES: 10,
  SETTLE_INTERVAL_MS: 30_000,
  HELIUS_KEY: process.env.HELIUS_API_KEY || "",
  WALLET_KEY: process.env.WALLET_PRIVATE_KEY || "",
  WALLET_SEED: process.env.WALLET_SEED_PHRASE || "",
  JUP_KEY: process.env.JUPITER_API_KEY || "",
  CONTROL_KEY: process.env.CONTROL_KEY || "",
  FHPC_MIN: Number(process.env.FHPC_MIN_SOL || 1.0),
  SIZE_RATIO: Number(process.env.LIVE_SIZE_RATIO || 0.15),
  LIVE_MIN: Number(process.env.LIVE_MIN_SOL || 0.1),
  LIVE_MAX: Number(process.env.LIVE_MAX_SOL || 0.3),
  LIVE_MAX_OPEN: Number(process.env.LIVE_MAX_OPEN || 6),
  LIVE_MAX_DAILY_LOSS: Number(process.env.LIVE_MAX_DAILY_LOSS_SOL || 1),
  LIVE_MIN_WALLET: Number(process.env.LIVE_MIN_WALLET_SOL || 3),
  LIVE_FEE_EST: Number(process.env.LIVE_FEE_EST_SOL || 0.0045),
  DATA_DIR: process.env.DATA_DIR || "/data",
};

const isPaperOnly = (w) => CONFIG.PAPER_ONLY_WALLETS.includes(w);

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
const FHPC = "FHpcNSe6tb2n15bAdq4BkeYWGyZKFD7yLYrH92ng7wCT";

/* ── persistence ────────────────────────────────────────── */

let persistOk = false;
const SIG_FILE = path.join(CONFIG.DATA_DIR, "signal-closed.jsonl");
const LIVE_FILE = path.join(CONFIG.DATA_DIR, "live-closed.jsonl");
const FOLLOW_FILE = path.join(CONFIG.DATA_DIR, "follow-closed.jsonl");
try {
  fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
  fs.appendFileSync(path.join(CONFIG.DATA_DIR, ".touch"), "");
  persistOk = true;
} catch (e) {
  console.warn(`persistence OFF (${e.message}) — mount a Railway volume at ${CONFIG.DATA_DIR}`);
}

function appendClosed(file, obj) {
  if (!persistOk) return;
  try { fs.appendFileSync(file, JSON.stringify(obj) + "\n"); }
  catch (e) { console.error("persist write failed:", e.message); }
}

function loadClosed(file, cap) {
  if (!persistOk) return [];
  try {
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    return lines.slice(-cap).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/* ── wallet ─────────────────────────────────────────────── */

function seedPhraseToKeypair(phrase) {
  const mnemonic = phrase.trim().toLowerCase().replace(/\s+/g, " ");
  const words = mnemonic.split(" ");
  if (words.length !== 12 && words.length !== 24) {
    throw new Error(`seed phrase has ${words.length} words, expected 12 or 24`);
  }
  const seed = crypto.pbkdf2Sync(
    mnemonic.normalize("NFKD"), "mnemonic".normalize("NFKD"), 2048, 64, "sha512"
  );
  let I = crypto.createHmac("sha512", "ed25519 seed").update(seed).digest();
  let key = I.subarray(0, 32), chain = I.subarray(32);
  for (const seg of [44, 501, 0, 0]) {
    const idx = ((seg | 0x80000000) >>> 0);
    const data = Buffer.concat([
      Buffer.from([0]), key,
      Buffer.from([(idx >>> 24) & 0xff, (idx >>> 16) & 0xff, (idx >>> 8) & 0xff, idx & 0xff]),
    ]);
    I = crypto.createHmac("sha512", chain).update(data).digest();
    key = I.subarray(0, 32); chain = I.subarray(32);
  }
  return nacl.sign.keyPair.fromSeed(new Uint8Array(key));
}

let liveWallet = null;
let liveWalletError = "";
try {
  if (CONFIG.WALLET_KEY) {
    const decoded = bs58.decode(CONFIG.WALLET_KEY.trim());
    if (decoded.length !== 64) throw new Error(`key is ${decoded.length} bytes, expected 64`);
    liveWallet = {
      secretKey: new Uint8Array(decoded),
      publicKeyBytes: new Uint8Array(decoded.slice(32)),
      publicKey: bs58.encode(decoded.slice(32)),
    };
  } else if (CONFIG.WALLET_SEED) {
    const kp = seedPhraseToKeypair(CONFIG.WALLET_SEED);
    liveWallet = {
      secretKey: kp.secretKey,
      publicKeyBytes: kp.publicKey,
      publicKey: bs58.encode(Buffer.from(kp.publicKey)),
    };
  }
} catch (e) {
  liveWalletError = `wallet config invalid (${e.message})`;
}

function signTransactionBase64(b64) {
  const buf = Buffer.from(b64, "base64");
  let sigCount = 0, sizeBytes = 0;
  for (;;) {
    const b = buf[sizeBytes];
    sigCount |= (b & 0x7f) << (7 * sizeBytes);
    sizeBytes++;
    if ((b & 0x80) === 0) break;
  }
  const msgStart = sizeBytes + 64 * sigCount;
  const message = buf.slice(msgStart);

  let o = 0;
  if (message[o] & 0x80) o += 1;
  const numRequired = message[o]; o += 3;
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

  const sig = nacl.sign.detached(new Uint8Array(message), liveWallet.secretKey);
  Buffer.from(sig).copy(buf, sizeBytes + 64 * slot);
  return buf.toString("base64");
}

const liveReady = () => !!(liveWallet && CONFIG.JUP_KEY && RPC);
let liveArmed = false;
let disarmReason = "boot default — /arm?key=… when ready";

/* ── night window (UK) ──────────────────────────────────── */

function ukHour() {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London", hour: "2-digit", hour12: false,
    }).format(new Date())
  );
}
function nightWindow() {
  const h = ukHour();
  if (CONFIG.NIGHT_START === CONFIG.NIGHT_END) return false;
  if (CONFIG.NIGHT_START > CONFIG.NIGHT_END) return h >= CONFIG.NIGHT_START || h < CONFIG.NIGHT_END;
  return h >= CONFIG.NIGHT_START && h < CONFIG.NIGHT_END;
}

/* ── state ──────────────────────────────────────────────── */

const buysByMint = new Map();
const alerted = new Set();
const openPositions = new Map();
const settling = new Map();
const closedTrades = loadClosed(SIG_FILE, 400);
const recentBuys = [];
let webhookHits = 0;
const followDebug = [];

const followOpen = new Map();
const followClosed = loadClosed(FOLLOW_FILE, 400);

const liveOpen = new Map();
const liveClosed = loadClosed(LIVE_FILE, 300);
let liveDay = new Date().toISOString().slice(0, 10);
let liveDayPnl = liveClosed
  .filter((t) => new Date((t.closedAt || 0) * 1000).toISOString().slice(0, 10) === liveDay)
  .reduce((s, t) => s + (t.pnlSol || 0), 0);
let walletSol = null;

const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function liveStakeFor(fhpcSize) {
  if (!fhpcSize || fhpcSize <= 0) return { skip: "size unknown" };
  if (fhpcSize < CONFIG.FHPC_MIN) return { skip: `below conviction ${fhpcSize.toFixed(2)}` };
  const raw = fhpcSize * CONFIG.SIZE_RATIO;
  const stake = Math.min(CONFIG.LIVE_MAX, Math.max(CONFIG.LIVE_MIN, raw));
  return { stake: +stake.toFixed(3) };
}

/* ── pricing ────────────────────────────────────────────── */

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

const priceCache = new Map();
async function fetchPriceSol(mint) {
  const c = priceCache.get(mint);
  if (c && Date.now() - c.at < 10_000) return c.px;
  let px = null;
  try { px = await priceFromDexscreener(mint); } catch {}
  if (!px) {
    await sleep(400);
    try { px = await priceFromGecko(mint); } catch {}
  }
  if (px) priceCache.set(mint, { px, at: Date.now() });
  return px;
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

async function getTokenDecimals(mint) {
  try {
    const r = await rpcCall("getTokenSupply", [mint]);
    return Number(r.value?.decimals ?? 6);
  } catch { return 6; }
}

/* ── Jupiter Ultra ──────────────────────────────────────── */

async function ultraSwap(inputMint, outputMint, rawAmount, slippagePct) {
  const slippageBps = Math.round(slippagePct * 10_000);
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
  sendTelegram(`🛑 <b>LIVE DISARMED</b> — ${reason}.`);
  console.log(`LIVE DISARMED: ${reason}`);
}

function liveMult(pos, px) {
  if (!px || !pos.tokensUi || pos.solIn <= 0) return null;
  return (px * pos.tokensUi) / pos.solIn;
}

async function executeLiveBuy(mint, stakeSol, tag) {
  rolloverLiveDay();
  if (!liveArmed) return;
  if (nightWindow()) { console.log(`LIVE skip ${mint} — night window`); return; }
  if (liveOpen.size >= CONFIG.LIVE_MAX_OPEN) {
    console.log(`LIVE skip ${mint} — ${liveOpen.size} positions already open`);
    return;
  }
  const rawIn = Math.round(stakeSol * LAMPORTS);
  try {
    const exec = await ultraSwap(SOL_MINT, mint, rawIn, CONFIG.LIVE_BUY_SLIP);
    const solIn = Number(exec.inputAmountResult ?? rawIn) / LAMPORTS;
    const tokensRaw = String(exec.outputAmountResult ?? "0");
    const dec = await getTokenDecimals(mint);
    const tokensUi = Number(tokensRaw) / Math.pow(10, dec);
    liveOpen.set(mint, {
      mint, solIn, tokensRaw, tokensUi, sig: exec.signature || "",
      openedAt: now(), status: "open", tag,
      livePeakMult: 1, liveTrailArmed: false,
    });
    sendTelegram(
      `🔴 <b>LIVE BUY</b> ${solIn.toFixed(4)} SOL (${tag})\n\n<code>${mint}</code>\n` +
      `📊 dexscreener.com/solana/${mint}\n🔎 solscan.io/tx/${exec.signature || ""}`
    );
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

    const exec = await ultraSwap(mint, SOL_MINT, raw.toString(), CONFIG.LIVE_SELL_SLIP);
    const solOut = Number(exec.outputAmountResult ?? 0) / LAMPORTS;
    const pnlSol = +(solOut - pos.solIn).toFixed(4);
    const mult = pos.solIn > 0 ? +(solOut / pos.solIn).toFixed(3) : 0;

    liveOpen.delete(mint);
    const rec = {
      mint, solIn: pos.solIn, solOut: +solOut.toFixed(4), pnlSol, mult,
      peakMult: +(pos.livePeakMult || 1).toFixed(2),
      reason, tag: pos.tag || "", sigBuy: pos.sig, sigSell: exec.signature || "",
      closedAt: now(), stuck: false,
    };
    liveClosed.push(rec);
    appendClosed(LIVE_FILE, rec);
    while (liveClosed.length > 300) liveClosed.shift();
    liveDayPnl += pnlSol;

    const emoji = pnlSol >= 0 ? "✅" : "🔻";
    sendTelegram(
      `${emoji} <b>LIVE SELL</b> (${reason})\n\n<code>${mint}</code>\n` +
      `${mult}x (peak ${(pos.livePeakMult || 1).toFixed(2)}x) · ${pnlSol >= 0 ? "+" : ""}${pnlSol} SOL\n` +
      `Day: ${liveDayPnl >= 0 ? "+" : ""}${liveDayPnl.toFixed(4)} SOL\n🔎 solscan.io/tx/${exec.signature || ""}`
    );

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
      `Sell failed 4x: ${e.message}\nSell it manually, then /clear-stuck?key=…&mint=${mint}`
    );
  }
}

/* ── follow engine ──────────────────────────────────────── */

async function openFollow(wallet, mint, sizeSol) {
  if (followOpen.has(mint)) return;
  const paperOnly = isPaperOnly(wallet);
  const px = await fetchPriceSol(mint);
  if (!px) { console.log(`FOLLOW skip ${mint} — no entry price`); return; }
  const entryPrice = px * (1 + CONFIG.SLIPPAGE);
  const tokens = CONFIG.FOLLOW_PAPER_SOL / entryPrice;
  followOpen.set(mint, {
    mint, wallet, entryPrice, tokens, theirSize: sizeSol || 0, paperOnly,
    openedAt: now(), peakPrice: px, trailArmed: false,
  });
  const goingLive = CONFIG.FOLLOW_LIVE && !paperOnly;
  sendTelegram(
    `👣 <b>FOLLOW</b> ${short(wallet)} bought ${sizeSol ? sizeSol.toFixed(2) : "?"} SOL\n\n<code>${mint}</code>\n` +
    `paper in ${CONFIG.FOLLOW_PAPER_SOL} SOL${goingLive ? ` · live in ${CONFIG.FOLLOW_POSITION_SOL} SOL` : paperOnly ? " · PAPER ONLY wallet" : " · live OFF"}\n📊 dexscreener.com/solana/${mint}`
  );
  if (goingLive) executeLiveBuy(mint, CONFIG.FOLLOW_POSITION_SOL, `follow ${short(wallet)}`);
}

function closeFollow(mint, reason, exitRaw, unpriced = false) {
  const pos = followOpen.get(mint);
  if (!pos) return;
  followOpen.delete(mint);
  const exitPrice = unpriced ? 0 : exitRaw * (1 - CONFIG.SLIPPAGE);
  const proceeds = pos.tokens * exitPrice;
  const pnlSol = unpriced ? 0 : +(proceeds - CONFIG.FOLLOW_PAPER_SOL).toFixed(4);
  const mult = !unpriced && pos.entryPrice > 0 ? +(exitPrice / pos.entryPrice).toFixed(3) : 0;
  const rec = {
    mint, wallet: pos.wallet, reason, paperOnly: !!pos.paperOnly,
    heldMin: Math.round((now() - pos.openedAt) / 60),
    mult, peakMult: pos.entryPrice > 0 ? +(pos.peakPrice / pos.entryPrice).toFixed(2) : 0,
    pnlSol, theirSize: pos.theirSize, closedAt: now(), unpriced,
  };
  followClosed.push(rec);
  appendClosed(FOLLOW_FILE, rec);
  while (followClosed.length > 400) followClosed.shift();
  const emoji = pnlSol >= 0 ? "✅" : "🔻";
  sendTelegram(`${emoji} <b>FOLLOW CLOSE</b> (${reason}) ${mult}x · paper ${pnlSol >= 0 ? "+" : ""}${pnlSol} SOL\n<code>${mint}</code>`);
}

async function closeFollowWithPrice(mint, reason) {
  const px = await fetchPriceSol(mint);
  closeFollow(mint, reason, px || 0, !px);
}

/* ── books ──────────────────────────────────────────────── */

function stats() {
  const priced = closedTrades.filter((t) => !t.unpriced);
  const wins = priced.filter((t) => t.pnlSol > 0).length;
  const totalPnl = priced.reduce((s, t) => s + t.pnlSol, 0);
  return {
    open: openPositions.size, settling: settling.size,
    closed: priced.length, unpriced: closedTrades.length - priced.length,
    wins, losses: priced.length - wins,
    winRate: priced.length ? Math.round((wins / priced.length) * 100) : 0,
    totalPnlSol: +totalPnl.toFixed(4),
  };
}

function followStatsFor(filterFn) {
  const priced = followClosed.filter((t) => !t.unpriced && filterFn(t));
  const wins = priced.filter((t) => t.pnlSol > 0).length;
  const totalPnl = priced.reduce((s, t) => s + t.pnlSol, 0);
  return {
    closed: priced.length, wins,
    winRate: priced.length ? Math.round((wins / priced.length) * 100) : 0,
    totalPnlSol: +totalPnl.toFixed(4),
  };
}

function perWalletStats() {
  const out = [];
  for (const w of CONFIG.FOLLOW_WALLETS) {
    const s = followStatsFor((t) => t.wallet === w);
    out.push({ wallet: w, paperOnly: isPaperOnly(w), ...s,
      open: [...followOpen.values()].filter((p) => p.wallet === w).length });
  }
  return out;
}

function liveStats() {
  const done = liveClosed.filter((t) => !t.stuck);
  const wins = done.filter((t) => t.pnlSol > 0).length;
  const totalPnl = done.reduce((s, t) => s + t.pnlSol, 0);
  const feesEst = +(done.length * CONFIG.LIVE_FEE_EST).toFixed(4);
  return {
    open: liveOpen.size, closed: done.length, wins,
    winRate: done.length ? Math.round((wins / done.length) * 100) : 0,
    totalPnlSol: +totalPnl.toFixed(4),
    feesEst,
    netSol: +(totalPnl - feesEst).toFixed(4),
    netGbp: +((totalPnl - feesEst) * CONFIG.SOL_GBP).toFixed(2),
    dayPnl: +liveDayPnl.toFixed(4),
  };
}

async function openPosition(mint, gap, firstW, secondW, fhpcSize, liveNote) {
  const px = await fetchPriceSol(mint);
  if (!px) { console.log(`SKIP ${mint} — no entry price`); return; }
  const entryPrice = px * (1 + CONFIG.SLIPPAGE);
  const tokens = CONFIG.POSITION_SOL / entryPrice;
  openPositions.set(mint, {
    mint, entryPrice, tokens, gap,
    openedAt: now(), first: firstW, second: secondW,
    peakPrice: px, fhpcSize, trailArmed: false, liveNote,
  });
}

function finalizeTrade(pos, reason, exitRaw, unpriced = false) {
  const exitPrice = unpriced ? 0 : exitRaw * (1 - CONFIG.SLIPPAGE);
  const proceeds = pos.tokens * exitPrice;
  const pnlSol = unpriced ? 0 : proceeds - CONFIG.POSITION_SOL;
  const mult = !unpriced && pos.entryPrice > 0 ? exitPrice / pos.entryPrice : 0;
  const heldMin = Math.round((now() - pos.openedAt) / 60);
  const peakMult = pos.entryPrice > 0 ? +(pos.peakPrice / pos.entryPrice).toFixed(2) : 0;

  const rec = {
    mint: pos.mint, reason, heldMin,
    entryPrice: pos.entryPrice, exitPrice,
    mult: +mult.toFixed(3), peakMult, pnlSol: +pnlSol.toFixed(4),
    closedAt: now(), gap: pos.gap, unpriced,
    fhpcSize: pos.fhpcSize || null, liveNote: pos.liveNote || "",
  };
  closedTrades.push(rec);
  appendClosed(SIG_FILE, rec);
  while (closedTrades.length > 400) closedTrades.shift();
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

/* FAST loop (15s) */
setInterval(async () => {
  const tNow = now();
  const nomoCutoff = tNow - CONFIG.NOMO_MIN * 60;

  for (const [mint, pos] of [...openPositions]) {
    const px = await fetchPriceSol(mint);
    if (!px) continue;
    if (px > pos.peakPrice) pos.peakPrice = px;
    const peakMult = pos.peakPrice / pos.entryPrice;
    const curMult = px / pos.entryPrice;

    if (!pos.trailArmed && peakMult >= CONFIG.TRAIL_ARM) pos.trailArmed = true;

    if (pos.trailArmed && px <= pos.peakPrice * (1 - CONFIG.TRAIL_RETRACE)) {
      await closePosition(mint, "trail stop");
      if (liveOpen.has(mint)) liveSell(mint, "trail stop");
      continue;
    }
    if (!pos.trailArmed && peakMult >= CONFIG.MICRO_ARM &&
        px <= pos.peakPrice * (1 - CONFIG.MICRO_RETRACE)) {
      await closePosition(mint, "micro trail");
      if (liveOpen.has(mint)) liveSell(mint, "micro trail");
      continue;
    }
    if (peakMult < CONFIG.NOMO_PEAK && curMult < CONFIG.NOMO_EXIT && pos.openedAt < nomoCutoff) {
      await closePosition(mint, "no-momentum cut");
      if (liveOpen.has(mint)) liveSell(mint, "no-momentum cut");
    }
  }

  for (const [mint, pos] of [...followOpen]) {
    const px = await fetchPriceSol(mint);
    if (!px) continue;
    if (px > pos.peakPrice) pos.peakPrice = px;
    const peakMult = pos.peakPrice / pos.entryPrice;
    if (!pos.trailArmed && peakMult >= CONFIG.TRAIL_ARM) pos.trailArmed = true;
    if (pos.trailArmed && px <= pos.peakPrice * (1 - CONFIG.TRAIL_RETRACE)) {
      closeFollow(mint, "trail stop", px);
      if (liveOpen.has(mint)) liveSell(mint, "trail stop");
    }
  }

  for (const [mint, pos] of [...liveOpen]) {
    if (pos.status !== "open") continue;
    const px = await fetchPriceSol(mint);
    const m = liveMult(pos, px);
    if (m === null) continue;
    if (m > pos.livePeakMult) pos.livePeakMult = m;
    if (!pos.liveTrailArmed && pos.livePeakMult >= CONFIG.TRAIL_ARM) pos.liveTrailArmed = true;
    if (pos.liveTrailArmed && m <= pos.livePeakMult * (1 - CONFIG.TRAIL_RETRACE)) {
      liveSell(mint, "trail stop");
    }
  }
}, 15_000);

/* slow sweep (60s) */
setInterval(async () => {
  const tNow = now();
  const holdCutoff = tNow - CONFIG.MAX_HOLD_MIN * 60;
  const trailHoldCutoff = tNow - CONFIG.TRAIL_MAX_HOLD_MIN * 60;
  const corpseCutoff = tNow - CONFIG.CORPSE_MIN * 60;
  const fCorpseCutoff = tNow - CONFIG.FOLLOW_CORPSE_MIN * 60;
  const fHoldCutoff = tNow - CONFIG.FOLLOW_MAX_HOLD_MIN * 60;

  for (const [mint, pos] of [...openPositions]) {
    const px = await fetchPriceSol(mint);
    if (px && px > pos.peakPrice) pos.peakPrice = px;
    const isCorpse = px !== null && pos.openedAt < corpseCutoff &&
      px < pos.entryPrice * CONFIG.CORPSE_MULT;
    const cutoff = pos.trailArmed ? trailHoldCutoff : holdCutoff;
    if (isCorpse) {
      await closePosition(mint, "corpse cut");
      if (liveOpen.has(mint)) liveSell(mint, "corpse cut");
    } else if (pos.openedAt < cutoff) {
      await closePosition(mint, pos.trailArmed ? "runner backstop" : "timeout");
      if (liveOpen.has(mint)) liveSell(mint, pos.trailArmed ? "runner backstop" : "timeout");
    }
  }

  for (const [mint, pos] of [...followOpen]) {
    const px = await fetchPriceSol(mint);
    if (px && px > pos.peakPrice) pos.peakPrice = px;
    const isCorpse = px !== null && pos.openedAt < fCorpseCutoff &&
      px < pos.entryPrice * CONFIG.FOLLOW_CORPSE_MULT;
    if (isCorpse) {
      closeFollow(mint, "corpse cut", px);
      if (liveOpen.has(mint)) liveSell(mint, "corpse cut");
    } else if (pos.openedAt < fHoldCutoff) {
      await closeFollowWithPrice(mint, "hold timeout");
      if (liveOpen.has(mint)) liveSell(mint, "hold timeout");
    }
  }

  for (const [mint, pos] of [...liveOpen]) {
    if (pos.status !== "open") continue;
    if (openPositions.has(mint) || followOpen.has(mint)) continue;
    const px = await fetchPriceSol(mint);
    const m = liveMult(pos, px);
    const isFollow = (pos.tag || "").startsWith("follow");
    const cCut = isFollow ? fCorpseCutoff : corpseCutoff;
    const cMult = isFollow ? CONFIG.FOLLOW_CORPSE_MULT : CONFIG.CORPSE_MULT;
    const hCut = isFollow ? fHoldCutoff : (pos.liveTrailArmed ? trailHoldCutoff : holdCutoff);
    if (m !== null && pos.openedAt < cCut && m < cMult) {
      liveSell(mint, "corpse cut");
    } else if (pos.openedAt < hCut) {
      liveSell(mint, isFollow ? "hold timeout" : "timeout");
    }
  }

  walletSol = await getWalletSol();
  if (liveArmed && walletSol !== null && walletSol < CONFIG.LIVE_MIN_WALLET) {
    disarm(`wallet below floor (${walletSol.toFixed(3)} < ${CONFIG.LIVE_MIN_WALLET} SOL)`);
  }

  const c = tNow - CONFIG.WINDOW * 2;
  for (const [mint, wallets] of buysByMint) {
    for (const [w, e] of wallets) if (e.ts < c) wallets.delete(w);
    if (!wallets.size) buysByMint.delete(mint);
  }
  while (recentBuys.length > 100) recentBuys.shift();
}, 60_000);

/* ── webhook handling ───────────────────────────────────── */

function txSizeSol(tx, wallet) {
  const transfers = tx.tokenTransfers || [];
  const swap = tx.events && tx.events.swap;
  const cands = [0];

  const nativeSpent = (tx.nativeTransfers || [])
    .filter((t) => t.fromUserAccount === wallet)
    .reduce((s, t) => s + Number(t.amount || 0), 0);
  cands.push(nativeSpent / LAMPORTS);

  cands.push(transfers
    .filter((t) => t.fromUserAccount === wallet && t.mint === SOL_MINT)
    .reduce((s, t) => s + Math.abs(Number(t.tokenAmount || 0)), 0));

  if (swap) {
    cands.push(Number(swap.nativeInput?.amount || 0) / LAMPORTS);
    let wsolIn = 0;
    for (const i of swap.tokenInputs || []) {
      if (i.mint !== SOL_MINT) continue;
      const r = i.rawTokenAmount;
      if (r && r.tokenAmount != null) {
        wsolIn += Math.abs(Number(r.tokenAmount)) / Math.pow(10, Number(r.decimals ?? 9));
      } else if (i.tokenAmount != null) {
        wsolIn += Math.abs(Number(i.tokenAmount));
      }
    }
    cands.push(wsolIn);
  }

  if (tx.feePayer === wallet) {
    let biggest = 0;
    for (const t of transfers) {
      if (t.mint !== SOL_MINT) continue;
      const a = Math.abs(Number(t.tokenAmount || 0));
      if (a > biggest) biggest = a;
    }
    cands.push(biggest);

    let adWsol = 0;
    for (const ad of tx.accountData || []) {
      for (const tb of ad.tokenBalanceChanges || []) {
        if (tb.mint !== SOL_MINT) continue;
        const r = tb.rawTokenAmount;
        const a = r && r.tokenAmount != null
          ? Math.abs(Number(r.tokenAmount)) / Math.pow(10, Number(r.decimals ?? 9))
          : 0;
        if (a > adWsol) adWsol = a;
      }
    }
    cands.push(adWsol);
  }

  const size = Math.max(...cands.filter((n) => Number.isFinite(n)));
  return size > 0 ? size : 0;
}

function extractBuy(tx, wallet) {
  const transfers = tx.tokenTransfers || [];
  const nativeSpent = (tx.nativeTransfers || [])
    .filter((t) => t.fromUserAccount === wallet)
    .reduce((s, t) => s + Number(t.amount || 0), 0);
  const paidNative = nativeSpent > 1_000_000;
  const paidToken = transfers.some(
    (t) => t.fromUserAccount === wallet && QUOTE_MINTS.has(t.mint)
  );
  const paid = paidNative || paidToken;
  const swap = tx.events && tx.events.swap;
  const sizeSol = txSizeSol(tx, wallet);

  const direct = transfers.find(
    (t) => t.toUserAccount === wallet && t.mint && !QUOTE_MINTS.has(t.mint)
  );
  if (direct && paid) return { mint: direct.mint, sizeSol };

  if (swap && tx.feePayer === wallet) {
    const outs = (swap.tokenOutputs || []).filter((o) => o.mint && !QUOTE_MINTS.has(o.mint));
    const soldNonQuote = (swap.tokenInputs || []).some((i) => i.mint && !QUOTE_MINTS.has(i.mint));
    if (outs.length && !soldNonQuote) return { mint: outs[0].mint, sizeSol };
  }

  if (tx.feePayer === wallet && paid) {
    const routed = transfers.find(
      (t) => t.mint && !QUOTE_MINTS.has(t.mint) && t.fromUserAccount !== wallet
    );
    if (routed) return { mint: routed.mint, sizeSol };
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

function recordBuy(wallet, mint, ts, sizeSol, monitorOnly) {
  recentBuys.push({ ts, wallet, mint, sizeSol });
  if (!buysByMint.has(mint)) buysByMint.set(mint, new Map());
  const wallets = buysByMint.get(mint);
  if (!wallets.has(wallet)) wallets.set(wallet, { ts, sizeSol });

  if (monitorOnly) return;
  if (alerted.has(mint)) return;

  const entries = [...wallets.entries()]
    .filter(([w]) => CONFIG.WATCH_WALLETS.includes(w))
    .filter(([, e]) => ts - e.ts <= CONFIG.WINDOW);
  if (entries.length >= 2) {
    alerted.add(mint);
    entries.sort((a, b) => a[1].ts - b[1].ts);
    const gap = entries[entries.length - 1][1].ts - entries[0][1].ts;
    const fhpcEntry = wallets.get(FHPC);
    const fhpcSize = fhpcEntry ? fhpcEntry.sizeSol : null;
    const sized = liveStakeFor(fhpcSize);
    const liveNote = sized.skip ? `live skip: ${sized.skip}` : `live ${sized.stake} SOL`;
    openPosition(mint, gap, entries[0][0], entries[entries.length - 1][0], fhpcSize, liveNote);
    if (!sized.skip) executeLiveBuy(mint, sized.stake, "confluence");
  }
}

function handleWebhookPayload(payload) {
  const txs = Array.isArray(payload) ? payload : [payload];
  for (const tx of txs) {
    if (!tx || !tx.signature) continue;
    const ts = tx.timestamp || now();

    try {
      const raw = JSON.stringify(tx);
      for (const fw of CONFIG.FOLLOW_WALLETS) {
        if (raw.includes(fw)) {
          followDebug.push({ at: new Date().toISOString(), tx });
          while (followDebug.length > 5) followDebug.shift();
          break;
        }
      }
    } catch {}

    for (const wallet of CONFIG.FOLLOW_WALLETS) {
      const buy = extractBuy(tx, wallet);
      if (buy) { openFollow(wallet, buy.mint, buy.sizeSol || 0); continue; }
      const sell = extractSell(tx, wallet);
      if (sell && followOpen.has(sell.mint)) {
        const pos = followOpen.get(sell.mint);
        if (pos.wallet === wallet) {
          closeFollowWithPrice(sell.mint, `${short(wallet)} sold`);
          if (liveOpen.has(sell.mint)) liveSell(sell.mint, `${short(wallet)} sold`);
        }
      }
    }

    for (const wallet of CONFIG.WATCH_WALLETS) {
      const buy = extractBuy(tx, wallet);
      if (buy) { recordBuy(wallet, buy.mint, ts, buy.sizeSol || 0, false); continue; }
      const sell = extractSell(tx, wallet);
      if (sell) {
        if (openPositions.has(sell.mint)) closePosition(sell.mint, `${short(wallet)} sold`);
        if (liveOpen.has(sell.mint)) liveSell(sell.mint, `${short(wallet)} sold`);
      }
    }
    for (const wallet of CONFIG.MONITOR_WALLETS) {
      const buy = extractBuy(tx, wallet);
      if (buy) recordBuy(wallet, buy.mint, ts, buy.sizeSol || 0, true);
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
  const allFollow = followStatsFor(() => true);
  const liveFollow = followStatsFor((t) => !t.paperOnly);
  const paperFollow = followStatsFor((t) => t.paperOnly);
  const ls = liveStats();
  const night = nightWindow();
  const fmtAgo = (ts) => {
    const d = now() - ts;
    if (d < 60) return `${d}s ago`;
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    return `${Math.floor(d / 3600)}h ago`;
  };

  let liveBanner;
  if (liveArmed && night) {
    liveBanner = `<div class="banner ready">🌙 LIVE armed but PAUSED — night window ${CONFIG.NIGHT_START}:00-${CONFIG.NIGHT_END}:00 UK.</div>`;
  } else if (liveArmed) {
    liveBanner = `<div class="banner armed">🔴 LIVE ARMED — follow live ${CONFIG.FOLLOW_LIVE ? `ON (${CONFIG.FOLLOW_POSITION_SOL} SOL/trade)` : "OFF (paper only)"}${CONFIG.PAPER_ONLY_WALLETS.length ? ` · ${CONFIG.PAPER_ONLY_WALLETS.length} wallet(s) paper-only` : ""} · day ${ls.dayPnl >= 0 ? "+" : ""}${ls.dayPnl} SOL · cap −${CONFIG.LIVE_MAX_DAILY_LOSS} · floor ${CONFIG.LIVE_MIN_WALLET} · wallet ${walletSol === null ? "?" : walletSol.toFixed(3)} SOL</div>`;
  } else if (liveReady()) {
    liveBanner = `<div class="banner ready">⚪️ Live engine ready, DISARMED (${esc(disarmReason)}) · wallet ${walletSol === null ? "?" : walletSol.toFixed(3)} SOL · arm via /arm?key=…</div>`;
  } else {
    const missing = [];
    if (!liveWallet) missing.push(liveWalletError || "WALLET_PRIVATE_KEY or WALLET_SEED_PHRASE");
    if (!CONFIG.JUP_KEY) missing.push("JUPITER_API_KEY");
    if (!RPC) missing.push("HELIUS_API_KEY");
    liveBanner = `<div class="banner off">⚪️ Live engine not configured — missing: ${esc(missing.join(", "))}.</div>`;
  }

  const persistBanner = persistOk ? "" :
    `<div class="banner off">⚠️ History NOT persisting — mount a Railway volume at ${esc(CONFIG.DATA_DIR)}.</div>`;

  const walletRows = perWalletStats().map((w) => `<li class="row ${w.paperOnly ? "flat" : "follow"}"><div class="body">
      <div class="head"><span class="sym">${esc(short(w.wallet))}${w.paperOnly ? " · paper only" : ""}</span>
        <span class="x" style="color:${w.totalPnlSol >= 0 ? "var(--cyan)" : "var(--clay)"}">${w.totalPnlSol >= 0 ? "+" : ""}${w.totalPnlSol}</span></div>
      <div class="meta">${w.closed} closed · ${w.winRate}% win · ${w.open} open</div>
    </div></li>`).join("");

  const followOpenRows = [...followOpen.values()].map((p) => {
    const cached = priceCache.get(p.mint);
    const m = cached ? cached.px / p.entryPrice : null;
    const peakX = (p.peakPrice / p.entryPrice).toFixed(2);
    return `<li class="row ${p.paperOnly ? "flat" : "follow"}"><div class="body">
      <div class="head"><span class="sym">${esc(short(p.mint))}</span><span class="x">${m ? `${m.toFixed(2)}x · ` : ""}peak ${peakX}x${p.trailArmed ? " · 🎯" : ""}</span></div>
      <div class="meta">${esc(short(p.wallet))}${p.paperOnly ? " (paper only)" : ""} in ${p.theirSize ? p.theirSize.toFixed(2) : "?"} SOL · opened ${fmtAgo(p.openedAt)}</div>
      <div class="meta mono">${esc(p.mint)}</div>
    </div></li>`;
  }).join("");

  const followTradeRows = [...followClosed].reverse().slice(0, 40).map((t) => {
    const cls = t.unpriced ? "flat" : t.pnlSol >= 0 ? "win" : "loss";
    return `<li class="row ${cls}"><div class="body">
      <div class="head"><span class="sym">${esc(short(t.mint))}</span><span class="x">${t.unpriced ? "unpriced" : `${t.mult}x (pk ${t.peakMult}x) · ${t.pnlSol >= 0 ? "+" : ""}${t.pnlSol}`}</span></div>
      <div class="meta">${fmtAgo(t.closedAt)} · held ${t.heldMin}m · ${esc(t.reason)} · ${esc(short(t.wallet))}${t.paperOnly ? " (paper only)" : ""}</div>
      <div class="meta mono">${esc(t.mint)}</div>
    </div></li>`;
  }).join("");

  const liveOpenRows = [...liveOpen.values()].map((p) => {
    const cached = priceCache.get(p.mint);
    const m = cached ? liveMult(p, cached.px) : null;
    const multStr = m ? `${m.toFixed(2)}x (pk ${p.livePeakMult.toFixed(2)}x)` : `pk ${p.livePeakMult.toFixed(2)}x`;
    return `<li class="row ${p.status === "stuck" ? "loss" : "live"}"><div class="body">
      <div class="head"><span class="sym">${esc(short(p.mint))}</span><span class="x">${p.status === "stuck" ? "STUCK — sell manually" : `${multStr}${p.liveTrailArmed ? " · 🎯" : ""} · ${p.solIn.toFixed(3)} in`}</span></div>
      <div class="meta">${esc(p.tag || "")} · opened ${fmtAgo(p.openedAt)} · <a href="https://solscan.io/tx/${esc(p.sig)}">buy tx</a></div>
      <div class="meta mono">${esc(p.mint)}</div>
    </div></li>`;
  }).join("");

  const liveTradeRows = [...liveClosed].reverse().slice(0, 40).map((t) => {
    const cls = t.pnlSol >= 0 ? "win" : "loss";
    return `<li class="row ${cls}"><div class="body">
      <div class="head"><span class="sym">${esc(short(t.mint))}</span>
        <span class="x">${t.mult ? `${t.mult}x (pk ${t.peakMult}x) · ` : ""}${t.pnlSol >= 0 ? "+" : ""}${t.pnlSol} SOL</span></div>
      <div class="meta">${fmtAgo(t.closedAt)} · ${esc(t.reason)}${t.tag ? ` · ${esc(t.tag)}` : ""} · in ${t.solIn.toFixed(3)} → out ${t.solOut.toFixed(3)}</div>
      <div class="meta mono">${esc(t.mint)}</div>
    </div></li>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Follow Trader</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<meta http-equiv="refresh" content="30">
<style>
  :root{--ground:#12151F;--panel:#1A1F2E;--edge:#2A3145;--amber:#E8A33D;--cyan:#4DD0C7;--slate:#6B7489;--clay:#C4574A;--ink:#E4E7EF;--red:#E5484D;--violet:#9B8CFF}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--ground);color:var(--ink);font-family:'IBM Plex Mono',monospace;font-size:13px;line-height:1.5;padding:20px 16px 60px}
  h1{font-family:'Space Grotesk',sans-serif;font-size:24px;margin-bottom:4px}
  h1 em{font-style:normal;color:var(--violet)}
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
  h2.dim{color:var(--slate)}
  ul{list-style:none}
  .row{background:var(--panel);border:1px solid var(--edge);border-left:2px solid var(--slate);padding:11px 12px;margin-bottom:8px}
  .row.follow{border-left-color:var(--violet)}
  .row.live{border-left-color:var(--red)}
  .row.win{border-left-color:var(--cyan)}
  .row.loss{border-left-color:var(--clay)}
  .row.flat{border-left-color:var(--edge)}
  .head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px}
  .sym{font-weight:600}
  .x{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:14px}
  .row.win .x{color:var(--cyan)}
  .row.loss .x{color:var(--clay)}
  .row.follow .x{color:var(--violet)}
  .row.live .x{color:var(--red)}
  .row.flat .x{color:var(--slate)}
  .meta{color:var(--slate);font-size:10.5px;margin-top:2px}
  .meta a{color:var(--slate)}
  .mono{word-break:break-all;font-size:9.5px}
  .none{color:var(--slate);font-size:12px;padding:12px;background:var(--panel);border:1px dashed var(--edge)}
</style></head><body>
  <h1>Follow <em>trader</em></h1>
  <div class="sub">
    v5.1 · following ${CONFIG.FOLLOW_WALLETS.map((w) => esc(short(w)) + (isPaperOnly(w) ? "(p)" : "")).join(" + ")} ·
    follow live ${CONFIG.FOLLOW_LIVE ? "ON" : "OFF"} · (p) = paper only ·
    exits: their sell · trail ${CONFIG.TRAIL_ARM}x/−${CONFIG.TRAIL_RETRACE * 100}% · corpse ≤${CONFIG.FOLLOW_CORPSE_MULT}x@${CONFIG.FOLLOW_CORPSE_MIN}m · ${Math.round(CONFIG.FOLLOW_MAX_HOLD_MIN / 60)}h max ·
    ${persistOk ? "history saved ✓" : "HISTORY NOT SAVED"} · <a href="/book.csv" style="color:var(--cyan)">book.csv</a> ·
    night ${CONFIG.NIGHT_START}:00-${CONFIG.NIGHT_END}:00 ·
    ${webhookHits} hits · ${CONFIG.TG_TOKEN ? "telegram ✓" : "TELEGRAM NOT SET"}
  </div>
  ${persistBanner}
  ${liveBanner}
  <h2>Follow book — paper (${CONFIG.FOLLOW_PAPER_SOL} SOL stakes)</h2>
  <div class="cards">
    <div class="card"><b style="color:${allFollow.totalPnlSol >= 0 ? "var(--cyan)" : "var(--clay)"}">${allFollow.totalPnlSol >= 0 ? "+" : ""}${allFollow.totalPnlSol}</b><span>all wallets</span></div>
    <div class="card"><b style="color:${liveFollow.totalPnlSol >= 0 ? "var(--cyan)" : "var(--clay)"}">${liveFollow.totalPnlSol >= 0 ? "+" : ""}${liveFollow.totalPnlSol}</b><span>live-eligible</span></div>
    <div class="card"><b style="color:${paperFollow.totalPnlSol >= 0 ? "var(--cyan)" : "var(--clay)"}">${paperFollow.totalPnlSol >= 0 ? "+" : ""}${paperFollow.totalPnlSol}</b><span>paper-only</span></div>
    <div class="card"><b>${allFollow.winRate}%</b><span>win rate</span></div>
    <div class="card"><b>${allFollow.closed}</b><span>closed</span></div>
  </div>
  ${walletRows ? `<ul>${walletRows}</ul>` : ""}
  ${followOpenRows ? `<ul>${followOpenRows}</ul>` : `<div class="none">No open follows — waiting for a buy.</div>`}
  ${followTradeRows ? `<ul>${followTradeRows}</ul>` : `<div class="none">No closed follows yet.</div>`}
  ${liveReady() ? `
  <h2>Live book (real money)</h2>
  <div class="cards">
    <div class="card"><b style="color:${ls.netSol >= 0 ? "var(--cyan)" : "var(--clay)"}">${ls.netSol >= 0 ? "+" : ""}${ls.netSol}</b><span>net SOL (fees −${ls.feesEst})</span></div>
    <div class="card"><b style="color:${ls.netGbp >= 0 ? "var(--cyan)" : "var(--clay)"}">£${ls.netGbp}</b><span>net GBP</span></div>
    <div class="card"><b>${ls.winRate}%</b><span>win rate</span></div>
    <div class="card"><b>${ls.closed}</b><span>closed</span></div>
    <div class="card"><b>${ls.open}</b><span>open</span></div>
  </div>
  ${liveOpenRows ? `<ul>${liveOpenRows}</ul>` : ""}
  ${liveTradeRows ? `<ul>${liveTradeRows}</ul>` : `<div class="none">No live trades yet.</div>`}
  ` : ""}
</body></html>`;
}

/* ── server ─────────────────────────────────────────────── */

function urlParams(u) {
  const q = u.split("?")[1] || "";
  return Object.fromEntries(new URLSearchParams(q));
}

function csvEscape(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function bookCsv() {
  const sigAll = persistOk ? loadClosed(SIG_FILE, 100000) : closedTrades;
  const livAll = persistOk ? loadClosed(LIVE_FILE, 100000) : liveClosed;
  const folAll = persistOk ? loadClosed(FOLLOW_FILE, 100000) : followClosed;
  const rows = [["book","mint","closedAt","reason","heldMin","mult","peakMult","pnlSol","wallet","paperOnly","theirSize","solIn","solOut","tag"]];
  for (const t of folAll) rows.push(["follow", t.mint, t.closedAt, t.reason, t.heldMin, t.mult, t.peakMult, t.pnlSol, t.wallet, t.paperOnly ? "yes" : "no", t.theirSize, "", "", ""]);
  for (const t of livAll) rows.push(["live", t.mint, t.closedAt, t.reason, "", t.mult, t.peakMult, t.pnlSol, "", "", "", t.solIn, t.solOut, t.tag || ""]);
  for (const t of sigAll) rows.push(["signal", t.mint, t.closedAt, t.reason, t.heldMin, t.mult, t.peakMult, t.pnlSol, "", "", "", "", "", t.liveNote || ""]);
  return rows.map((r) => r.map(csvEscape).join(",")).join("\n");
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

  const path_ = req.url.split("?")[0];
  const params = urlParams(req.url);
  const keyOk = CONFIG.CONTROL_KEY && params.key === CONFIG.CONTROL_KEY;

  if (path_ === "/arm") {
    if (!keyOk) { res.writeHead(403); return res.end("bad key"); }
    if (!liveReady()) { res.writeHead(400); return res.end("live engine not configured"); }
    rolloverLiveDay();
    liveArmed = true; disarmReason = "";
    sendTelegram(`🔴 <b>LIVE ARMED</b> — follow live ${CONFIG.FOLLOW_LIVE ? `ON (${CONFIG.FOLLOW_POSITION_SOL}/trade)` : "OFF"}${CONFIG.PAPER_ONLY_WALLETS.length ? `, ${CONFIG.PAPER_ONLY_WALLETS.length} paper-only wallet(s)` : ""}, cap −${CONFIG.LIVE_MAX_DAILY_LOSS}, floor ${CONFIG.LIVE_MIN_WALLET}.`);
    res.writeHead(200); return res.end(`LIVE ARMED. Follow live: ${CONFIG.FOLLOW_LIVE ? "ON" : "OFF"}. Paper-only wallets: ${CONFIG.PAPER_ONLY_WALLETS.length}.`);
  }
  if (path_ === "/stop") {
    if (CONFIG.CONTROL_KEY && !keyOk) { res.writeHead(403); return res.end("bad key"); }
    disarm("stopped via /stop");
    res.writeHead(200); return res.end("LIVE DISARMED.");
  }
  if (path_ === "/clear-stuck") {
    if (!keyOk) { res.writeHead(403); return res.end("bad key"); }
    const m = params.mint;
    if (m && liveOpen.has(m)) { liveOpen.delete(m); res.writeHead(200); return res.end(`cleared ${m}`); }
    res.writeHead(404); return res.end("mint not found");
  }
  if (path_ === "/debug") {
    if (!keyOk) { res.writeHead(403); return res.end("bad key"); }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ count: followDebug.length, txs: followDebug }, null, 2));
  }
  if (path_ === "/book.csv") {
    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="follow-book.csv"',
    });
    return res.end(bookCsv());
  }

  if (path_ === "/health") { res.writeHead(200); return res.end("ok"); }
  if (path_ === "/test-alert") {
    sendTelegram("✅ Follow trader test — Telegram is wired up.");
    res.writeHead(200); return res.end("test sent");
  }
  if (path_ === "/book.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      follow: { perWallet: perWalletStats(), open: [...followOpen.values()], closed: followClosed },
      live: { armed: liveArmed, followLive: CONFIG.FOLLOW_LIVE, paperOnly: CONFIG.PAPER_ONLY_WALLETS, stats: liveStats(), open: [...liveOpen.values()], closed: liveClosed },
      signal: { stats: stats(), open: [...openPositions.values()], closed: closedTrades },
    }, null, 2));
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(renderPage());
});

server.listen(CONFIG.PORT, () => {
  console.log(`Follow trader v5.1 on ${CONFIG.PORT} — ${CONFIG.FOLLOW_WALLETS.length} followed (${CONFIG.PAPER_ONLY_WALLETS.length} paper-only), follow live ${CONFIG.FOLLOW_LIVE ? "ON" : "OFF"}`);
  if (liveWalletError) console.warn(liveWalletError);
});
