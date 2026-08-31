/**
 * WALLET HUNTER v8 — multi-source discovery + shortlist with verdict feedback
 * ----------------------------------------------------------------
 * v7 worked as designed but fished in one pond. Every coin came from
 * GeckoTerminal's trending_pools, and trending coins are where bots live:
 * 12 of 16 wallets excluded as machines, transfer-out operators, or sizes
 * hundreds of times the stake, and the best survivor made 1.2%.
 *
 * v8 rotates discovery across three GeckoTerminal endpoints, each a
 * different population:
 *
 *   · trending_pools — what's hot now. Bot-heavy, kept for completeness.
 *   · new_pools      — fresh launches, before the swarm arrives. Catches
 *                      wallets who get in early and hold.
 *   · pools (top)    — established, liquid coins. Where slower money sits,
 *                      and where pools are deep enough to actually fill in.
 *
 * Each wallet records the source that found it, and the dashboard reports
 * per-source yield — exclusion rate, mean score, and how your own GMGN
 * verdicts break down by source. After a few days that says plainly which
 * pond is worth fishing, rather than me guessing.
 *
 * Everything downstream of discovery is unchanged from v7: quantity-matched
 * FIFO accounting, hard exclusions, 0-100 scoring, top-N shortlist, and the
 * /verdict feedback loop.
 *
 * This service NEVER trades. It only reads the chain.
 */

import http from "http";
import fs from "fs";
import path from "path";

const CFG = {
  KEY: process.env.HELIUS_API_KEY || "",
  CONTROL_KEY: process.env.HUNTER_KEY || process.env.CONTROL_KEY || "",
  PORT: Number(process.env.PORT || 3000),
  CYCLE_MINUTES: Number(process.env.CYCLE_MINUTES || 15),
  COINS_PER_CYCLE: Number(process.env.COINS_PER_CYCLE || 6),
  EXPANSION_COINS: Number(process.env.EXPANSION_COINS || 6),
  MAX_VET_PER_CYCLE: Number(process.env.MAX_VET_PER_CYCLE || 8),

  /* discovery pond */
  DISCOVER_MIN_LIQ: Number(process.env.DISCOVER_MIN_LIQ || 12000),
  MIN_COIN_AGE_H: Number(process.env.MIN_COIN_AGE_H || 2),
  MAX_COIN_AGE_H: Number(process.env.MAX_COIN_AGE_H || 720),   // skip ancient majors
  NEW_POOL_MIN_LIQ: Number(process.env.NEW_POOL_MIN_LIQ || 8000),
  TOP_POOL_MAX_LIQ: Number(process.env.TOP_POOL_MAX_LIQ || 3000000),

  /* execution liquidity — what YOU need to fill in */
  MIN_LIQ_USD: Number(process.env.MIN_LIQ_USD || 30000),

  VET_DAYS: Number(process.env.VET_DAYS || 30),
  MIN_BUY_SOL: Number(process.env.MIN_BUY_SOL || 0.05),
  MIN_HOLD_MIN: Number(process.env.MIN_HOLD_MIN || 10),
  MIN_MATCHED: Number(process.env.MIN_MATCHED || 5),
  SNIPE_CUTOFF_S: Number(process.env.SNIPE_CUTOFF_S || 120),
  COIN_PAGES: Number(process.env.COIN_PAGES || 10),
  WALLET_PAGES: Number(process.env.WALLET_PAGES || 40),
  REVET_DAYS: Number(process.env.REVET_DAYS || 5),
  DORMANT_DAYS: Number(process.env.DORMANT_DAYS || 10),
  MAX_REVET_PER_CYCLE: Number(process.env.MAX_REVET_PER_CYCLE || 2),
  CLOSE_TOLERANCE: Number(process.env.CLOSE_TOLERANCE || 0.05),
  DATA_DIR: process.env.DATA_DIR || "/data",

  /* HARD exclusions */
  MAX_MINT_EVENTS: Number(process.env.MAX_MINT_EVENTS || 3),
  MAX_TXS_30D: Number(process.env.MAX_TXS_30D || 2500),
  MAX_TRANSFER_OUT_PCT: Number(process.env.MAX_TRANSFER_OUT_PCT || 15),
  HARD_MAX_SIZE_RATIO: Number(process.env.HARD_MAX_SIZE_RATIO || 20),
  HARD_MIN_VISIBLE_PCT: Number(process.env.HARD_MIN_VISIBLE_PCT || 30),
  MIN_DEPLOYED_SOL: Number(process.env.MIN_DEPLOYED_SOL || 3),

  MY_STAKE_SOL: Number(process.env.MY_STAKE_SOL || 0.3),

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

/* v8: the three ponds */
const SOURCES = [
  { id: "trending", path: "trending_pools", pages: [1, 2], label: "trending" },
  { id: "new",      path: "new_pools",      pages: [1, 2], label: "new pools" },
  { id: "top",      path: "pools",          pages: [1, 2], label: "top pools" },
];

/* ── persistence ────────────────────────────────────────── */

let persistOk = false;
const DB_FILE = path.join(CFG.DATA_DIR, "hunter-db.json");
try {
  fs.mkdirSync(CFG.DATA_DIR, { recursive: true });
  fs.appendFileSync(path.join(CFG.DATA_DIR, ".touch"), "");
  persistOk = true;
} catch { persistOk = false; }

const DB = {
  wallets: {}, seenCoins: {}, verdicts: {}, cycles: 0,
  startedAt: now(), lastCycleAt: null, lastMode: null, lastSource: null, log: [],
};

function loadDb() {
  if (!persistOk) return;
  try {
    if (!fs.existsSync(DB_FILE)) return;
    Object.assign(DB, JSON.parse(fs.readFileSync(DB_FILE, "utf8")));
    DB.verdicts ||= {};
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

/* ── chain helpers ──────────────────────────────────────── */

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

/* ── DISCOVERY: rotate across three GeckoTerminal ponds ─── */

function poolPasses(src, liq, ageH) {
  if (src.id === "new") {
    // fresh launches: lower liquidity bar, but must have survived a bit
    return liq >= CFG.NEW_POOL_MIN_LIQ && ageH >= CFG.MIN_COIN_AGE_H && ageH <= 48;
  }
  if (src.id === "top") {
    // established coins, but not so huge that harvesting is hopeless
    return liq >= CFG.MIN_LIQ_USD && liq <= CFG.TOP_POOL_MAX_LIQ && ageH >= CFG.MIN_COIN_AGE_H;
  }
  return liq >= CFG.DISCOVER_MIN_LIQ
    && ageH >= CFG.MIN_COIN_AGE_H && ageH <= CFG.MAX_COIN_AGE_H;
}

async function discoverFrom(src) {
  const out = [];
  for (const page of src.pages) {
    try {
      const res = await fetch(
        `https://api.geckoterminal.com/api/v2/networks/solana/${src.path}?page=${page}`,
        { headers: { accept: "application/json" } }
      );
      if (!res.ok) { logLine(`  ${src.label} p${page}: HTTP ${res.status}`); await sleep(2000); continue; }
      const j = await res.json();
      for (const p of j.data || []) {
        const a = p.attributes || {};
        const liq = Number(a.reserve_in_usd || 0);
        const created = a.pool_created_at ? Date.parse(a.pool_created_at) / 1000 : null;
        const ageH = created ? (now() - created) / 3600 : 999;
        const mint = (p.relationships?.base_token?.data?.id || "").replace("solana_", "");
        if (!mint || QUOTES.has(mint)) continue;
        if (!poolPasses(src, liq, ageH)) continue;
        out.push({
          mint, name: a.name || mint.slice(0, 8),
          liq: Math.round(liq), ageH: Math.round(ageH),
          source: src.id, via: src.label,
        });
      }
    } catch (e) { logLine(`  ${src.label} p${page} failed: ${e.message}`); }
    await sleep(2500);
  }
  return out;
}

async function discoverCoins(cycleNo) {
  // rotate the primary pond each cycle, fall through the others if it's dry
  const start = cycleNo % SOURCES.length;
  const order = [...SOURCES.slice(start), ...SOURCES.slice(0, start)];
  let picked = [];
  let usedSource = null;

  for (const src of order) {
    status = `discovering: ${src.label}`;
    const found = await discoverFrom(src);
    const fresh = found.filter((c) => !DB.seenCoins[c.mint] || now() - DB.seenCoins[c.mint] > 7 * DAY);
    const pool = fresh.length ? fresh : found;
    logLine(`  ${src.label}: ${found.length} pools pass filters, ${fresh.length} unseen`);
    if (!pool.length) continue;
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    picked = pool.slice(0, CFG.COINS_PER_CYCLE);
    usedSource = src.id;
    break;
  }
  DB.lastSource = usedSource;
  return picked;
}

async function discoverExpansion() {
  const good = Object.values(DB.wallets)
    .filter((w) => !w.excluded && !w.dormant && (w.score || 0) >= CFG.MIN_SCORE)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 4);
  if (!good.length) return [];
  const coins = [];
  const seen = new Set();
  for (const g of good) {
    status = `expansion: coins traded by ${g.wallet.slice(0, 6)}…`;
    const cutoff = now() - 14 * DAY;
    let before = "";
    let found = 0;
    for (let page = 0; page < 8 && found < 4; page++) {
      let batch;
      try { batch = await heliusPage(g.wallet, before); } catch { break; }
      if (batch === null) { page--; continue; }
      if (!batch.length) break;
      for (const tx of batch) {
        if (tx.timestamp < cutoff) continue;
        const { paid } = solLeg(tx, g.wallet);
        if (paid < CFG.MIN_BUY_SOL) continue;
        for (const tr of tx.tokenTransfers || []) {
          if (!tr.mint || QUOTES.has(tr.mint)) continue;
          if (tr.toUserAccount !== g.wallet) continue;
          if (seen.has(tr.mint)) continue;
          if (DB.seenCoins[tr.mint] && now() - DB.seenCoins[tr.mint] < 7 * DAY) continue;
          seen.add(tr.mint);
          coins.push({
            mint: tr.mint, name: tr.mint.slice(0, 6), liq: 0, ageH: 0,
            source: "expansion", via: `swims with ${g.wallet.slice(0, 6)}…`,
          });
          found++;
        }
      }
      before = batch[batch.length - 1].signature;
      await sleep(400);
    }
  }
  return coins.slice(0, CFG.EXPANSION_COINS);
}

/* ── HARVEST ────────────────────────────────────────────── */

async function harvestCoin(coin) {
  const traders = {};
  let before = "";
  let firstSeen = null;
  let reachedStart = false;
  for (let page = 0; page < CFG.COIN_PAGES; page++) {
    status = `harvest ${coin.name} (${coin.via}) page ${page + 1}`;
    let batch;
    try { batch = await heliusPage(coin.mint, before); } catch { break; }
    if (batch === null) { page--; continue; }
    if (!batch.length) { reachedStart = true; break; }
    for (const tx of batch) {
      if (firstSeen === null || tx.timestamp < firstSeen) firstSeen = tx.timestamp;
      const movers = new Set();
      for (const tr of tx.tokenTransfers || []) {
        if (tr.mint !== coin.mint) continue;
        if (tr.toUserAccount) movers.add(tr.toUserAccount);
        if (tr.fromUserAccount) movers.add(tr.fromUserAccount);
      }
      for (const w of movers) {
        if (QUOTES.has(w) || PROGRAMS.has(w)) continue;
        const d = mintDeltas(tx, w)[coin.mint];
        if (!d) continue;
        const { paid, recv } = solLeg(tx, w);
        const t = (traders[w] ||= { buys: [], sells: [], movedOut: 0 });
        if (d > 0 && paid >= CFG.MIN_BUY_SOL) t.buys.push({ ts: tx.timestamp, qty: d, sol: paid });
        if (d < 0 && recv >= CFG.MIN_BUY_SOL) t.sells.push({ ts: tx.timestamp, qty: -d, sol: recv });
      }
    }
    before = batch[batch.length - 1].signature;
    await sleep(400);
  }
  const winners = [];
  for (const [w, m] of Object.entries(traders)) {
    if (!m.buys.length || !m.sells.length) continue;
    const r = matchFIFO(m);
    if (!r.matchedQty || r.realised <= 0) continue;
    if (r.matchedCost > 0 && r.realised / r.matchedCost < 0.05) continue;
    const holdMin = r.holds.length ? r.holds.reduce((a, b) => a + b, 0) / r.holds.length : 0;
    if (reachedStart && firstSeen !== null && r.firstBuy - firstSeen <= CFG.SNIPE_CUTOFF_S) continue;
    if (holdMin < CFG.MIN_HOLD_MIN) continue;
    winners.push({ wallet: w, profitSol: +r.realised.toFixed(3), holdMin: Math.round(holdMin) });
  }
  winners.sort((a, b) => b.profitSol - a.profitSol);
  DB.seenCoins[coin.mint] = now();
  return winners.slice(0, 8);
}

/* ── VET ────────────────────────────────────────────────── */

async function fetchWalletTxs(wallet) {
  const cutoff = now() - CFG.VET_DAYS * DAY;
  const txs = [];
  let before = "";
  let hitCeiling = true;
  for (let page = 0; page < CFG.WALLET_PAGES; page++) {
    status = `vet ${wallet.slice(0, 6)}… page ${page + 1}`;
    let batch;
    try { batch = await heliusPage(wallet, before); } catch { hitCeiling = false; break; }
    if (batch === null) { page--; continue; }
    if (!batch.length) { hitCeiling = false; break; }
    txs.push(...batch);
    before = batch[batch.length - 1].signature;
    if (batch[batch.length - 1].timestamp < cutoff) { hitCeiling = false; break; }
    await sleep(400);
  }
  return { txs: txs.filter((t) => t.timestamp >= cutoff), hitCeiling };
}

async function liquiditySample(mints) {
  const out = [];
  for (const m of mints.slice(0, 10)) {
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${m}`);
      if (res.ok) {
        const j = await res.json();
        const pairs = (j.pairs || []).filter((p) => p.chainId === "solana");
        pairs.sort((a, b) => (Number(b.liquidity?.usd) || 0) - (Number(a.liquidity?.usd) || 0));
        out.push(pairs.length ? Number(pairs[0].liquidity?.usd) || 0 : 0);
      }
    } catch {}
    await sleep(350);
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

function storeCard(card, provenance, source) {
  const prev = DB.wallets[card.wallet];
  DB.wallets[card.wallet] = {
    ...card,
    provenance: prev?.provenance || provenance,
    source: prev?.source || source,
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

/* v8: which pond is actually producing? */
function sourceStats() {
  const rows = {};
  for (const w of Object.values(DB.wallets)) {
    const s = w.source || "unknown";
    const r = (rows[s] ||= { seen: 0, excluded: 0, scoreSum: 0, scored: 0, pass: 0, fail: 0 });
    r.seen++;
    if (w.excluded) r.excluded++;
    else { r.scoreSum += w.score || 0; r.scored++; }
    const v = DB.verdicts[w.wallet];
    if (v) (v.result === "pass" ? r.pass++ : r.fail++);
  }
  return Object.entries(rows).map(([id, r]) => ({
    id, ...r,
    meanScore: r.scored ? r.scoreSum / r.scored : 0,
    exclPct: r.seen ? (r.excluded / r.seen) * 100 : 0,
  })).sort((a, b) => b.meanScore - a.meanScore);
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
  const haveGood = shortlist().length > 0;
  const wantExpansion = cycleNo % 3 === 0 && haveGood;
  const mode = wantExpansion ? "EXPANSION" : "DISCOVERY";

  try {
    logLine(`cycle ${cycleNo} [${mode}] — discovering`);
    let coins = wantExpansion ? await discoverExpansion() : await discoverCoins(cycleNo);
    if (!coins.length && wantExpansion) {
      logLine(`  expansion found nothing new — falling back to pools`);
      coins = await discoverCoins(cycleNo);
    }
    if (!coins.length) logLine(`  no coins from any source this cycle`);

    const candidates = new Map();
    for (const c of coins) {
      const winners = await harvestCoin(c);
      logLine(`  ${c.name} [${c.via}${c.ageH ? `, ${c.ageH}h` : ""}]: ${winners.length} patient winners`);
      for (const w of winners) {
        const prev = candidates.get(w.wallet) || { hits: 0, profit: 0, via: c.via, source: c.source };
        candidates.set(w.wallet, {
          hits: prev.hits + 1, profit: +(prev.profit + w.profitSol).toFixed(3),
          via: prev.via, source: prev.source,
        });
      }
    }

    const queue = [...candidates.entries()]
      .filter(([w]) => {
        if (DB.verdicts[w]) return false;
        const known = DB.wallets[w];
        return !known || now() - known.vettedAt > 14 * DAY;
      })
      .sort((a, b) => (b[1].hits - a[1].hits) || (b[1].profit - a[1].profit))
      .slice(0, CFG.MAX_VET_PER_CYCLE);

    logLine(`cycle ${cycleNo} — vetting ${queue.length} new candidates`);
    for (const [w, meta] of queue) {
      try {
        const card = await vetWallet(w);
        if (!card) { logLine(`  ${w.slice(0, 6)}… skipped (too little data)`); continue; }
        storeCard(card, `${meta.via} · ${meta.hits} coin(s)`, meta.source);
        logLine(card.excluded
          ? `  ${w.slice(0, 6)}… excluded [${meta.source}] — ${card.excludes.join(", ")}`
          : `  ${w.slice(0, 6)}… score ${card.score} [${meta.source}] · ${card.stats.roiPct}% ROI · ${card.stats.winRatePct}% win · hold ${card.stats.medianHoldMin}m`);
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
        if (card) storeCard(card, s.provenance, s.source);
      } catch {}
    }

    for (const w of Object.values(DB.wallets)) {
      w.dormant = w.lastActiveTs ? now() - w.lastActiveTs > CFG.DORMANT_DAYS * DAY : false;
    }

    DB.cycles = cycleNo;
    DB.lastCycleAt = now();
    DB.lastMode = mode;
    saveDb();
    logLine(`cycle ${cycleNo} done — ${Object.keys(DB.wallets).length} known, ${shortlist().length} on shortlist`);
  } catch (e) {
    logLine(`cycle ${cycleNo} error: ${e.message}`);
  } finally {
    running = false;
    status = `sleeping ${CFG.CYCLE_MINUTES}m · next cycle ${(DB.cycles + 1) % 3 === 0 ? "EXPANSION" : "DISCOVERY"}`;
  }
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
  const sources = sourceStats();

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
      <div class="meta">found via ${esc(w.provenance || "?")} · vetted ${ago(w.vettedAt)} · last traded ${ago(w.lastActiveTs)}</div>
      <div class="meta mono">${esc(w.wallet)}</div>
      <div class="acts">
        <a class="gmgn" href="https://gmgn.ai/sol/address/${esc(w.wallet)}" target="_blank" rel="noopener">Check on GMGN ↗</a>
        <a class="pass" href="/verdict?wallet=${esc(w.wallet)}&result=pass${k}">✓ passed</a>
        <a class="fail" href="/verdict?wallet=${esc(w.wallet)}&result=fail${k}">✗ failed</a>
      </div>
      <div class="check">On GMGN: 30D realized PnL · avg realized profit per trade · deployed tokens empty</div>
    </div></li>`;
  };

  const logRows = (DB.log || []).slice(0, 24).map((l) =>
    `<li class="logline">${esc(l.at.slice(11, 19))} · ${esc(l.msg)}</li>`).join("");

  const sourceRows = sources.map((s) =>
    `<div class="tline"><span>${esc(s.id)}</span><span>${s.seen} seen · ${s.exclPct.toFixed(0)}% excluded · mean score ${s.meanScore.toFixed(0)}${(s.pass + s.fail) ? ` · ${s.pass}/${s.pass + s.fail} passed` : ""}</span></div>`).join("");

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
  <div class="sub">v8 · rotating discovery: trending / new pools / top pools · cycle ${CFG.CYCLE_MINUTES}m · top ${CFG.SHORTLIST_SIZE} · ${persistOk ? "database saved ✓" : "IN MEMORY ONLY"} · <a href="/db.json" style="color:var(--green)">db.json</a></div>
  <div class="warn">Nothing here is approved. These are the best-matching candidates from one address over ${CFG.VET_DAYS} days — six earlier "FOLLOW" picks all failed a GMGN check. Check each one yourself, then record the verdict so the scoring can learn.</div>
  <div class="status">▶ ${esc(status)}<br>cycles: ${DB.cycles} (last ${DB.lastMode || "—"}${DB.lastSource ? ` via ${DB.lastSource}` : ""}, ${ago(DB.lastCycleAt)}) · coins scanned: ${Object.keys(DB.seenCoins).length} · wallets seen: ${all.length}</div>
  <div class="cards">
    <div class="card"><b style="color:var(--green)">${list.length}</b><span>shortlist</span></div>
    <div class="card"><b>${all.length}</b><span>vetted</span></div>
    <div class="card"><b style="color:var(--clay)">${excluded}</b><span>excluded</span></div>
    <div class="card"><b>${passed}/${judged}</b><span>your passes</span></div>
  </div>
  ${sourceRows ? `<div class="box"><b>Which pond is producing</b>${sourceRows}</div>` : ""}
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

http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;

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
    DB.verdicts[wallet] = { result, at: now(), source: DB.wallets[wallet].source || null };
    logLine(`verdict: ${wallet.slice(0, 6)}… ${result.toUpperCase()} (your GMGN check)`);
    saveDb();
    res.writeHead(302, { Location: "/" });
    return res.end();
  }

  if (p === "/db.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status, cycles: DB.cycles, verdicts: DB.verdicts, wallets: DB.wallets }, null, 2));
  }
  if (p === "/shortlist.txt") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end(shortlist().map((w) => w.wallet).join(","));
  }
  if (p === "/health") { res.writeHead(200); return res.end("ok"); }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(renderPage());
}).listen(CFG.PORT, () => {
  console.log(`Wallet hunter v8 on ${CFG.PORT} — persistence ${persistOk ? "ON" : "OFF"}`);
  if (!CFG.KEY) { status = "FAILED: HELIUS_API_KEY not set"; return; }
  cycle();
  setInterval(cycle, CFG.CYCLE_MINUTES * 60 * 1000);
});
