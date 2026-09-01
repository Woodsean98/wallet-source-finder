/**
 * WALLET HUNTER v13 — three ways to find a wallet
 * ----------------------------------------------------------------
 * v1-v9 all shared one architectural mistake: they found COINS, then read
 * each coin's transaction history to see who traded it. That meant every
 * wallet found was one that happened to trade a coin we picked (pick a coin
 * that pumped and every early buyer looks like a genius), and we could only
 * read coins whose whole history fits in the Helius page budget — which
 * excludes essentially every coin anyone actually trades. The numbers: 120
 * pools scanned, 0 readable. Coins with 60,000+ transactions need 600 pages.
 *
 * v10 went at it from the wallet end via Birdeye's PnL leaderboard. That
 * failed differently: ranking by absolute profit only ever surfaces MEV bots
 * (up to ~900,000 txs/day) and whales. Even Birdeye's non-bot `smart_trader`
 * tag returned wallets 79x-16,000x a 0.3 SOL stake. No ranking-based source
 * can reach a trader of that size, because size is what the ranking selects.
 *
 * So v13 carries THREE sources, none of which rank by profit:
 *
 *   1. CO-OCCURRENCE (the main one). Take wallets already trusted, find the
 *      coins they recently bought, read only recent pages of each coin near
 *      the seed's buy, and queue wallets appearing in several of them.
 *      Repeat co-occurrence is size-blind — a small trader who keeps turning
 *      up beside a good wallet ranks the same as a whale. First run turned
 *      724 neighbours into 31 candidates. Anything marked ✓ passed becomes a
 *      new seed, so the search widens the longer it runs.
 *
 *   2. /trace — for callers. People who post coin calls in Telegram buy
 *      BEFORE they post. Give /trace the coins someone called and it returns
 *      the wallets that bought several of them, with the timestamp and SOL
 *      size of every buy so the caller can be told apart from the snipers
 *      who front-run the same group. One coin has ~1,400 buyers; four coins
 *      in common has almost none.
 *
 *   3. Birdeye smart_trader — kept as a fallback when there is nothing
 *      trusted to mine from yet.
 *
 * Everything then flows through the same vetting engine, which is the part
 * that actually worked and which has agreed with GMGN on every wallet since
 * the FIFO fix: cheap pre-screen (2 Helius pages kills a bot for 2 calls
 * instead of 40), quantity-matched FIFO accounting, hard exclusions, 0-100
 * scoring, shortlist, and the /verdict feedback loop.
 *
 * It remains a SHORTLIST, not a verdict. It sees one address over 30 days;
 * operators who split flow across wallets still pass. Check every candidate
 * on GMGN and record pass/fail so the scoring learns which signals matter.
 *
 * This service NEVER trades. It only reads.
 */

import http from "http";
import fs from "fs";
import path from "path";

const CFG = {
  KEY: process.env.HELIUS_API_KEY || "",
  BIRDEYE_KEY: process.env.BIRDEYE_API_KEY || "",
  CONTROL_KEY: process.env.HUNTER_KEY || process.env.CONTROL_KEY || "",
  PORT: Number(process.env.PORT || 3000),
  CYCLE_MINUTES: Number(process.env.CYCLE_MINUTES || 20),
  DATA_DIR: process.env.DATA_DIR || "/data",

  /* wallets already verified on GMGN — never re-vetted, used for expansion */
  SEED_WALLETS: (process.env.SEED_WALLETS || "")
    .split(",").map((s) => s.trim()).filter(Boolean),

  /* ── Birdeye discovery ──
     The net-PnL leaderboard ranks by ABSOLUTE profit, so its top is MEV bots
     and market makers — measured at 909,474 txs/day and 337,273x the stake.
     Ranking by size can never surface someone trading GBP100 positions well.
     So v11 asks Birdeye for SMART TRADERS per token instead: their own tag,
     defined as a non-bot wallet in the top realised PnL over 90 days with
     over $10,000 realised, with bots excluded before ranking. */
  TOKENS_PER_CYCLE: Number(process.env.TOKENS_PER_CYCLE || 8),
  TRADERS_PER_TOKEN: Number(process.env.TRADERS_PER_TOKEN || 10),  // max 10
  TRADER_WINDOW: process.env.TRADER_WINDOW || "30d",
  TRADER_SORT: process.env.TRADER_SORT || "realized_pnl",
  WALLET_TAGS: process.env.WALLET_TAGS || "smart_trader",
  /* optional manual token list; when set, trending is not called */
  TOKENS: (process.env.TOKENS || "").split(",").map((s) => s.trim()).filter(Boolean),

  /* ── CO-OCCURRENCE (v12) ──
     Every ranking-based source selects for capital, so it only ever returns
     whales. This asks a different question entirely: which wallets keep
     turning up in the SAME coins as a wallet we already trust? Repeat
     co-occurrence is independent of size — a small trader who appears
     alongside a good wallet across several coins is exactly the target.
     Only RECENT pages of each coin are read, so it works on busy coins
     where full-history harvesting was impossible, and "traded near when my
     good wallet did" is a stronger signal than "traded this coin ever". */
  SEED_COIN_PAGES: Number(process.env.SEED_COIN_PAGES || 6),   // recent pages per seed wallet
  SEED_COINS: Number(process.env.SEED_COINS || 6),             // coins per seed wallet
  COOC_PAGES: Number(process.env.COOC_PAGES || 4),             // recent pages per coin
  COOC_WINDOW_H: Number(process.env.COOC_WINDOW_H || 48),      // +/- hours around seed's buy
  COOC_MIN_HITS: Number(process.env.COOC_MIN_HITS || 2),       // coins in common to qualify
  COOC_EVERY: Number(process.env.COOC_EVERY || 2),             // run every N cycles

  /* ── TRACE (v13) ──
     Callers in Telegram groups buy BEFORE they post. Give /trace the coins
     someone called and it returns the wallets that bought ALL of them. One
     coin has thousands of buyers; four coins in common has almost none, so
     the intersection is the caller (or their cluster). This is the same
     co-occurrence maths, aimed at coins you name rather than a seed's. */
  TRACE_PAGES: Number(process.env.TRACE_PAGES || 25),   // pages per coin
  TRACE_MAX_COINS: Number(process.env.TRACE_MAX_COINS || 8),
  BOARD_MIN_TRADES: Number(process.env.BOARD_MIN_TRADES || 20),
  BOARD_MIRROR_RATIO: Number(process.env.BOARD_MIRROR_RATIO || 50),

  /* ── screening budget ── */
  MAX_VET_PER_CYCLE: Number(process.env.MAX_VET_PER_CYCLE || 12),
  PRESCREEN_PAGES: Number(process.env.PRESCREEN_PAGES || 2),
  WALLET_PAGES: Number(process.env.WALLET_PAGES || 40),

  /* execution reality */
  MIN_LIQ_USD: Number(process.env.MIN_LIQ_USD || 30000),
  MY_STAKE_SOL: Number(process.env.MY_STAKE_SOL || 0.3),

  VET_DAYS: Number(process.env.VET_DAYS || 30),
  MIN_MATCHED: Number(process.env.MIN_MATCHED || 5),
  REVET_DAYS: Number(process.env.REVET_DAYS || 5),
  DORMANT_DAYS: Number(process.env.DORMANT_DAYS || 10),
  MAX_REVET_PER_CYCLE: Number(process.env.MAX_REVET_PER_CYCLE || 2),
  CLOSE_TOLERANCE: Number(process.env.CLOSE_TOLERANCE || 0.05),

  /* HARD exclusions */
  MAX_MINT_EVENTS: Number(process.env.MAX_MINT_EVENTS || 3),
  MAX_TXS_30D: Number(process.env.MAX_TXS_30D || 2500),
  MAX_TRANSFER_OUT_PCT: Number(process.env.MAX_TRANSFER_OUT_PCT || 15),
  HARD_MAX_SIZE_RATIO: Number(process.env.HARD_MAX_SIZE_RATIO || 20),
  HARD_MIN_VISIBLE_PCT: Number(process.env.HARD_MIN_VISIBLE_PCT || 30),
  MIN_DEPLOYED_SOL: Number(process.env.MIN_DEPLOYED_SOL || 3),
  MIN_HOLD_MIN: Number(process.env.MIN_HOLD_MIN || 10),

  /* shortlist */
  SHORTLIST_SIZE: Number(process.env.SHORTLIST_SIZE || 5),
  MIN_SCORE: Number(process.env.MIN_SCORE || 45),

  /* scoring weights */
  W_ROI: Number(process.env.W_ROI || 20),
  W_WIN: Number(process.env.W_WIN || 15),
  W_HOLD: Number(process.env.W_HOLD || 15),
  W_LIQ: Number(process.env.W_LIQ || 15),
  W_SIZE: Number(process.env.W_SIZE || 10),
  W_VISIBLE: Number(process.env.W_VISIBLE || 10),
  W_SAMPLE: Number(process.env.W_SAMPLE || 10),
  W_CONSISTENCY: Number(process.env.W_CONSISTENCY || 5),
};

const SOL_MINT = "So11111111111111111111111111111111111111112";
const QUOTES = new Set([SOL_MINT,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]);
const PROGRAMS = new Set([
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "ComputeBudget111111111111111111111111111111",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  "jitodontfront111111111111111111111nopainnogain",
]);
const MINT_TYPES = new Set(["TOKEN_MINT", "CREATE_POOL", "INITIALIZE_MINT"]);
const LAMPORTS = 1e9;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);
const DAY = 86400;

/* ── persistence ────────────────────────────────────────── */

let persistOk = false;
const DB_FILE = path.join(CFG.DATA_DIR, "hunter-db.json");
try {
  fs.mkdirSync(CFG.DATA_DIR, { recursive: true });
  fs.appendFileSync(path.join(CFG.DATA_DIR, ".touch"), "");
  persistOk = true;
} catch { persistOk = false; }

/* live trace state, so the page can show progress instead of a blank screen */
const TRACE = { running: false, startedAt: 0, mints: [], done: 0, step: "idle",
                result: null, error: null, finishedAt: 0 };

const DB = {
  wallets: {}, verdicts: {}, queue: [], cycles: 0,
  tokenOffset: 0,
  startedAt: now(), lastCycleAt: null, log: [],
  funnel: { boardPulled: 0, alreadyKnown: 0, preScreened: 0, preRejected: 0,
            vetted: 0, excluded: 0 },
};

function loadDb() {
  if (!persistOk) return;
  try {
    if (!fs.existsSync(DB_FILE)) return;
    Object.assign(DB, JSON.parse(fs.readFileSync(DB_FILE, "utf8")));
    DB.verdicts ||= {}; DB.queue ||= []; DB.tokenOffset ||= 0;
    DB.funnel ||= { boardPulled: 0, alreadyKnown: 0, preScreened: 0,
                    preRejected: 0, vetted: 0, excluded: 0 };
  } catch (e) { console.warn("db load failed:", e.message); }
}
function saveDb() {
  if (!persistOk) return;
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(DB));
    fs.writeFileSync(path.join(CFG.DATA_DIR, "shortlist.txt"),
      shortlist().map((w) => w.wallet).join(","));
  } catch (e) { console.warn("db save failed:", e.message); }
}
loadDb();

let status = "booting…";
function logLine(msg) {
  DB.log.unshift({ at: new Date().toISOString(), msg });
  while (DB.log.length > 90) DB.log.pop();
  console.log(msg);
}

/* ── Birdeye ────────────────────────────────────────────── */

async function birdeye(pathAndQuery) {
  const url = `https://public-api.birdeye.so${pathAndQuery}`;
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      "x-chain": "solana",
      "X-API-KEY": CFG.BIRDEYE_KEY,
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`birdeye ${res.status}: ${text.slice(0, 180)}`);
  try { return JSON.parse(text); }
  catch { throw new Error(`birdeye returned non-JSON: ${text.slice(0, 180)}`); }
}

/* Tokens to ask about. Birdeye's own trending list, or a manual TOKENS list. */
async function pullTokens() {
  if (CFG.TOKENS.length) return CFG.TOKENS.slice(0, CFG.TOKENS_PER_CYCLE);
  status = "fetching trending tokens";
  let j;
  try { j = await birdeye(`/defi/token_trending?sort_by=volume24hUSD&sort_type=desc&offset=${DB.tokenOffset}&limit=20`); }
  catch (e) { logLine(`  trending tokens failed: ${e.message}`); return []; }

  const rows = Array.isArray(j?.data?.tokens) ? j.data.tokens
    : Array.isArray(j?.data?.items) ? j.data.items
    : Array.isArray(j?.data) ? j.data : [];
  const out = [];
  for (const r of rows) {
    const a = r?.address || r?.tokenAddress || r?.mint;
    if (typeof a === "string" && a.length >= 32 && a.length <= 46 && !QUOTES.has(a)) {
      out.push({ address: a, symbol: r?.symbol || a.slice(0, 6) });
    }
  }
  DB.tokenOffset = (DB.tokenOffset + 20) % 100;
  if (!out.length) logLine(`  trending returned ${rows.length} rows, 0 usable — check /probe?q=/defi/token_trending`);
  return out.slice(0, CFG.TOKENS_PER_CYCLE);
}

/* Ask Birdeye for the SMART TRADERS of one token. Bots are excluded by the
   tag itself, so we never spend Helius calls discovering they were bots. */
async function pullSmartTraders(token) {
  const q = `/defi/v2/tokens/top_traders?address=${encodeURIComponent(token.address)}`
    + `&time_frame=${encodeURIComponent(CFG.TRADER_WINDOW)}`
    + `&sort_by=${encodeURIComponent(CFG.TRADER_SORT)}&sort_type=desc`
    + `&offset=0&limit=${CFG.TRADERS_PER_TOKEN}`
    + `&wallet_tags=${encodeURIComponent(CFG.WALLET_TAGS)}`;
  let j;
  try { j = await birdeye(q); }
  catch (e) { logLine(`  ${token.symbol}: top_traders failed — ${e.message}`); return []; }

  const rows = Array.isArray(j?.data?.items) ? j.data.items
    : Array.isArray(j?.data) ? j.data
    : Array.isArray(j?.items) ? j.items : [];

  const out = [];
  for (const r of rows) {
    const addr = r?.owner || r?.address || r?.wallet || r?.trader || r?.account;
    if (typeof addr !== "string" || addr.length < 32 || addr.length > 46) continue;
    const trades = Number(r?.trade ?? r?.tradeBuy ?? 0) + Number(r?.tradeSell ?? 0);
    out.push({
      wallet: addr,
      boardPnl: +Number(r?.realizedPnl ?? r?.realized_pnl ?? r?.pnl ?? 0).toFixed(2),
      boardVolume: Number(r?.volumeUsd ?? r?.volume_usd ?? r?.volume ?? 0),
      boardTrades: trades,
      window: `${CFG.TRADER_WINDOW} ${token.symbol}`,
      tags: r?.tags || r?.wallet_tags || null,
    });
  }
  if (rows.length && !out.length) {
    logLine(`  ${token.symbol}: ${rows.length} rows, no address field matched — check /probe`);
  }
  return out;
}

/* One discovery pass: tokens -> smart traders -> dedupe -> queue */
async function pullCandidates() {
  const tokens = await pullTokens();
  if (!tokens.length) return [];
  const seen = new Set();
  const out = [];
  for (const t of tokens) {
    status = `smart traders of ${t.symbol}`;
    const traders = await pullSmartTraders(t);
    let fresh = 0;
    for (const w of traders) {
      if (seen.has(w.wallet)) continue;
      seen.add(w.wallet);
      out.push(w);
      fresh++;
    }
    logLine(`  ${t.symbol}: ${traders.length} smart traders (${fresh} new)`);
    await sleep(1200);
  }
  DB.funnel.boardPulled += out.length;
  return out;
}

/* ── CO-OCCURRENCE DISCOVERY ────────────────────────────
   1. For each trusted wallet, find the coins it recently bought.
   2. For each of those coins, read only the RECENT pages.
   3. Count which other wallets bought the same coin near the same time.
   4. Wallets appearing across >= COOC_MIN_HITS coins go into the queue,
      ranked by how many they share. Size never enters into it. */

function trustedWallets() {
  const verified = Object.entries(DB.verdicts)
    .filter(([, v]) => v.result === "pass").map(([w]) => w);
  const scored = Object.values(DB.wallets)
    .filter((w) => !w.excluded && !w.dormant && (w.score || 0) >= CFG.MIN_SCORE)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .map((w) => w.wallet);
  return [...new Set([...CFG.SEED_WALLETS, ...verified, ...scored])].slice(0, 4);
}

/* coins a trusted wallet bought recently, with the timestamp it bought at */
async function seedCoins(seed) {
  const coins = new Map();
  let before = "";
  for (let page = 0; page < CFG.SEED_COIN_PAGES; page++) {
    status = `coins of ${seed.slice(0, 6)}… p${page + 1}`;
    let batch;
    try { batch = await heliusPage(seed, before); } catch { break; }
    if (batch === null) { page--; continue; }
    if (!batch.length) break;
    for (const tx of batch) {
      const { paid } = solLeg(tx, seed);
      if (paid < CFG.MIN_BUY_SOL) continue;
      const d = mintDeltas(tx, seed);
      for (const [mint, qty] of Object.entries(d)) {
        if (qty <= 0) continue;
        if (!coins.has(mint)) coins.set(mint, { mint, at: tx.timestamp, seed });
      }
    }
    before = batch[batch.length - 1].signature;
    if (batch.length < 100) break;
    await sleep(300);
  }
  return [...coins.values()].slice(0, CFG.SEED_COINS);
}

/* wallets that bought the same coin within COOC_WINDOW_H of the seed */
async function coinNeighbours(coin) {
  const found = new Set();
  const lo = coin.at - CFG.COOC_WINDOW_H * 3600;
  const hi = coin.at + CFG.COOC_WINDOW_H * 3600;
  let before = "";
  for (let page = 0; page < CFG.COOC_PAGES; page++) {
    status = `neighbours of ${coin.mint.slice(0, 6)}… p${page + 1}`;
    let batch;
    try { batch = await heliusPage(coin.mint, before); } catch { break; }
    if (batch === null) { page--; continue; }
    if (!batch.length) break;
    let anyInWindow = false;
    for (const tx of batch) {
      if (tx.timestamp < lo || tx.timestamp > hi) continue;
      anyInWindow = true;
      const buyers = new Set();
      for (const tr of tx.tokenTransfers || []) {
        if (tr.mint !== coin.mint) continue;
        if (tr.toUserAccount) buyers.add(tr.toUserAccount);
      }
      for (const w of buyers) {
        if (w === coin.seed) continue;
        if (QUOTES.has(w) || PROGRAMS.has(w)) continue;
        const { paid } = solLeg(tx, w);
        if (paid < CFG.MIN_BUY_SOL) continue;
        const d = mintDeltas(tx, w)[coin.mint];
        if (!d || d <= 0) continue;
        found.add(w);
      }
    }
    const oldest = batch[batch.length - 1].timestamp;
    before = batch[batch.length - 1].signature;
    if (oldest < lo && !anyInWindow) break;   // paged past the window
    if (batch.length < 100) break;
    await sleep(300);
  }
  return found;
}

async function pullCoOccurrence() {
  const seeds = trustedWallets();
  if (!seeds.length) { logLine(`  no trusted wallets to mine from`); return []; }

  const hits = new Map();          // wallet -> Set of coins shared
  const coinCount = { total: 0 };
  for (const seed of seeds) {
    const coins = await seedCoins(seed);
    logLine(`  ${seed.slice(0, 6)}…: ${coins.length} recent coins`);
    for (const coin of coins) {
      const nb = await coinNeighbours(coin);
      coinCount.total++;
      for (const w of nb) {
        if (!hits.has(w)) hits.set(w, new Set());
        hits.get(w).add(coin.mint);
      }
      await sleep(200);
    }
  }

  const out = [];
  for (const [wallet, coinsShared] of hits) {
    if (coinsShared.size < CFG.COOC_MIN_HITS) continue;
    out.push({
      wallet,
      boardPnl: 0,
      boardVolume: 0,
      boardTrades: 0,
      cooc: coinsShared.size,
      window: `co-occurrence ×${coinsShared.size}`,
    });
  }
  out.sort((a, b) => b.cooc - a.cooc);
  DB.funnel.boardPulled += out.length;
  logLine(`  co-occurrence: ${coinCount.total} coins → ${hits.size} neighbours → ${out.length} seen in ${CFG.COOC_MIN_HITS}+ coins`);
  return out;
}

/* ── Helius ─────────────────────────────────────────────── */

async function heliusPage(address, before) {
  const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${CFG.KEY}&limit=100${before ? `&before=${before}` : ""}`;
  const res = await fetch(url);
  if (res.status === 429) { await sleep(4000); return null; }
  if (!res.ok) throw new Error(`helius ${res.status}`);
  return res.json();
}

function solLeg(tx, wallet) {
  let paid = 0, recv = 0;
  const swap = tx.events && tx.events.swap;
  if (swap) {
    if (swap.nativeInput?.account === wallet) paid += Number(swap.nativeInput.amount || 0) / LAMPORTS;
    if (swap.nativeOutput?.account === wallet) recv += Number(swap.nativeOutput.amount || 0) / LAMPORTS;
    for (const t of swap.tokenInputs || [])
      if (t.mint === SOL_MINT && t.userAccount === wallet && t.rawTokenAmount)
        paid += Math.abs(Number(t.rawTokenAmount.tokenAmount)) / 10 ** Number(t.rawTokenAmount.decimals ?? 9);
    for (const t of swap.tokenOutputs || [])
      if (t.mint === SOL_MINT && t.userAccount === wallet && t.rawTokenAmount)
        recv += Math.abs(Number(t.rawTokenAmount.tokenAmount)) / 10 ** Number(t.rawTokenAmount.decimals ?? 9);
  }
  for (const t of tx.tokenTransfers || []) {
    if (t.mint !== SOL_MINT) continue;
    const a = Math.abs(Number(t.tokenAmount || 0));
    if (t.fromUserAccount === wallet) paid = Math.max(paid, a);
    if (t.toUserAccount === wallet) recv = Math.max(recv, a);
  }
  for (const t of tx.nativeTransfers || []) {
    const a = Number(t.amount || 0) / LAMPORTS;
    if (a < 0.005) continue;
    if (t.fromUserAccount === wallet) paid = Math.max(paid, a);
    if (t.toUserAccount === wallet) recv = Math.max(recv, a);
  }
  return { paid, recv };
}

function mintDeltas(tx, wallet) {
  const d = {};
  for (const tr of tx.tokenTransfers || []) {
    if (!tr.mint || QUOTES.has(tr.mint)) continue;
    const amt = Math.abs(Number(tr.tokenAmount || 0));
    if (!amt) continue;
    if (tr.toUserAccount === wallet) d[tr.mint] = (d[tr.mint] || 0) + amt;
    else if (tr.fromUserAccount === wallet) d[tr.mint] = (d[tr.mint] || 0) - amt;
  }
  for (const k of Object.keys(d)) if (!d[k]) delete d[k];
  return d;
}

function buildLedger(txs, wallet) {
  const perMint = {};
  let airdropped = 0;
  for (const tx of txs) {
    const { paid, recv } = solLeg(tx, wallet);
    const deltas = Object.entries(mintDeltas(tx, wallet));
    if (!deltas.length) continue;
    const bought = deltas.filter(([, q]) => q > 0);
    const sold = deltas.filter(([, q]) => q < 0);
    if (bought.length) {
      const each = paid / bought.length;
      for (const [mint, qty] of bought) {
        const m = (perMint[mint] ||= { buys: [], sells: [], movedOut: 0 });
        if (each > 0.002) m.buys.push({ ts: tx.timestamp, qty, sol: each });
        else airdropped++;
      }
    }
    if (sold.length) {
      const each = recv / sold.length;
      for (const [mint, qty] of sold) {
        const m = (perMint[mint] ||= { buys: [], sells: [], movedOut: 0 });
        if (each > 0.002) m.sells.push({ ts: tx.timestamp, qty: -qty, sol: each });
        else m.movedOut += -qty;
      }
    }
  }
  return { perMint, airdropped };
}

function matchFIFO(m) {
  const buys = m.buys.slice().sort((a, b) => a.ts - b.ts).map((b) => ({ ...b, left: b.qty }));
  const sells = m.sells.slice().sort((a, b) => a.ts - b.ts);
  let realised = 0, matchedCost = 0, matchedQty = 0, unmatchedQty = 0;
  const holds = [];
  for (const s of sells) {
    if (!s.qty) continue;
    const perUnitOut = s.sol / s.qty;
    let need = s.qty;
    for (const b of buys) {
      if (need <= 0) break;
      if (!b.left || b.ts > s.ts) continue;
      const take = Math.min(b.left, need);
      const perUnitIn = b.sol / b.qty;
      realised += take * (perUnitOut - perUnitIn);
      matchedCost += take * perUnitIn;
      matchedQty += take;
      holds.push((s.ts - b.ts) / 60);
      b.left -= take;
      need -= take;
    }
    if (need > 0) unmatchedQty += need;
  }
  const boughtQty = buys.reduce((t, b) => t + b.qty, 0);
  const openQty = buys.reduce((t, b) => t + b.left, 0);
  const closed = boughtQty > 0 && openQty <= boughtQty * CFG.CLOSE_TOLERANCE;
  return {
    realised, matchedCost, matchedQty, unmatchedQty, openQty, boughtQty,
    movedOut: m.movedOut || 0, closed, holds,
    firstBuy: buys.length ? buys[0].ts : null,
  };
}

/* ── PRE-SCREEN ─────────────────────────────────────────── */

async function preScreen(wallet) {
  const txs = [];
  let before = "";
  for (let i = 0; i < CFG.PRESCREEN_PAGES; i++) {
    let batch;
    try { batch = await heliusPage(wallet, before); } catch { return { ok: false, why: "fetch failed" }; }
    if (batch === null) { i--; continue; }
    if (!batch.length) break;
    txs.push(...batch);
    before = batch[batch.length - 1].signature;
    if (batch.length < 100) break;
    await sleep(300);
  }
  DB.funnel.preScreened++;
  if (txs.length < 10) return { ok: false, why: "barely used" };
  const span = txs[0].timestamp - txs[txs.length - 1].timestamp;
  if (span <= 0) return { ok: false, why: "no time span" };
  const perDay = txs.length / (span / DAY);
  if (perDay * CFG.VET_DAYS > CFG.MAX_TXS_30D) {
    return { ok: false, why: `~${Math.round(perDay)} txs/day` };
  }
  const swaps = txs.filter((t) => t.events?.swap || (t.tokenTransfers || []).length).length;
  if (swaps < 5) return { ok: false, why: "no swap activity" };
  if (now() - txs[0].timestamp > CFG.DORMANT_DAYS * DAY) {
    return { ok: false, why: "dormant" };
  }
  return { ok: true, perDay: Math.round(perDay) };
}

/* ── VET ────────────────────────────────────────────────── */

async function fetchWalletTxs(wallet) {
  const cutoff = now() - CFG.VET_DAYS * DAY;
  const txs = [];
  let before = "";
  let hitCeiling = true;
  for (let page = 0; page < CFG.WALLET_PAGES; page++) {
    status = `vet ${wallet.slice(0, 6)}… p${page + 1}`;
    let batch;
    try { batch = await heliusPage(wallet, before); } catch { hitCeiling = false; break; }
    if (batch === null) { page--; continue; }
    if (!batch.length) { hitCeiling = false; break; }
    txs.push(...batch);
    before = batch[batch.length - 1].signature;
    if (batch[batch.length - 1].timestamp < cutoff) { hitCeiling = false; break; }
    if (batch.length < 100) { hitCeiling = false; break; }
    await sleep(350);
  }
  return { txs: txs.filter((t) => t.timestamp >= cutoff), hitCeiling };
}

async function liquiditySample(mints) {
  const out = [];
  for (const m of mints.slice(0, 8)) {
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${m}`);
      if (res.ok) {
        const j = await res.json();
        const pairs = (j.pairs || []).filter((p) => p.chainId === "solana");
        pairs.sort((a, b) => (Number(b.liquidity?.usd) || 0) - (Number(a.liquidity?.usd) || 0));
        out.push(pairs.length ? Number(pairs[0].liquidity?.usd) || 0 : 0);
      }
    } catch {}
    await sleep(300);
  }
  return out;
}

const ramp = (v, zero, full) => Math.max(0, Math.min(1, (v - zero) / (full - zero)));
const peak = (v, lo, best, hi) => {
  if (v <= lo || v >= hi) return 0;
  return v <= best ? (v - lo) / (best - lo) : (hi - v) / (hi - best);
};

async function vetWallet(wallet) {
  const { txs, hitCeiling } = await fetchWalletTxs(wallet);
  if (txs.length < 5) return null;
  txs.sort((a, b) => a.timestamp - b.timestamp);
  const lastActiveTs = txs[txs.length - 1].timestamp;
  const txCount = txs.length;

  let mintEvents = 0;
  for (const tx of txs) {
    if (tx.feePayer === wallet && MINT_TYPES.has(String(tx.type || ""))) mintEvents++;
  }

  const { perMint, airdropped } = buildLedger(txs, wallet);

  const positions = [];
  let openPositions = 0, realisedTotal = 0, matchedCostTotal = 0;
  const allHolds = [];
  let visibleAcc = 0, movedAcc = 0, mintsCounted = 0;

  for (const [mint, m] of Object.entries(perMint)) {
    if (!m.buys.length) continue;
    const r = matchFIFO(m);
    if (!r.closed) openPositions++;
    if (r.matchedQty > 0) {
      realisedTotal += r.realised;
      matchedCostTotal += r.matchedCost;
      allHolds.push(...r.holds);
    }
    if (r.boughtQty > 0) {
      visibleAcc += Math.min(1, r.matchedQty / r.boughtQty);
      const disposed = r.matchedQty + r.movedOut;
      if (disposed > 0) movedAcc += r.movedOut / disposed;
      mintsCounted++;
    }
    positions.push({
      mint, closed: r.closed, matched: r.matchedQty > 0, pnl: r.realised,
      holdMin: r.holds.length ? r.holds.reduce((a, b) => a + b, 0) / r.holds.length : null,
      firstBuy: r.firstBuy,
      buySol: m.buys.reduce((t, b) => t + b.sol, 0),
    });
  }
  if (!positions.length) return null;

  const closed = positions.filter((p) => p.closed && p.matched);
  const visiblePct = mintsCounted ? (visibleAcc / mintsCounted) * 100 : 0;
  const movedOutPct = mintsCounted ? (movedAcc / mintsCounted) * 100 : 0;
  const winRate = closed.length ? (closed.filter((p) => p.pnl > 0).length / closed.length) * 100 : 0;
  const holds = allHolds.slice().sort((a, b) => a - b);
  const medHold = holds.length ? holds[Math.floor(holds.length / 2)] : 0;
  const roiPct = matchedCostTotal > 0 ? (realisedTotal / matchedCostTotal) * 100 : 0;
  const sizes = positions.map((p) => p.buySol).sort((a, b) => a - b);
  const medSize = sizes[Math.floor(sizes.length / 2)];
  const sizeRatio = CFG.MY_STAKE_SOL > 0 ? medSize / CFG.MY_STAKE_SOL : 0;

  const byDay = {};
  for (const p of closed) {
    if (!p.firstBuy) continue;
    const d = new Date(p.firstBuy * 1000).toISOString().slice(0, 10);
    byDay[d] = (byDay[d] || 0) + p.pnl;
  }
  const days = Object.values(byDay);
  const greenDays = days.filter((v) => v > 0).length;

  const recentMints = positions.slice().sort((a, b) => (b.firstBuy || 0) - (a.firstBuy || 0)).map((p) => p.mint);
  status = `vet ${wallet.slice(0, 6)}… liquidity`;
  const liq = (await liquiditySample(recentMints)).filter((v) => v > 0).sort((a, b) => a - b);
  const medLiq = liq.length ? liq[Math.floor(liq.length / 2)] : 0;

  const excludes = [];
  if (mintEvents >= CFG.MAX_MINT_EVENTS) excludes.push(`deployer (${mintEvents} mints)`);
  if (txCount > CFG.MAX_TXS_30D) excludes.push(`machine (${hitCeiling ? `${txCount}+` : txCount} txs)`);
  if (movedOutPct > CFG.MAX_TRANSFER_OUT_PCT) excludes.push(`moves tokens out (${movedOutPct.toFixed(0)}%)`);
  if (sizeRatio > CFG.HARD_MAX_SIZE_RATIO) excludes.push(`size ${sizeRatio.toFixed(0)}x mine`);
  if (visiblePct < CFG.HARD_MIN_VISIBLE_PCT) excludes.push(`only ${visiblePct.toFixed(0)}% visible`);
  if (closed.length < CFG.MIN_MATCHED) excludes.push(`only ${closed.length} round trips`);
  if (realisedTotal <= 0) excludes.push(`unprofitable in window`);
  if (matchedCostTotal < CFG.MIN_DEPLOYED_SOL) excludes.push(`only ${matchedCostTotal.toFixed(1)} SOL deployed`);
  if (medHold < CFG.MIN_HOLD_MIN) excludes.push(`median hold ${medHold.toFixed(0)}m`);

  const sig = {
    roi: peak(roiPct, 0, 60, 400),
    win: peak(winRate, 20, 55, 85),
    hold: peak(medHold, 5, 240, 2880),
    liquidity: ramp(medLiq, CFG.MIN_LIQ_USD * 0.25, CFG.MIN_LIQ_USD * 2),
    size: peak(sizeRatio, 0, 1.5, 12),
    visible: ramp(visiblePct, 30, 90),
    sample: ramp(closed.length, 5, 40),
    consistency: days.length >= 4 ? ramp(greenDays / days.length, 0.2, 0.6) : 0.4,
  };
  const score = excludes.length ? 0 : Math.round(
    sig.roi * CFG.W_ROI + sig.win * CFG.W_WIN + sig.hold * CFG.W_HOLD +
    sig.liquidity * CFG.W_LIQ + sig.size * CFG.W_SIZE + sig.visible * CFG.W_VISIBLE +
    sig.sample * CFG.W_SAMPLE + sig.consistency * CFG.W_CONSISTENCY
  );

  DB.funnel.vetted++;
  if (excludes.length) DB.funnel.excluded++;

  return {
    wallet, score, excluded: excludes.length > 0, excludes, signals: sig,
    vettedAt: now(), lastActiveTs,
    dormant: now() - lastActiveTs > CFG.DORMANT_DAYS * DAY,
    stats: {
      tokens: positions.length, closed: closed.length, openPositions, txCount, txCeiling: hitCeiling,
      winRatePct: +winRate.toFixed(1),
      realisedSol: +realisedTotal.toFixed(3),
      matchedCostSol: +matchedCostTotal.toFixed(2),
      roiPct: +roiPct.toFixed(1),
      visiblePct: +visiblePct.toFixed(0),
      movedOutPct: +movedOutPct.toFixed(0),
      sizeRatio: +sizeRatio.toFixed(1),
      medianHoldMin: +medHold.toFixed(1),
      medianPositionSol: +medSize.toFixed(3),
      medianPoolUsd: Math.round(medLiq),
      greenDays, totalDays: days.length, airdrops: airdropped, mintEvents,
    },
  };
}

function storeCard(card, board) {
  const prev = DB.wallets[card.wallet];
  DB.wallets[card.wallet] = {
    ...card,
    board: prev?.board || board || null,
    firstSeenAt: prev?.firstSeenAt || now(),
    prevScore: prev?.score ?? null,
  };
}

/* ── SHORTLIST + ANALYSIS ───────────────────────────────── */

function shortlist() {
  return Object.values(DB.wallets)
    .filter((w) => !w.excluded && !w.dormant && (w.score || 0) >= CFG.MIN_SCORE)
    .filter((w) => !DB.verdicts[w.wallet])
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, CFG.SHORTLIST_SIZE);
}

function verdictAnalysis() {
  const pass = [], fail = [];
  for (const [w, v] of Object.entries(DB.verdicts)) {
    const card = DB.wallets[w];
    if (!card || !card.signals) continue;
    (v.result === "pass" ? pass : fail).push(card);
  }
  if (!pass.length && !fail.length) return null;
  const keys = ["roi", "win", "hold", "liquidity", "size", "visible", "sample", "consistency"];
  const mean = (arr, k) => arr.length ? arr.reduce((t, c) => t + (c.signals[k] || 0), 0) / arr.length : 0;
  return {
    passN: pass.length, failN: fail.length,
    rows: keys.map((k) => ({
      key: k, pass: mean(pass, k), fail: mean(fail, k), gap: mean(pass, k) - mean(fail, k),
    })).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap)),
  };
}

/* ── CYCLE ──────────────────────────────────────────────── */

let running = false;

async function cycle() {
  if (running) return;
  running = true;
  const cycleNo = DB.cycles + 1;

  try {
    logLine(`cycle ${cycleNo}`);

    /* top the queue up from the leaderboard when it runs low */
    if (DB.queue.length < CFG.MAX_VET_PER_CYCLE) {
      /* co-occurrence is the only size-blind source, so favour it; fall back
         to Birdeye smart traders when there is nothing trusted to mine yet */
      const useCooc = trustedWallets().length > 0 && cycleNo % CFG.COOC_EVERY === 0;
      let board = useCooc ? await pullCoOccurrence() : await pullCandidates();
      if (!board.length) board = useCooc ? await pullCandidates() : await pullCoOccurrence();
      let added = 0, known = 0;
      for (const t of board) {
        if (DB.verdicts[t.wallet]) { known++; continue; }
        if (CFG.SEED_WALLETS.includes(t.wallet)) { known++; continue; }
        const prev = DB.wallets[t.wallet];
        if (prev && now() - prev.vettedAt < 14 * DAY) { known++; continue; }
        if (DB.queue.some((q) => q.wallet === t.wallet)) continue;
        DB.queue.push(t);
        added++;
      }
      DB.funnel.alreadyKnown += known;
      logLine(`  queued ${added} new (${known} already known) · queue ${DB.queue.length}`);
    }

    const batch = DB.queue.splice(0, CFG.MAX_VET_PER_CYCLE);
    logLine(`cycle ${cycleNo} — screening ${batch.length}`);

    for (const t of batch) {
      const w = t.wallet;
      try {
        status = `pre-screen ${w.slice(0, 6)}…`;
        const pre = await preScreen(w);
        if (!pre.ok) {
          DB.funnel.preRejected++;
          logLine(`  ${w.slice(0, 6)}… pre-rejected — ${pre.why}`);
          continue;
        }
        const card = await vetWallet(w);
        if (!card) { logLine(`  ${w.slice(0, 6)}… no usable positions`); continue; }
        storeCard(card, t);
        logLine(card.excluded
          ? `  ${w.slice(0, 6)}… excluded — ${card.excludes.join(", ")}`
          : `  ${w.slice(0, 6)}… SCORE ${card.score} · ${card.stats.roiPct}% ROI on ${card.stats.matchedCostSol} SOL · ${card.stats.winRatePct}% win · hold ${card.stats.medianHoldMin}m · pool $${card.stats.medianPoolUsd.toLocaleString()}`);
      } catch (e) { logLine(`  ${w.slice(0, 6)}… vet failed: ${e.message}`); }
    }

    const stale = Object.values(DB.wallets)
      .filter((w) => !w.excluded && !DB.verdicts[w.wallet] && now() - w.vettedAt > CFG.REVET_DAYS * DAY)
      .sort((a, b) => a.vettedAt - b.vettedAt)
      .slice(0, CFG.MAX_REVET_PER_CYCLE);
    for (const s of stale) {
      status = `re-vetting ${s.wallet.slice(0, 6)}…`;
      try {
        const card = await vetWallet(s.wallet);
        if (card) storeCard(card, s.board);
      } catch {}
    }

    for (const w of Object.values(DB.wallets)) {
      w.dormant = w.lastActiveTs ? now() - w.lastActiveTs > CFG.DORMANT_DAYS * DAY : false;
    }

    DB.cycles = cycleNo;
    DB.lastCycleAt = now();
    saveDb();
    logLine(`cycle ${cycleNo} done — ${Object.keys(DB.wallets).length} vetted, ${shortlist().length} on shortlist, ${DB.queue.length} queued`);
  } catch (e) {
    logLine(`cycle ${cycleNo} error: ${e.message}`);
  } finally {
    running = false;
    status = `sleeping ${CFG.CYCLE_MINUTES}m · queue ${DB.queue.length}`;
  }
}

/* ── TRACE: find the wallet(s) common to a set of coins ──── */

/* Every wallet that BOUGHT this mint, with the first buy time and SOL size.
   Low-cap coins are small enough to read in full, so no reachability gate. */
async function coinBuyers(mint) {
  const buyers = new Map();
  let before = "";
  let pages = 0, reachedStart = false;
  for (let page = 0; page < CFG.TRACE_PAGES; page++) {
    status = `trace ${mint.slice(0, 6)}… p${page + 1}`;
    TRACE.step = `reading coin ${TRACE.done + 1}/${TRACE.mints.length} (${mint.slice(0, 6)}…) page ${page + 1}/${CFG.TRACE_PAGES} · ${buyers.size} buyers so far`;
    let batch;
    try { batch = await heliusPage(mint, before); } catch { break; }
    if (batch === null) { page--; continue; }
    if (!batch.length) { reachedStart = true; break; }
    pages++;
    for (const tx of batch) {
      const movers = new Set();
      for (const tr of tx.tokenTransfers || []) {
        if (tr.mint !== mint) continue;
        if (tr.toUserAccount) movers.add(tr.toUserAccount);
      }
      for (const w of movers) {
        if (QUOTES.has(w) || PROGRAMS.has(w)) continue;
        const d = mintDeltas(tx, w)[mint];
        if (!d || d <= 0) continue;
        const { paid } = solLeg(tx, w);
        if (paid < CFG.MIN_BUY_SOL) continue;
        const prev = buyers.get(w);
        if (!prev || tx.timestamp < prev.at) {
          buyers.set(w, { at: tx.timestamp, sol: +paid.toFixed(3) });
        }
      }
    }
    before = batch[batch.length - 1].signature;
    if (batch.length < 100) { reachedStart = true; break; }
    await sleep(300);
  }
  return { buyers, pages, reachedStart };
}

async function traceCoins(mints) {
  const perCoin = [];
  for (const mint of mints.slice(0, CFG.TRACE_MAX_COINS)) {
    const r = await coinBuyers(mint);
    perCoin.push({ mint, ...r });
    TRACE.done++;
    logLine(`  trace ${mint.slice(0, 6)}…: ${r.buyers.size} buyers over ${r.pages}p${r.reachedStart ? " (full history)" : " (partial)"}`);
    await sleep(400);
  }

  /* intersect: which wallets bought how many of these coins */
  const tally = new Map();
  for (const c of perCoin) {
    for (const [w, info] of c.buyers) {
      if (!tally.has(w)) tally.set(w, { wallet: w, coins: [], total: 0 });
      const t = tally.get(w);
      t.coins.push({ mint: c.mint, at: info.at, sol: info.sol });
      t.total += info.sol;
    }
  }

  TRACE.step = "intersecting buyers";
  const ranked = [...tally.values()]
    .filter((t) => t.coins.length >= 2)
    .map((t) => ({
      ...t,
      hits: t.coins.length,
      avgSol: +(t.total / t.coins.length).toFixed(3),
    }))
    .sort((a, b) => (b.hits - a.hits) || (a.avgSol - b.avgSol));

  return { perCoin: perCoin.map((c) => ({ mint: c.mint, buyers: c.buyers.size, pages: c.pages, full: c.reachedStart })), ranked };
}

/* ── dashboard ──────────────────────────────────────────── */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function renderPage() {
  const all = Object.values(DB.wallets);
  const list = shortlist();
  const judged = Object.keys(DB.verdicts).length;
  const passed = Object.values(DB.verdicts).filter((v) => v.result === "pass").length;
  const excluded = all.filter((w) => w.excluded).length;
  const analysis = verdictAnalysis();
  const f = DB.funnel;

  const ago = (ts) => {
    if (!ts) return "never";
    const d = now() - ts;
    if (d < 60) return `${d}s ago`;
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    if (d < DAY) return `${Math.floor(d / 3600)}h ago`;
    return `${Math.floor(d / DAY)}d ago`;
  };

  const card = (w, rank) => {
    const s = w.stats;
    const k = CFG.CONTROL_KEY ? `&key=${encodeURIComponent(CFG.CONTROL_KEY)}` : "";
    return `<li class="row"><div class="body">
      <div class="head"><span class="sym">#${rank} ${esc(w.wallet.slice(0, 6))}…${esc(w.wallet.slice(-4))}</span>
        <span class="score">${w.score}</span></div>
      <div class="meta"><b>${s.roiPct}% ROI</b> on ${s.matchedCostSol} SOL · ${s.winRatePct}% win · hold ${s.medianHoldMin}m · ${s.closed} round trips</div>
      <div class="meta">pool $${s.medianPoolUsd.toLocaleString()} · ${s.sizeRatio}x my stake · ${s.visiblePct}% visible · ${s.txCount}${s.txCeiling ? "+" : ""} txs · ${s.totalDays}d observed</div>
      <div class="meta">${w.board?.cooc ? `swims with your good wallets in ${w.board.cooc} coins` : `Birdeye smart_trader · $${(w.board?.boardPnl ?? 0).toLocaleString()} realised`} · vetted ${ago(w.vettedAt)} · last traded ${ago(w.lastActiveTs)}</div>
      <div class="meta mono">${esc(w.wallet)}</div>
      <div class="acts">
        <a class="gmgn" href="https://gmgn.ai/sol/address/${esc(w.wallet)}" target="_blank" rel="noopener">Check on GMGN ↗</a>
        <a class="pass" href="/verdict?wallet=${esc(w.wallet)}&result=pass${k}">✓ passed</a>
        <a class="fail" href="/verdict?wallet=${esc(w.wallet)}&result=fail${k}">✗ failed</a>
      </div>
      <div class="check">On GMGN: 30D realized PnL · avg realized profit per trade · deployed tokens empty · any Tx Out</div>
    </div></li>`;
  };

  const logRows = (DB.log || []).slice(0, 26).map((l) =>
    `<li class="logline">${esc(l.at.slice(11, 19))} · ${esc(l.msg)}</li>`).join("");

  const analysisRows = analysis ? analysis.rows.map((r) =>
    `<div class="tline"><span>${esc(r.key)}</span><span>${r.pass.toFixed(2)} vs ${r.fail.toFixed(2)} · gap ${r.gap >= 0 ? "+" : ""}${r.gap.toFixed(2)}</span></div>`).join("") : "";

  const recentVerdicts = Object.entries(DB.verdicts)
    .sort((a, b) => b[1].at - a[1].at).slice(0, 12)
    .map(([w, v]) => `<div class="tline"><span class="mono">${esc(w.slice(0, 10))}…</span><span class="${v.result}">${v.result} · ${ago(v.at)}</span></div>`).join("");

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wallet Hunter</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<meta http-equiv="refresh" content="120">
<style>
  :root{--ground:#0F1418;--panel:#18201F;--edge:#28332F;--green:#5BD68A;--amber:#E8A33D;--slate:#6B7C74;--clay:#C4574A;--ink:#E4EFE9}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--ground);color:var(--ink);font-family:'IBM Plex Mono',monospace;font-size:13px;line-height:1.5;padding:20px 16px 60px}
  h1{font-family:'Space Grotesk',sans-serif;font-size:24px;margin-bottom:4px}
  h1 em{font-style:normal;color:var(--green)}
  .sub{color:var(--slate);font-size:11.5px;margin-bottom:14px}
  h2{font-family:'Space Grotesk',sans-serif;font-size:14px;margin:22px 0 10px}
  ul{list-style:none}
  .cards{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}
  .card{background:var(--panel);border:1px solid var(--edge);padding:10px 12px;min-width:84px;flex:1}
  .card b{font-size:17px;display:block}
  .card span{color:var(--slate);font-size:10px;text-transform:uppercase;letter-spacing:.08em}
  .row{background:var(--panel);border:1px solid var(--edge);border-left:2px solid var(--green);padding:11px 12px;margin-bottom:10px}
  .head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px}
  .sym{font-weight:600}
  .score{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:16px;color:var(--green)}
  .meta{color:var(--slate);font-size:10.5px;margin-top:2px}
  .meta b{color:var(--ink)}
  .mono{word-break:break-all;font-size:9.5px;user-select:all}
  .acts{display:flex;gap:8px;margin-top:9px;flex-wrap:wrap}
  .acts a{text-decoration:none;font-size:11px;padding:6px 11px;border:1px solid var(--edge);border-radius:3px}
  .gmgn{color:var(--ink);background:#1E2A33}
  .pass{color:var(--green);border-color:var(--green)!important}
  .fail{color:var(--clay);border-color:var(--clay)!important}
  .check{color:var(--slate);font-size:9.5px;margin-top:7px;font-style:italic}
  .none{color:var(--slate);font-size:12px;padding:12px;background:var(--panel);border:1px dashed var(--edge)}
  .logline{color:var(--slate);font-size:10px;padding:2px 0;border-bottom:1px solid var(--edge)}
  .status{background:var(--panel);border:1px solid var(--edge);padding:10px 12px;font-size:11.5px;margin-bottom:14px}
  .box{background:var(--panel);border:1px solid var(--edge);padding:10px 12px;margin-bottom:14px}
  .box b{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink)}
  .tline{display:flex;justify-content:space-between;color:var(--slate);font-size:10.5px;margin-top:3px;gap:10px}
  .tline .pass{color:var(--green)}.tline .fail{color:var(--clay)}
  .warn{background:#241A14;border:1px solid var(--amber);padding:10px 12px;margin-bottom:14px;color:var(--amber);font-size:11px}
</style></head><body>
  <h1>Wallet <em>hunter</em></h1>
  <div class="sub">v13 · co-occurrence + smart_trader + /trace → Helius vetting · cycle ${CFG.CYCLE_MINUTES}m · top ${CFG.SHORTLIST_SIZE} · ${persistOk ? "database saved ✓" : "IN MEMORY ONLY"} · <a href="/db.json" style="color:var(--green)">db.json</a> · <a href="/probe" style="color:var(--green)">probe</a> · <a href="/trace" style="color:var(--green)">trace</a></div>
  <div class="warn">A shortlist, not a verdict. Birdeye tags these as non-bot smart traders; the vetting below only sees one address over ${CFG.VET_DAYS} days. Check each on GMGN, then record pass/fail so the scoring learns which signals actually matter.</div>
  ${TRACE.running ? `<div class="box" style="border-color:var(--amber)"><b style="color:var(--amber)">Trace running</b>
    <div class="tline"><span>${esc(TRACE.step)}</span><span>${Math.round((Date.now()-TRACE.startedAt)/1000)}s</span></div></div>`
    : TRACE.result ? `<div class="box"><b>Last trace</b>
    <div class="tline"><span>${TRACE.result.walletsInTwoOrMore} wallets in 2+ coins</span><span><a href="/trace" style="color:var(--green)">view</a></span></div></div>` : ""}
  <div class="status">▶ ${esc(status)}<br>cycles: ${DB.cycles} (${ago(DB.lastCycleAt)}) · sources: co-occurrence + Birdeye smart_trader · trusted seeds: ${trustedWallets().length} · queue ${DB.queue.length}</div>
  <div class="cards">
    <div class="card"><b style="color:var(--green)">${list.length}</b><span>shortlist</span></div>
    <div class="card"><b>${all.length}</b><span>vetted</span></div>
    <div class="card"><b style="color:var(--clay)">${excluded}</b><span>excluded</span></div>
    <div class="card"><b>${passed}/${judged}</b><span>your passes</span></div>
  </div>
  <div class="box"><b>Funnel</b>
    <div class="tline"><span>candidates pulled</span><span>${f.boardPulled}</span></div>
    <div class="tline"><span>already known / judged</span><span>${f.alreadyKnown}</span></div>
    <div class="tline"><span>pre-screened → rejected</span><span>${f.preScreened} → ${f.preRejected}</span></div>
    <div class="tline"><span>fully vetted → excluded</span><span>${f.vetted} → ${f.excluded}</span></div>
  </div>
  <h2>🎯 Check these (top ${CFG.SHORTLIST_SIZE})</h2>
  ${list.length ? `<ul>${list.map((w, i) => card(w, i + 1)).join("")}</ul>`
    : `<div class="none">Nothing scoring ≥${CFG.MIN_SCORE} yet.</div>`}
  ${analysis ? `<div class="box"><b>What your verdicts say (${analysis.passN} pass / ${analysis.failN} fail)</b>
    <div class="meta" style="margin-bottom:4px">mean signal among passes vs failures — a big gap means that signal predicts your verdict</div>${analysisRows}</div>` : ""}
  ${recentVerdicts ? `<div class="box"><b>Recorded verdicts</b>${recentVerdicts}</div>` : ""}
  <h2>Recent activity</h2>
  <ul>${logRows}</ul>
</body></html>`;
}

/* ── server + loop ──────────────────────────────────────── */

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;

  /* Dump a raw Birdeye response so we can confirm field names rather than
     guessing at them. /probe with no args hits the leaderboard. */
  if (p === "/probe") {
    const q = u.searchParams.get("q")
      || `/defi/token_trending?sort_by=volume24hUSD&sort_type=desc&offset=0&limit=3`;
    try {
      const j = await birdeye(q);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ query: q, response: j }, null, 2));
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ query: q, error: e.message }, null, 2));
    }
  }

  if (p === "/verdict") {
    const wallet = u.searchParams.get("wallet") || "";
    const result = u.searchParams.get("result") || "";
    const key = u.searchParams.get("key") || "";
    if (CFG.CONTROL_KEY && key !== CFG.CONTROL_KEY) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      return res.end("bad key");
    }
    if (!DB.wallets[wallet] || !["pass", "fail"].includes(result)) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      return res.end("need ?wallet=<known wallet>&result=pass|fail");
    }
    DB.verdicts[wallet] = { result, at: now() };
    logLine(`verdict: ${wallet.slice(0, 6)}… ${result.toUpperCase()} (your GMGN check)`);
    saveDb();
    res.writeHead(302, { Location: "/" });
    return res.end();
  }

  /* /trace?mints=A,B,C  — starts in the BACKGROUND and returns immediately.
     Reload the same URL (or /trace with no mints) to watch progress. */
  if (p === "/trace") {
    const key = u.searchParams.get("key") || "";
    if (CFG.CONTROL_KEY && key !== CFG.CONTROL_KEY) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      return res.end("bad key");
    }
    const mints = (u.searchParams.get("mints") || "")
      .split(",").map((s) => s.trim()).filter((s) => s.length >= 32 && s.length <= 46);

    const elapsed = TRACE.startedAt ? Math.round((Date.now() - TRACE.startedAt) / 1000) : 0;

    /* already running → report progress */
    if (TRACE.running) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        state: "RUNNING",
        elapsedSeconds: elapsed,
        coinsDone: `${TRACE.done}/${TRACE.mints.length}`,
        doingNow: TRACE.step,
        note: "Reload this page to refresh progress. Result appears here when done.",
      }, null, 2));
    }

    /* no mints given → show the last result, or explain how to start */
    if (!mints.length) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(
        TRACE.result || TRACE.error
          ? { state: TRACE.error ? "FAILED" : "DONE",
              finishedSecondsAgo: Math.round((Date.now() - TRACE.finishedAt) / 1000),
              error: TRACE.error || undefined,
              ...(TRACE.result || {}) }
          : { state: "IDLE",
              howToStart: "/trace?key=YOURKEY&mints=<mint1>,<mint2>,<mint3>",
              note: "2-8 mints, comma separated, no spaces. Add &queue=1 to auto-queue the top hits for vetting." },
        null, 2));
    }

    if (mints.length < 2) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      return res.end("need at least 2 mints");
    }
    if (running) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        state: "WAITING",
        note: "A vetting cycle is using Helius right now. Reload in a minute and it will start.",
      }, null, 2));
    }

    /* start it in the background and answer straight away */
    running = true;
    TRACE.running = true; TRACE.startedAt = Date.now(); TRACE.mints = mints;
    TRACE.done = 0; TRACE.step = "starting"; TRACE.result = null; TRACE.error = null;
    const wantQueue = u.searchParams.get("queue") === "1";

    (async () => {
      try {
        logLine(`trace: ${mints.length} coins`);
        const out = await traceCoins(mints);
        let queued = 0;
        if (wantQueue) {
          for (const t of out.ranked.slice(0, 10)) {
            if (DB.verdicts[t.wallet]) continue;
            if (DB.queue.some((q) => q.wallet === t.wallet)) continue;
            DB.queue.push({
              wallet: t.wallet, boardPnl: 0, boardVolume: 0, boardTrades: 0,
              cooc: t.hits, window: `traced ×${t.hits} coins`,
            });
            queued++;
          }
          saveDb();
        }
        TRACE.result = {
          coins: out.perCoin,
          walletsInTwoOrMore: out.ranked.length,
          queued: wantQueue ? queued : undefined,
          top: out.ranked.slice(0, 25).map((t) => ({
            wallet: t.wallet,
            boughtCoins: t.hits,
            avgBuySol: t.avgSol,
            buys: t.coins.map((c) => ({
              coin: c.mint.slice(0, 8) + "…",
              at: new Date(c.at * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z",
              sol: c.sol,
            })).sort((a, b) => a.at.localeCompare(b.at)),
            gmgn: `https://gmgn.ai/sol/address/${t.wallet}`,
          })),
        };
        logLine(`trace done: ${out.ranked.length} wallets in 2+ coins${wantQueue ? `, ${queued} queued` : ""}`);
      } catch (e) {
        TRACE.error = e.message;
        logLine(`trace failed: ${e.message}`);
      } finally {
        TRACE.running = false; TRACE.finishedAt = Date.now(); TRACE.step = "done";
        running = false;
        status = `sleeping ${CFG.CYCLE_MINUTES}m · queue ${DB.queue.length}`;
      }
    })();

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      state: "STARTED",
      coins: mints.length,
      note: `Reading up to ${CFG.TRACE_PAGES} pages per coin — expect roughly ${mints.length} to ${mints.length * 2} minutes.`,
      next: "Reload this same URL to watch progress and get the result.",
    }, null, 2));
  }

  if (p === "/db.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status, cycles: DB.cycles, funnel: DB.funnel, queued: DB.queue.length, verdicts: DB.verdicts, wallets: DB.wallets }, null, 2));
  }
  if (p === "/shortlist.txt") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end(shortlist().map((w) => w.wallet).join(","));
  }
  if (p === "/health") { res.writeHead(200); return res.end("ok"); }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(renderPage());
}).listen(CFG.PORT, () => {
  console.log(`Wallet hunter v13 on ${CFG.PORT} — persistence ${persistOk ? "ON" : "OFF"}`);
  if (!CFG.KEY) { status = "FAILED: HELIUS_API_KEY not set"; return; }
  if (!CFG.BIRDEYE_KEY) { status = "FAILED: BIRDEYE_API_KEY not set"; return; }
  cycle();
  setInterval(cycle, CFG.CYCLE_MINUTES * 60 * 1000);
});
