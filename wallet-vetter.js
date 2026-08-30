/**
 * WALLET VETTER — automated followability scoring
 * ------------------------------------------------
 * Scores any Solana wallet on the checklist built from real losses:
 *   avg hold duration · fast-flip % · unique tokens · win rate ·
 *   realized PnL · trade size · liquidity of the coins they trade ·
 *   daily consistency
 * Verdict: FOLLOW (worth paper-auditioning) / WATCH / REJECT.
 *
 * Run: node wallet-vetter.js
 * Env: HELIUS_API_KEY, WALLETS (comma-separated), DAYS (default 30)
 *      MIN_HOLD_MIN (10), MAX_TOKENS (400), MIN_WR (25), MAX_WR (75),
 *      MIN_LIQ_USD (30000)
 */
import http from "http";

const KEY = process.env.HELIUS_API_KEY || "";
const WALLETS = (process.env.WALLETS || "").split(",").map(s => s.trim()).filter(Boolean);
const DAYS = Number(process.env.DAYS || 30);
const PORT = Number(process.env.PORT || 3000);
const MIN_HOLD_MIN = Number(process.env.MIN_HOLD_MIN || 10);
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 400);
const MIN_WR = Number(process.env.MIN_WR || 25);
const MAX_WR = Number(process.env.MAX_WR || 75);
const MIN_LIQ_USD = Number(process.env.MIN_LIQ_USD || 30000);
const MAX_PAGES = Number(process.env.MAX_PAGES || 60);

const SOL_MINT = "So11111111111111111111111111111111111111112";
const QUOTES = new Set([SOL_MINT,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]);
const LAMPORTS = 1e9;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let status = "starting…";
let report = null;

/* ── SOL in/out for a wallet in one tx ─────────────────── */
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
    if (a < 0.001) continue;
    if (t.fromUserAccount === wallet) paid = Math.max(paid, a);
    if (t.toUserAccount === wallet) recv = Math.max(recv, a);
  }
  return { paid, recv };
}

/* ── fetch wallet history ──────────────────────────────── */
async function fetchWalletTxs(wallet) {
  const cutoff = Date.now() / 1000 - DAYS * 86400;
  const txs = [];
  let before = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    status = `${wallet.slice(0, 6)}… page ${page + 1} (${txs.length} txs)`;
    const url = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${KEY}&limit=100${before ? `&before=${before}` : ""}`;
    const res = await fetch(url);
    if (res.status === 429) { await sleep(3500); page--; continue; }
    if (!res.ok) throw new Error(`helius ${res.status}`);
    const batch = await res.json();
    if (!batch.length) break;
    txs.push(...batch);
    before = batch[batch.length - 1].signature;
    if (batch[batch.length - 1].timestamp < cutoff) break;
    await sleep(350);
  }
  return txs.filter(t => t.timestamp >= cutoff);
}

/* ── liquidity sample via Dexscreener (free) ───────────── */
async function liquiditySample(mints) {
  const out = [];
  for (const m of mints.slice(0, 15)) {
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${m}`);
      if (!res.ok) { await sleep(300); continue; }
      const j = await res.json();
      const pairs = (j.pairs || []).filter(p => p.chainId === "solana");
      if (!pairs.length) { out.push(0); await sleep(300); continue; }
      pairs.sort((a, b) => (Number(b.liquidity?.usd) || 0) - (Number(a.liquidity?.usd) || 0));
      out.push(Number(pairs[0].liquidity?.usd) || 0);
    } catch {}
    await sleep(300);
  }
  return out;
}

/* ── analyse one wallet ────────────────────────────────── */
async function analyseWallet(wallet) {
  const txs = await fetchWalletTxs(wallet);
  status = `analysing ${wallet.slice(0, 6)}… (${txs.length} txs)`;
  txs.sort((a, b) => a.timestamp - b.timestamp);

  const perMint = {};
  let receivedNoBuy = 0;

  for (const tx of txs) {
    const { paid, recv } = solLeg(tx, wallet);
    for (const tr of tx.tokenTransfers || []) {
      if (!tr.mint || QUOTES.has(tr.mint)) continue;
      const amt = Math.abs(Number(tr.tokenAmount || 0));
      if (!amt) continue;
      if (tr.toUserAccount === wallet) {
        const m = (perMint[tr.mint] ||= { buys: [], sells: [], airdropped: 0 });
        if (paid > 0.002) m.buys.push({ ts: tx.timestamp, sol: paid });
        else { m.airdropped++; receivedNoBuy++; }
      } else if (tr.fromUserAccount === wallet) {
        const m = (perMint[tr.mint] ||= { buys: [], sells: [], airdropped: 0 });
        if (recv > 0.002) m.sells.push({ ts: tx.timestamp, sol: recv });
      }
    }
  }

  const positions = [];
  for (const [mint, m] of Object.entries(perMint)) {
    if (!m.buys.length) continue;
    const buySol = m.buys.reduce((s, b) => s + b.sol, 0);
    const sellSol = m.sells.reduce((s, x) => s + x.sol, 0);
    const firstBuy = Math.min(...m.buys.map(b => b.ts));
    const lastSell = m.sells.length ? Math.max(...m.sells.map(s => s.ts)) : null;
    positions.push({
      mint, buySol, sellSol, closed: !!m.sells.length,
      pnl: m.sells.length ? sellSol - buySol : 0,
      holdMin: lastSell ? (lastSell - firstBuy) / 60 : null,
      entries: m.buys.length, exits: m.sells.length, firstBuy,
    });
  }

  const closed = positions.filter(p => p.closed);
  const wins = closed.filter(p => p.pnl > 0);
  const totalPnl = closed.reduce((s, p) => s + p.pnl, 0);
  const holds = closed.map(p => p.holdMin).filter(h => h !== null).sort((a, b) => a - b);
  const medHold = holds.length ? holds[Math.floor(holds.length / 2)] : 0;
  const avgHold = holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : 0;
  const fastFlips = closed.filter(p => p.holdMin !== null && p.holdMin < 1 / 12).length; // <5s
  const sizes = positions.map(p => p.buySol).sort((a, b) => a - b);
  const medSize = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;

  // daily consistency
  const byDay = {};
  for (const p of closed) {
    const d = new Date((p.firstBuy || 0) * 1000).toISOString().slice(0, 10);
    byDay[d] = (byDay[d] || 0) + p.pnl;
  }
  const days = Object.values(byDay);
  const greenDays = days.filter(v => v > 0).length;

  // liquidity of what they trade (most recent mints first)
  const recentMints = positions.sort((a, b) => b.firstBuy - a.firstBuy).map(p => p.mint);
  status = `liquidity sample ${wallet.slice(0, 6)}…`;
  const liq = await liquiditySample(recentMints);
  const liqSorted = liq.filter(v => v > 0).sort((a, b) => a - b);
  const medLiq = liqSorted.length ? liqSorted[Math.floor(liqSorted.length / 2)] : 0;

  const winRate = closed.length ? (wins.length / closed.length) * 100 : 0;
  const fastPct = closed.length ? (fastFlips / closed.length) * 100 : 0;
  const tradesPerDay = positions.length / DAYS;

  /* ── scoring ── */
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass, detail });

  add("hold duration", medHold >= MIN_HOLD_MIN,
    `median ${medHold.toFixed(0)}m / avg ${avgHold.toFixed(0)}m (need ≥${MIN_HOLD_MIN}m)`);
  add("not a scalper", fastPct <= 10,
    `${fastPct.toFixed(0)}% of exits under 5s (need ≤10%)`);
  add("human pace", positions.length <= MAX_TOKENS,
    `${positions.length} tokens in ${DAYS}d, ${tradesPerDay.toFixed(1)}/day (need ≤${MAX_TOKENS})`);
  add("win rate band", winRate >= MIN_WR && winRate <= MAX_WR,
    `${winRate.toFixed(0)}% (need ${MIN_WR}-${MAX_WR}%)`);
  add("profitable", totalPnl > 0,
    `${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)} SOL realised over ${closed.length} closed`);
  add("tradeable liquidity", medLiq >= MIN_LIQ_USD,
    `median pool $${Math.round(medLiq).toLocaleString()} (need ≥$${MIN_LIQ_USD.toLocaleString()})`);
  add("consistent", days.length >= 5 && greenDays / Math.max(days.length, 1) >= 0.4,
    `${greenDays}/${days.length} green days`);
  add("clean wallet", receivedNoBuy / Math.max(positions.length, 1) < 0.5,
    `${receivedNoBuy} airdropped tokens vs ${positions.length} bought`);

  const passed = checks.filter(c => c.pass).length;
  const critical = ["hold duration", "not a scalper", "profitable"];
  const criticalFail = checks.some(c => critical.includes(c.name) && !c.pass);
  const verdict = criticalFail ? "REJECT" : passed >= 7 ? "FOLLOW" : passed >= 5 ? "WATCH" : "REJECT";

  return {
    wallet, verdict, score: `${passed}/${checks.length}`,
    summary: {
      tokens: positions.length, closedPositions: closed.length,
      winRatePct: +winRate.toFixed(1),
      realisedSol: +totalPnl.toFixed(3),
      medianHoldMin: +medHold.toFixed(1),
      avgHoldMin: +avgHold.toFixed(1),
      fastFlipPct: +fastPct.toFixed(1),
      medianPositionSol: +medSize.toFixed(3),
      medianPoolLiquidityUsd: Math.round(medLiq),
      tradesPerDay: +tradesPerDay.toFixed(1),
      greenDays, totalDays: days.length,
    },
    checks,
    biggestWins: closed.sort((a, b) => b.pnl - a.pnl).slice(0, 3)
      .map(p => ({ mint: p.mint.slice(0, 8), pnlSol: +p.pnl.toFixed(2), holdMin: Math.round(p.holdMin || 0) })),
  };
}

/* ── run ───────────────────────────────────────────────── */
(async () => {
  try {
    if (!KEY) throw new Error("HELIUS_API_KEY not set");
    if (!WALLETS.length) throw new Error("WALLETS not set (comma-separated addresses)");
    const results = [];
    for (const w of WALLETS) {
      try { results.push(await analyseWallet(w)); }
      catch (e) { results.push({ wallet: w, verdict: "ERROR", error: e.message }); }
    }
    const rank = { FOLLOW: 0, WATCH: 1, REJECT: 2, ERROR: 3 };
    results.sort((a, b) => rank[a.verdict] - rank[b.verdict]);
    report = {
      lookbackDays: DAYS,
      thresholds: { MIN_HOLD_MIN, MAX_TOKENS, MIN_WR, MAX_WR, MIN_LIQ_USD },
      note: "FOLLOW = worth paper-auditioning. WATCH = borderline. REJECT = wrong shape for slow execution.",
      results,
    };
    status = "done";
  } catch (e) { status = `FAILED: ${e.message}`; }
})();

http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(report || { status }, null, 2));
}).listen(PORT, () => console.log(`wallet vetter on ${PORT}`));
