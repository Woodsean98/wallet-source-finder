/**
 * WALLET HUNTER v6 — self-expanding search for followable traders
 * ----------------------------------------------------------------
 * v5 + THREE CHECKS LEARNED FROM GMGN DISAGREEMENTS.
 *
 * v5 fixed the accounting (quantity-matched FIFO) but four of its FOLLOW
 * verdicts still failed independent GMGN checks, each for a different reason
 * that a single-address 30-day view cannot see on its own:
 *
 *   · Hgpr2E — 38.1% ROI here, −0.38% on GMGN. It TRANSFERS tokens out to
 *     another address instead of selling. A transfer is not a disposal, so
 *     the matcher never saw those positions close. → "self-contained"
 *
 *   · BofVsg — 21% ROI here, −6.48% on GMGN. Its average hold is 85 DAYS, so
 *     almost nothing it bought was also sold inside a 30-day window. The
 *     visible sliver flattered it. → "visible history"
 *
 *   · 77eg8Z (10.5 SOL median) and 9Qyptj (7 SOL) — real edges at sizes 25-35x
 *     the operator's stake, which do not survive reproduction. → "copyable size"
 *
 *   · HNHtjv — 570% ROI on 14 SOL deployed. A vast percentage on trivial
 *     capital is noise. → MIN_DEPLOYED_SOL floor on "worthwhile edge".
 *
 * What this still CANNOT do: see across addresses. Operators who split flow
 * over several wallets will keep passing. Treat the output as a shortlist to
 * check on GMGN, never as a verdict.
 *
 * This service NEVER trades. It only reads the chain.
 */

import http from "http";
import fs from "fs";
import path from "path";

const CFG = {
  KEY: process.env.HELIUS_API_KEY || "",
  PORT: Number(process.env.PORT || 3000),
  CYCLE_MINUTES: Number(process.env.CYCLE_MINUTES || 45),
  COINS_PER_CYCLE: Number(process.env.COINS_PER_CYCLE || 6),
  EXPANSION_COINS: Number(process.env.EXPANSION_COINS || 6),
  MAX_VET_PER_CYCLE: Number(process.env.MAX_VET_PER_CYCLE || 5),
  MIN_LIQ_USD: Number(process.env.MIN_LIQ_USD || 30000),
  MIN_COIN_AGE_H: Number(process.env.MIN_COIN_AGE_H || 24),
  VET_DAYS: Number(process.env.VET_DAYS || 30),
  MIN_HOLD_MIN: Number(process.env.MIN_HOLD_MIN || 10),
  MAX_TOKENS: Number(process.env.MAX_TOKENS || 400),
  MIN_WR: Number(process.env.MIN_WR || 25),
  MAX_WR: Number(process.env.MAX_WR || 75),
  MIN_MATCHED: Number(process.env.MIN_MATCHED || 3),
  MIN_BUY_SOL: Number(process.env.MIN_BUY_SOL || 0.05),
  SNIPE_CUTOFF_S: Number(process.env.SNIPE_CUTOFF_S || 120),
  COIN_PAGES: Number(process.env.COIN_PAGES || 10),
  WALLET_PAGES: Number(process.env.WALLET_PAGES || 40),
  REVET_DAYS: Number(process.env.REVET_DAYS || 5),
  DORMANT_DAYS: Number(process.env.DORMANT_DAYS || 10),
  MAX_REVET_PER_CYCLE: Number(process.env.MAX_REVET_PER_CYCLE || 2),
  DATA_DIR: process.env.DATA_DIR || "/data",

  /* v4 calibration */
  MAX_FAST_PCT: Number(process.env.MAX_FAST_PCT || 40),
  PATIENT_HOLD_MIN: Number(process.env.PATIENT_HOLD_MIN || 60),
  MIN_DAYS: Number(process.env.MIN_DAYS || 4),
  MIN_GREEN_RATIO: Number(process.env.MIN_GREEN_RATIO || 0.4),
  MAX_MINT_EVENTS: Number(process.env.MAX_MINT_EVENTS || 3),

  /* v5 */
  MIN_ROI_PCT: Number(process.env.MIN_ROI_PCT || 10),
  MAX_TXS_30D: Number(process.env.MAX_TXS_30D || 1500),
  CLOSE_TOLERANCE: Number(process.env.CLOSE_TOLERANCE || 0.05),

  /* v6 */
  MY_STAKE_SOL: Number(process.env.MY_STAKE_SOL || 0.3),
  MAX_SIZE_RATIO: Number(process.env.MAX_SIZE_RATIO || 8),      // their median / my stake
  MAX_TRANSFER_OUT_PCT: Number(process.env.MAX_TRANSFER_OUT_PCT || 15),
  MIN_VISIBLE_PCT: Number(process.env.MIN_VISIBLE_PCT || 50),   // matched qty / bought qty
  MIN_DEPLOYED_SOL: Number(process.env.MIN_DEPLOYED_SOL || 20), // capital behind the ROI
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

const DB = {
  wallets: {}, seenCoins: {}, cycles: 0,
  startedAt: now(), lastCycleAt: null, lastMode: null, log: [],
};

function loadDb() {
  if (!persistOk) return;
  try {
    if (!fs.existsSync(DB_FILE)) return;
    Object.assign(DB, JSON.parse(fs.readFileSync(DB_FILE, "utf8")));
  } catch (e) { console.warn("db load failed:", e.message); }
}
function saveDb() {
  if (!persistOk) return;
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(DB));
    const promote = Object.values(DB.wallets)
      .filter((w) => w.verdict === "FOLLOW" && !w.dormant)
      .sort((a, b) => b.stats.roiPct - a.stats.roiPct)
      .map((w) => w.wallet);
    fs.writeFileSync(path.join(CFG.DATA_DIR, "promote.txt"), promote.join(","));
  } catch (e) { console.warn("db save failed:", e.message); }
}
loadDb();

let status = "booting…";
function logLine(msg) {
  DB.log.unshift({ at: new Date().toISOString(), msg });
  while (DB.log.length > 80) DB.log.pop();
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

/* v6: buys, sells AND transfers-out are now tracked separately.
   A token leaving the wallet with no SOL coming back is a MOVE, not a sale. */
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
        else m.movedOut += -qty;          // v6: left the wallet, no SOL back
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
    movedOut: m.movedOut || 0,
    closed, holds,
    firstBuy: buys.length ? buys[0].ts : null,
  };
}

/* ── DISCOVERY A: trending coins ────────────────────────── */

async function discoverTrending() {
  const out = [];
  for (const page of [1, 2]) {
    try {
      const res = await fetch(
        `https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=${page}`,
        { headers: { accept: "application/json" } }
      );
      if (!res.ok) { await sleep(2000); continue; }
      const j = await res.json();
      for (const p of j.data || []) {
        const a = p.attributes || {};
        const liq = Number(a.reserve_in_usd || 0);
        const created = a.pool_created_at ? Date.parse(a.pool_created_at) / 1000 : null;
        const ageH = created ? (now() - created) / 3600 : 999;
        const mint = (p.relationships?.base_token?.data?.id || "").replace("solana_", "");
        if (!mint || QUOTES.has(mint)) continue;
        if (liq < CFG.MIN_LIQ_USD || ageH < CFG.MIN_COIN_AGE_H) continue;
        out.push({ mint, name: a.name || mint.slice(0, 8), liq: Math.round(liq), via: "trending" });
      }
    } catch {}
    await sleep(2500);
  }
  const fresh = out.filter((c) => !DB.seenCoins[c.mint] || now() - DB.seenCoins[c.mint] > 7 * DAY);
  const pool = fresh.length ? fresh : out;
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, CFG.COINS_PER_CYCLE);
}

/* ── DISCOVERY B: coins traded by our good wallets ──────── */

async function discoverExpansion() {
  const good = Object.values(DB.wallets)
    .filter((w) => (w.verdict === "FOLLOW" || w.verdict === "WATCH") && !w.dormant)
    .sort((a, b) => b.stats.roiPct - a.stats.roiPct)
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
          coins.push({ mint: tr.mint, name: tr.mint.slice(0, 6), liq: 0, via: `swims with ${g.wallet.slice(0, 6)}…` });
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
    status = `harvest ${coin.name} page ${page + 1}`;
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
  for (let page = 0; page < CFG.WALLET_PAGES; page++) {
    status = `vet ${wallet.slice(0, 6)}… page ${page + 1}`;
    let batch;
    try { batch = await heliusPage(wallet, before); } catch { break; }
    if (batch === null) { page--; continue; }
    if (!batch.length) break;
    txs.push(...batch);
    before = batch[batch.length - 1].signature;
    if (batch[batch.length - 1].timestamp < cutoff) break;
    await sleep(400);
  }
  return txs.filter((t) => t.timestamp >= cutoff);
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

async function vetWallet(wallet) {
  const txs = await fetchWalletTxs(wallet);
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
  let unmatchedSells = 0;
  let openPositions = 0;
  let realisedTotal = 0;
  let matchedCostTotal = 0;
  const allHolds = [];

  /* v6: quantity accounting across the whole wallet, per mint, normalised
     so mints with wildly different unit scales contribute comparably. */
  let visibleAcc = 0, movedAcc = 0, mintsCounted = 0;

  for (const [mint, m] of Object.entries(perMint)) {
    if (!m.buys.length) {
      if (m.sells.length) unmatchedSells += m.sells.length;
      continue;
    }
    const r = matchFIFO(m);
    if (r.unmatchedQty > 0) unmatchedSells++;
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
      mint,
      matched: r.matchedQty > 0,
      closed: r.closed,
      pnl: r.realised,
      cost: r.matchedCost,
      holdMin: r.holds.length ? r.holds.reduce((a, b) => a + b, 0) / r.holds.length : null,
      firstBuy: r.firstBuy,
      buySol: m.buys.reduce((t, b) => t + b.sol, 0),
    });
  }
  if (!positions.length) return null;

  const closed = positions.filter((p) => p.closed && p.matched);
  if (closed.length < CFG.MIN_MATCHED) return null;

  const visiblePct = mintsCounted ? (visibleAcc / mintsCounted) * 100 : 0;
  const movedOutPct = mintsCounted ? (movedAcc / mintsCounted) * 100 : 0;

  const wins = closed.filter((p) => p.pnl > 0);
  const winRate = (wins.length / closed.length) * 100;
  const holds = allHolds.slice().sort((a, b) => a - b);
  const medHold = holds.length ? holds[Math.floor(holds.length / 2)] : 0;
  const fastPct = holds.length
    ? (holds.filter((h) => h < 1 / 12).length / holds.length) * 100 : 0;
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
  const thinHistory = days.length < CFG.MIN_DAYS;

  const recentMints = positions.slice().sort((a, b) => (b.firstBuy || 0) - (a.firstBuy || 0)).map((p) => p.mint);
  status = `vet ${wallet.slice(0, 6)}… liquidity`;
  const liq = (await liquiditySample(recentMints)).filter((v) => v > 0).sort((a, b) => a - b);
  const medLiq = liq.length ? liq[Math.floor(liq.length / 2)] : 0;

  const checks = [];
  const add = (name, pass, detail, skip = false) => checks.push({ name, pass, detail, skip });

  add("hold duration", medHold >= CFG.MIN_HOLD_MIN, `median ${medHold.toFixed(0)}m`);

  const scalping = fastPct > CFG.MAX_FAST_PCT && medHold < CFG.PATIENT_HOLD_MIN;
  add("not a scalper", !scalping,
    `${fastPct.toFixed(0)}% exits <5s${fastPct > CFG.MAX_FAST_PCT && !scalping ? ` (excused, ${medHold.toFixed(0)}m median)` : ""}`);

  add("human pace", positions.length <= CFG.MAX_TOKENS, `${positions.length} tokens/${CFG.VET_DAYS}d`);
  add("not a machine", txCount <= CFG.MAX_TXS_30D,
    `${txCount} txs/${CFG.VET_DAYS}d (~${Math.round(txCount / CFG.VET_DAYS)}/day)`);
  add("win rate band", winRate >= CFG.MIN_WR && winRate <= CFG.MAX_WR, `${winRate.toFixed(0)}%`);
  add("profitable", realisedTotal > 0, `${realisedTotal >= 0 ? "+" : ""}${realisedTotal.toFixed(2)} SOL matched`);

  /* v6: ROI must come from real capital, not a rounding error */
  add("worthwhile edge",
    roiPct >= CFG.MIN_ROI_PCT && matchedCostTotal >= CFG.MIN_DEPLOYED_SOL,
    `${roiPct.toFixed(1)}% on ${matchedCostTotal.toFixed(1)} SOL deployed${matchedCostTotal < CFG.MIN_DEPLOYED_SOL ? " (too little capital to judge)" : ""}`);

  /* v6: does the wallet SELL what it buys, or move it elsewhere? */
  add("self-contained", movedOutPct <= CFG.MAX_TRANSFER_OUT_PCT,
    movedOutPct > 0.5
      ? `${movedOutPct.toFixed(0)}% of disposals were transfers out`
      : "sells what it buys");

  /* v6: is the window wide enough to see this wallet's behaviour? */
  add("visible history", visiblePct >= CFG.MIN_VISIBLE_PCT,
    `${visiblePct.toFixed(0)}% of bought quantity closed in window`);

  /* v6: can this edge survive being reproduced at my stake? */
  add("copyable size", sizeRatio <= CFG.MAX_SIZE_RATIO,
    `${medSize.toFixed(2)} SOL median = ${sizeRatio.toFixed(1)}x my ${CFG.MY_STAKE_SOL}`);

  add("tradeable liquidity", medLiq >= CFG.MIN_LIQ_USD, `median pool $${Math.round(medLiq).toLocaleString()}`);
  add("consistent",
    greenDays / Math.max(days.length, 1) >= CFG.MIN_GREEN_RATIO,
    thinHistory ? `only ${days.length}d observed — not scored` : `${greenDays}/${days.length} green days`,
    thinHistory);
  add("not a deployer", mintEvents < CFG.MAX_MINT_EVENTS,
    mintEvents ? `${mintEvents} mint/pool txs` : "no mints or pools created");

  const scored = checks.filter((c) => !c.skip);
  const passed = scored.filter((c) => c.pass).length;
  const failedChecks = scored.filter((c) => !c.pass).map((c) => c.name);
  const critical = ["hold duration", "not a scalper", "profitable", "worthwhile edge",
                    "self-contained", "visible history", "copyable size"];
  const criticalFail = scored.some((c) => critical.includes(c.name) && !c.pass);

  let verdict = criticalFail ? "REJECT"
    : passed >= scored.length - 1 ? "FOLLOW"
    : passed >= scored.length - 3 ? "WATCH" : "REJECT";
  if (verdict === "FOLLOW" && thinHistory) verdict = "WATCH";

  return {
    wallet, verdict, passed, checksTotal: scored.length, failedChecks,
    vettedAt: now(), lastActiveTs,
    dormant: now() - lastActiveTs > CFG.DORMANT_DAYS * DAY,
    stats: {
      tokens: positions.length, closed: closed.length, openPositions, unmatchedSells,
      txCount,
      winRatePct: +winRate.toFixed(1),
      realisedSol: +realisedTotal.toFixed(3),
      matchedCostSol: +matchedCostTotal.toFixed(2),
      roiPct: +roiPct.toFixed(1),
      visiblePct: +visiblePct.toFixed(0),
      movedOutPct: +movedOutPct.toFixed(0),
      sizeRatio: +sizeRatio.toFixed(1),
      medianHoldMin: +medHold.toFixed(1), fastFlipPct: +fastPct.toFixed(1),
      medianPositionSol: +medSize.toFixed(3),
      medianPoolUsd: Math.round(medLiq), greenDays, totalDays: days.length,
      airdrops: airdropped, mintEvents,
    },
    checks,
  };
}

function storeCard(card, provenance) {
  const prev = DB.wallets[card.wallet];
  const history = prev?.history ? prev.history.slice(-9) : [];
  if (prev) history.push({ at: prev.vettedAt, verdict: prev.verdict, sol: prev.stats.realisedSol });
  let trend = "new";
  if (prev) {
    const d = card.stats.roiPct - (prev.stats.roiPct ?? 0);
    trend = d > 1 ? "improving" : d < -1 ? "declining" : "flat";
  }
  DB.wallets[card.wallet] = {
    ...card,
    provenance: prev?.provenance || provenance,
    firstSeenAt: prev?.firstSeenAt || now(),
    history, trend,
  };
}

/* ── CYCLE ──────────────────────────────────────────────── */

let running = false;

async function cycle() {
  if (running) return;
  running = true;
  const cycleNo = DB.cycles + 1;
  const goodCount = Object.values(DB.wallets).filter(
    (w) => (w.verdict === "FOLLOW" || w.verdict === "WATCH") && !w.dormant).length;
  const wantExpansion = cycleNo % 2 === 0 && goodCount > 0;
  const mode = wantExpansion ? "EXPANSION" : "TRENDING";

  try {
    logLine(`cycle ${cycleNo} [${mode}] — discovering`);
    status = `${mode}: discovering coins`;
    let coins = wantExpansion ? await discoverExpansion() : await discoverTrending();
    if (!coins.length && wantExpansion) {
      logLine(`  expansion found nothing new — falling back to trending`);
      coins = await discoverTrending();
    }

    const candidates = new Map();
    for (const c of coins) {
      status = `[${mode}] harvesting ${c.name}`;
      const winners = await harvestCoin(c);
      logLine(`  ${c.name}: ${winners.length} patient winners (${c.via})`);
      for (const w of winners) {
        const prev = candidates.get(w.wallet) || { hits: 0, profit: 0, via: c.via };
        candidates.set(w.wallet, { hits: prev.hits + 1, profit: +(prev.profit + w.profitSol).toFixed(3), via: prev.via });
      }
    }

    const queue = [...candidates.entries()]
      .filter(([w]) => {
        const known = DB.wallets[w];
        return !known || now() - known.vettedAt > 14 * DAY;
      })
      .sort((a, b) => (b[1].hits - a[1].hits) || (b[1].profit - a[1].profit))
      .slice(0, CFG.MAX_VET_PER_CYCLE);

    logLine(`cycle ${cycleNo} — vetting ${queue.length} new candidates`);
    for (const [w, meta] of queue) {
      try {
        const card = await vetWallet(w);
        if (!card) { logLine(`  ${w.slice(0, 6)}… skipped (too few matched round trips)`); continue; }
        storeCard(card, `${meta.via} · ${meta.hits} coin(s)`);
        const why = card.failedChecks.length ? ` — failed: ${card.failedChecks.join(", ")}` : "";
        logLine(`  ${w.slice(0, 6)}… ${card.verdict} (${card.passed}/${card.checksTotal}) ${card.stats.roiPct}% ROI on ${card.stats.matchedCostSol} SOL${why}`);
      } catch (e) { logLine(`  ${w.slice(0, 6)}… vet failed: ${e.message}`); }
    }

    const stale = Object.values(DB.wallets)
      .filter((w) => (w.verdict === "FOLLOW" || w.verdict === "WATCH")
        && now() - w.vettedAt > CFG.REVET_DAYS * DAY)
      .sort((a, b) => a.vettedAt - b.vettedAt)
      .slice(0, CFG.MAX_REVET_PER_CYCLE);
    for (const s of stale) {
      status = `re-vetting ${s.wallet.slice(0, 6)}…`;
      try {
        const card = await vetWallet(s.wallet);
        if (!card) continue;
        const before = s.verdict;
        storeCard(card, s.provenance);
        if (card.verdict !== before) logLine(`  re-vet ${s.wallet.slice(0, 6)}… ${before} → ${card.verdict}`);
      } catch {}
    }

    for (const w of Object.values(DB.wallets)) {
      w.dormant = w.lastActiveTs ? now() - w.lastActiveTs > CFG.DORMANT_DAYS * DAY : false;
    }

    DB.cycles = cycleNo;
    DB.lastCycleAt = now();
    DB.lastMode = mode;
    saveDb();
    const f = Object.values(DB.wallets).filter((w) => w.verdict === "FOLLOW" && !w.dormant).length;
    logLine(`cycle ${cycleNo} done — ${Object.keys(DB.wallets).length} known, ${f} active FOLLOW`);
  } catch (e) {
    logLine(`cycle ${cycleNo} error: ${e.message}`);
  } finally {
    running = false;
    status = `sleeping ${CFG.CYCLE_MINUTES}m · next cycle ${(DB.cycles + 1) % 2 === 0 ? "EXPANSION" : "TRENDING"}`;
  }
}

/* ── dashboard ──────────────────────────────────────────── */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function renderPage() {
  const all = Object.values(DB.wallets);
  const rank = { FOLLOW: 0, WATCH: 1, REJECT: 2 };
  all.sort((a, b) => (rank[a.verdict] - rank[b.verdict]) || ((b.stats.roiPct || 0) - (a.stats.roiPct || 0)));
  const follows = all.filter((w) => w.verdict === "FOLLOW" && !w.dormant);
  const watches = all.filter((w) => w.verdict === "WATCH" && !w.dormant);
  const dormant = all.filter((w) => w.dormant && w.verdict !== "REJECT");
  const nearMiss = all.filter((w) => w.verdict === "REJECT" && !w.dormant
    && w.passed >= (w.checksTotal || 13) - 2).slice(0, 8);
  const promoteList = follows.map((w) => w.wallet).join(",");

  const tally = {};
  for (const w of all) {
    for (const c of w.checks || []) {
      if (c.skip) continue;
      const t = (tally[c.name] ||= { fail: 0, seen: 0 });
      t.seen++;
      if (!c.pass) t.fail++;
    }
  }
  const tallyRows = Object.entries(tally)
    .sort((a, b) => (b[1].fail / b[1].seen) - (a[1].fail / a[1].seen))
    .map(([n, t]) => `<div class="tline"><span>${esc(n)}</span><span>${t.fail}/${t.seen}</span></div>`).join("");

  const ago = (ts) => {
    if (!ts) return "never";
    const d = now() - ts;
    if (d < 60) return `${d}s ago`;
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    if (d < DAY) return `${Math.floor(d / 3600)}h ago`;
    return `${Math.floor(d / DAY)}d ago`;
  };
  const trendMark = (t) => t === "improving" ? " ▲" : t === "declining" ? " ▼" : "";

  const row = (w) => `<li class="row ${w.verdict.toLowerCase()}"><div class="body">
    <div class="head"><span class="sym">${esc(w.wallet.slice(0, 6))}…${esc(w.wallet.slice(-4))}</span>
      <span class="x">${w.verdict} ${w.passed}/${w.checksTotal || 13}${trendMark(w.trend)}</span></div>
    <div class="meta"><b>${w.stats.roiPct ?? "?"}% ROI</b> · ${w.stats.realisedSol >= 0 ? "+" : ""}${w.stats.realisedSol} SOL on ${w.stats.matchedCostSol ?? "?"} deployed · ${w.stats.winRatePct}% win · hold ${w.stats.medianHoldMin}m</div>
    <div class="meta">${w.stats.visiblePct ?? "?"}% visible · ${w.stats.movedOutPct ?? 0}% moved out · ${w.stats.sizeRatio ?? "?"}x my stake · ${w.stats.closed} round trips · ${w.stats.txCount ?? "?"} txs · pool $${w.stats.medianPoolUsd.toLocaleString()}</div>
    ${(w.failedChecks && w.failedChecks.length) ? `<div class="meta fail">failed: ${esc(w.failedChecks.join(", "))}</div>` : ""}
    <div class="meta">via ${esc(w.provenance || "?")} · vetted ${ago(w.vettedAt)} · last traded ${ago(w.lastActiveTs)}</div>
    <div class="meta mono">${esc(w.wallet)}</div>
  </div></li>`;

  const logRows = (DB.log || []).slice(0, 25).map((l) =>
    `<li class="logline">${esc(l.at.slice(11, 19))} · ${esc(l.msg)}</li>`).join("");

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wallet Hunter</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<meta http-equiv="refresh" content="60">
<style>
  :root{--ground:#0F1418;--panel:#18201F;--edge:#28332F;--green:#5BD68A;--amber:#E8A33D;--slate:#6B7C74;--clay:#C4574A;--ink:#E4EFE9}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--ground);color:var(--ink);font-family:'IBM Plex Mono',monospace;font-size:13px;line-height:1.5;padding:20px 16px 60px}
  h1{font-family:'Space Grotesk',sans-serif;font-size:24px;margin-bottom:4px}
  h1 em{font-style:normal;color:var(--green)}
  .sub{color:var(--slate);font-size:11.5px;margin-bottom:14px}
  .cards{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px}
  .card{background:var(--panel);border:1px solid var(--edge);padding:10px 12px;min-width:84px;flex:1}
  .card b{font-size:17px;display:block}
  .card span{color:var(--slate);font-size:10px;text-transform:uppercase;letter-spacing:.08em}
  h2{font-family:'Space Grotesk',sans-serif;font-size:14px;margin:22px 0 10px}
  ul{list-style:none}
  .row{background:var(--panel);border:1px solid var(--edge);border-left:2px solid var(--slate);padding:11px 12px;margin-bottom:8px}
  .row.follow{border-left-color:var(--green)}
  .row.watch{border-left-color:var(--amber)}
  .row.reject{border-left-color:var(--clay);opacity:.65}
  .head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px}
  .sym{font-weight:600}
  .x{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:13px}
  .row.follow .x{color:var(--green)}
  .row.watch .x{color:var(--amber)}
  .row.reject .x{color:var(--clay)}
  .meta{color:var(--slate);font-size:10.5px;margin-top:2px}
  .meta b{color:var(--ink)}
  .meta.fail{color:var(--clay)}
  .mono{word-break:break-all;font-size:9.5px;user-select:all}
  .none{color:var(--slate);font-size:12px;padding:12px;background:var(--panel);border:1px dashed var(--edge)}
  .logline{color:var(--slate);font-size:10px;padding:2px 0;border-bottom:1px solid var(--edge)}
  .status{background:var(--panel);border:1px solid var(--edge);padding:10px 12px;font-size:11.5px;margin-bottom:14px}
  .promote{background:#12211A;border:1px solid var(--green);padding:10px 12px;margin-bottom:14px}
  .promote b{color:var(--green);font-size:11px;text-transform:uppercase;letter-spacing:.08em}
  .promote .val{word-break:break-all;font-size:10px;margin-top:6px;user-select:all;color:var(--ink)}
  .note{color:var(--slate);font-size:10px;margin-top:6px}
  .tally{background:var(--panel);border:1px solid var(--edge);padding:10px 12px;margin-bottom:14px}
  .tally b{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink)}
  .tline{display:flex;justify-content:space-between;color:var(--slate);font-size:10.5px;margin-top:3px}
  .warn{background:#241A14;border:1px solid var(--amber);padding:10px 12px;margin-bottom:14px;color:var(--amber);font-size:11px}
</style></head><body>
  <h1>Wallet <em>hunter</em></h1>
  <div class="sub">
    v6 · FIFO + transfer/visibility/size checks · cycle ${CFG.CYCLE_MINUTES}m · vet ${CFG.MAX_VET_PER_CYCLE}/cycle ·
    ROI ≥${CFG.MIN_ROI_PCT}% on ≥${CFG.MIN_DEPLOYED_SOL} SOL · ≥${CFG.MIN_VISIBLE_PCT}% visible · ≤${CFG.MAX_TRANSFER_OUT_PCT}% moved out ·
    ≤${CFG.MAX_SIZE_RATIO}x my ${CFG.MY_STAKE_SOL} SOL stake · pool ≥$${CFG.MIN_LIQ_USD.toLocaleString()} ·
    ${persistOk ? "database saved ✓" : "IN MEMORY ONLY"} · <a href="/db.json" style="color:var(--green)">db.json</a>
  </div>
  <div class="warn">This is a SHORTLIST, not a verdict. It sees one address over ${CFG.VET_DAYS} days. Operators who split flow across several wallets still pass. Check every candidate on GMGN before any money follows it.</div>
  <div class="status">▶ ${esc(status)}<br>cycles: ${DB.cycles} (last ${DB.lastMode || "—"}, ${ago(DB.lastCycleAt)}) · coins scanned: ${Object.keys(DB.seenCoins).length} · wallets known: ${all.length}</div>
  ${promoteList ? `<div class="promote"><b>Copy into FOLLOW_WALLETS (paper first)</b><div class="val">${esc(promoteList)}</div></div>` : ""}
  <div class="cards">
    <div class="card"><b style="color:var(--green)">${follows.length}</b><span>follow</span></div>
    <div class="card"><b style="color:var(--amber)">${watches.length}</b><span>watch</span></div>
    <div class="card"><b>${all.length}</b><span>vetted</span></div>
    <div class="card"><b>${dormant.length}</b><span>dormant</span></div>
  </div>
  ${tallyRows ? `<div class="tally"><b>What's rejecting them</b>${tallyRows}</div>` : ""}
  <h2>✅ Worth following</h2>
  ${follows.length ? `<ul>${follows.map(row).join("")}</ul>` : `<div class="none">None yet — the filters are strict by design.</div>`}
  <h2>👀 Watch list</h2>
  ${watches.length ? `<ul>${watches.map(row).join("")}</ul>` : `<div class="none">None yet.</div>`}
  ${nearMiss.length ? `<h2>⚠️ Near misses (within 2 checks)</h2><ul>${nearMiss.map(row).join("")}</ul>` : ""}
  ${dormant.length ? `<h2>💤 Dormant (no trades in ${CFG.DORMANT_DAYS}d)</h2><ul>${dormant.map(row).join("")}</ul>` : ""}
  <h2>Recent activity</h2>
  <ul>${logRows}</ul>
</body></html>`;
}

/* ── server + loop ──────────────────────────────────────── */

http.createServer((req, res) => {
  const p = req.url.split("?")[0];
  if (p === "/db.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status, cycles: DB.cycles, lastMode: DB.lastMode, wallets: DB.wallets }, null, 2));
  }
  if (p === "/promote.txt") {
    const list = Object.values(DB.wallets)
      .filter((w) => w.verdict === "FOLLOW" && !w.dormant)
      .sort((a, b) => b.stats.roiPct - a.stats.roiPct)
      .map((w) => w.wallet).join(",");
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end(list);
  }
  if (p === "/health") { res.writeHead(200); return res.end("ok"); }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(renderPage());
}).listen(CFG.PORT, () => {
  console.log(`Wallet hunter v6 on ${CFG.PORT} — persistence ${persistOk ? "ON" : "OFF"}`);
  if (!CFG.KEY) { status = "FAILED: HELIUS_API_KEY not set"; return; }
  cycle();
  setInterval(cycle, CFG.CYCLE_MINUTES * 60 * 1000);
});
