/**
 * FHPC CONVICTION ANALYZER — one-off
 * Pulls AEF2 (FHpc's trading wallet) history for the last 24h via Helius,
 * pairs buys/sells per token, reports his own PnL on entries >= MIN_SOL.
 * Run: node analyze-fhpc.js   (needs HELIUS_API_KEY)
 * Env: MIN_SOL (default 1), HOURS (default 24), TARGET (default AEF2)
 */
import http from "http";

const KEY = process.env.HELIUS_API_KEY || "";
const TARGET = process.env.TARGET || "AEF2PVNxExF5hLM28mgFpRhSTFQ92SAWLpHVRCsi486V";
const MIN_SOL = Number(process.env.MIN_SOL || 1);
const HOURS = Number(process.env.HOURS || 24);
const PORT = Number(process.env.PORT || 3000);

const SOL_MINT = "So11111111111111111111111111111111111111112";
const QUOTES = new Set([
  SOL_MINT,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);
const LAMPORTS = 1e9;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let status = "starting…";
let report = null;

function solLegs(tx, wallet) {
  // SOL the wallet paid / received in this tx (native + wSOL, swap-event first)
  let inSol = 0, outSol = 0;
  const swap = tx.events && tx.events.swap;
  if (swap) {
    if (swap.nativeInput?.account === wallet) inSol += Number(swap.nativeInput.amount || 0) / LAMPORTS;
    if (swap.nativeOutput?.account === wallet) outSol += Number(swap.nativeOutput.amount || 0) / LAMPORTS;
    for (const t of swap.tokenInputs || []) {
      if (t.mint === SOL_MINT && t.userAccount === wallet) {
        const r = t.rawTokenAmount;
        inSol += r ? Math.abs(Number(r.tokenAmount)) / 10 ** Number(r.decimals ?? 9) : 0;
      }
    }
    for (const t of swap.tokenOutputs || []) {
      if (t.mint === SOL_MINT && t.userAccount === wallet) {
        const r = t.rawTokenAmount;
        outSol += r ? Math.abs(Number(r.tokenAmount)) / 10 ** Number(r.decimals ?? 9) : 0;
      }
    }
  }
  for (const t of tx.tokenTransfers || []) {
    if (t.mint !== SOL_MINT) continue;
    const a = Math.abs(Number(t.tokenAmount || 0));
    if (t.fromUserAccount === wallet) inSol = Math.max(inSol, a);
    if (t.toUserAccount === wallet) outSol = Math.max(outSol, a);
  }
  return { inSol, outSol };
}

function tokenLegs(tx, wallet) {
  // non-quote tokens bought (+) / sold (−) by wallet in this tx
  const legs = {};
  for (const t of tx.tokenTransfers || []) {
    if (!t.mint || QUOTES.has(t.mint)) continue;
    const a = Math.abs(Number(t.tokenAmount || 0));
    if (t.toUserAccount === wallet) legs[t.mint] = (legs[t.mint] || 0) + a;
    if (t.fromUserAccount === wallet) legs[t.mint] = (legs[t.mint] || 0) - a;
  }
  return legs;
}

async function fetchAll() {
  const cutoff = Date.now() / 1000 - HOURS * 3600;
  const txs = [];
  let before = "";
  for (let page = 0; page < 60; page++) {
    status = `fetching page ${page + 1}… (${txs.length} txs)`;
    const url = `https://api.helius.xyz/v0/addresses/${TARGET}/transactions?api-key=${KEY}&limit=100${before ? `&before=${before}` : ""}`;
    const res = await fetch(url);
    if (res.status === 429) { await sleep(3000); page--; continue; }
    if (!res.ok) throw new Error(`helius ${res.status}`);
    const batch = await res.json();
    if (!batch.length) break;
    for (const tx of batch) txs.push(tx);
    before = batch[batch.length - 1].signature;
    if (batch[batch.length - 1].timestamp < cutoff) break;
    await sleep(350);
  }
  return txs.filter((t) => t.timestamp >= cutoff);
}

function analyse(txs) {
  txs.sort((a, b) => a.timestamp - b.timestamp);
  const coins = {}; // mint -> {buySol, sellSol, buys[], firstBuySol, tokensNet}
  for (const tx of txs) {
    const legs = tokenLegs(tx, TARGET);
    const { inSol, outSol } = solLegs(tx, TARGET);
    for (const [mint, amt] of Object.entries(legs)) {
      const c = (coins[mint] ||= { buySol: 0, sellSol: 0, buys: [], tokensNet: 0, firstBuy: null });
      c.tokensNet += amt;
      if (amt > 0 && inSol > 0) {          // bought tokens, paid SOL
        c.buySol += inSol;
        c.buys.push(inSol);
        if (c.firstBuy === null) c.firstBuy = inSol;
      } else if (amt < 0 && outSol > 0) {  // sold tokens, received SOL
        c.sellSol += outSol;
      }
    }
  }

  const rows = [];
  for (const [mint, c] of Object.entries(coins)) {
    if (!c.buys.length) continue;
    const maxBuy = Math.max(...c.buys);
    const closed = c.tokensNet <= c.tokensNet * 0.02 + 1; // roughly fully exited
    rows.push({
      mint, buySol: +c.buySol.toFixed(3), sellSol: +c.sellSol.toFixed(3),
      pnl: +(c.sellSol - c.buySol).toFixed(3), maxBuy: +maxBuy.toFixed(3),
      trades: c.buys.length, closed,
    });
  }
  const conviction = rows.filter((r) => r.maxBuy >= MIN_SOL);
  const rest = rows.filter((r) => r.maxBuy < MIN_SOL);
  const sum = (a, f) => +a.reduce((s, r) => s + r[f], 0).toFixed(3);
  return {
    hours: HOURS, target: TARGET, minSol: MIN_SOL,
    coinsTotal: rows.length,
    conviction: {
      count: conviction.length,
      wins: conviction.filter((r) => r.pnl > 0).length,
      totalPnl: sum(conviction, "pnl"),
      totalIn: sum(conviction, "buySol"),
      coins: conviction.sort((a, b) => b.pnl - a.pnl),
    },
    below: {
      count: rest.length,
      wins: rest.filter((r) => r.pnl > 0).length,
      totalPnl: sum(rest, "pnl"),
    },
    note: "PnL = his SOL out minus SOL in per coin, over the window. Open positions understate. This is HIS pnl at HIS execution — yours would be lower.",
  };
}

(async () => {
  try {
    if (!KEY) throw new Error("HELIUS_API_KEY not set");
    const txs = await fetchAll();
    status = `analysing ${txs.length} txs…`;
    report = analyse(txs);
    status = "done";
  } catch (e) {
    status = `FAILED: ${e.message}`;
  }
})();

http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(report || { status }, null, 2));
}).listen(PORT, () => console.log(`analyzer on ${PORT}`));
