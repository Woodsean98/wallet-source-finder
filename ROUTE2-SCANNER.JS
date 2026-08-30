/**
 * ROUTE-2 SCANNER — find patient, profitable wallets from slow-grinder coins
 * Give it 2-4 token mints (coins that climbed over days). It pulls each
 * token's history via Helius, pairs every wallet's buys/sells, and surfaces
 * wallets that: bought early-ish (but NOT sniped the first minute), held
 * 10+ minutes, exited in profit — cross-referenced across your coins.
 * Run: node route2-scanner.js  (env: HELIUS_API_KEY, TOKEN_MINTS, HOURS=168)
 */
import http from "http";

const KEY = process.env.HELIUS_API_KEY || "";
const MINTS = (process.env.TOKEN_MINTS || "").split(",").map(s => s.trim()).filter(Boolean);
const HOURS = Number(process.env.HOURS || 168);
const PORT = Number(process.env.PORT || 3000);
const MIN_HOLD_MIN = Number(process.env.MIN_HOLD_MIN || 10);
const SNIPE_CUTOFF_S = Number(process.env.SNIPE_CUTOFF_S || 120);

const SOL_MINT = "So11111111111111111111111111111111111111112";
const QUOTES = new Set([SOL_MINT,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]);
const LAMPORTS = 1e9;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let status = "starting…";
let report = null;

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

async function fetchTokenTxs(mint) {
  const cutoff = Date.now() / 1000 - HOURS * 3600;
  const txs = [];
  let before = "";
  for (let page = 0; page < 80; page++) {
    status = `${mint.slice(0, 6)}… page ${page + 1} (${txs.length} txs)`;
    const url = `https://api.helius.xyz/v0/addresses/${mint}/transactions?api-key=${KEY}&limit=100${before ? `&before=${before}` : ""}`;
    const res = await fetch(url);
    if (res.status === 429) { await sleep(3500); page--; continue; }
    if (!res.ok) throw new Error(`helius ${res.status} on ${mint.slice(0, 6)}`);
    const batch = await res.json();
    if (!batch.length) break;
    txs.push(...batch);
    before = batch[batch.length - 1].signature;
    if (batch[batch.length - 1].timestamp < cutoff) break;
    await sleep(400);
  }
  return txs.filter(t => t.timestamp >= cutoff);
}

function analyseToken(mint, txs) {
  txs.sort((a, b) => a.timestamp - b.timestamp);
  const t0 = txs.length ? txs[0].timestamp : 0;
  const wallets = {};
  for (const tx of txs) {
    for (const tr of tx.tokenTransfers || []) {
      if (tr.mint !== mint) continue;
      const amt = Math.abs(Number(tr.tokenAmount || 0));
      if (!amt) continue;
      const buyer = tr.toUserAccount, seller = tr.fromUserAccount;
      if (buyer && !QUOTES.has(buyer)) {
        const { paid } = solLeg(tx, buyer);
        if (paid > 0.005) {
          const w = (wallets[buyer] ||= { buys: [], sells: [] });
          w.buys.push({ ts: tx.timestamp, sol: paid });
        }
      }
      if (seller && !QUOTES.has(seller)) {
        const { recv } = solLeg(tx, seller);
        if (recv > 0.005) {
          const w = (wallets[seller] ||= { buys: [], sells: [] });
          w.sells.push({ ts: tx.timestamp, sol: recv });
        }
      }
    }
  }
  const out = [];
  for (const [addr, w] of Object.entries(wallets)) {
    if (!w.buys.length || !w.sells.length) continue;
    const firstBuy = Math.min(...w.buys.map(b => b.ts));
    const lastSell = Math.max(...w.sells.map(s => s.ts));
    const buySol = w.buys.reduce((s, b) => s + b.sol, 0);
    const sellSol = w.sells.reduce((s, x) => s + x.sol, 0);
    const holdMin = (lastSell - firstBuy) / 60;
    const sniped = firstBuy - t0 <= SNIPE_CUTOFF_S;
    if (holdMin < MIN_HOLD_MIN) continue;
    if (sniped) continue;
    if (sellSol <= buySol * 1.05) continue;
    out.push({
      wallet: addr, buySol: +buySol.toFixed(3), sellSol: +sellSol.toFixed(3),
      profitSol: +(sellSol - buySol).toFixed(3),
      mult: +(sellSol / buySol).toFixed(2),
      holdMin: Math.round(holdMin),
      entryMinAfterLaunchWindow: Math.round((firstBuy - t0) / 60),
      buys: w.buys.length, sells: w.sells.length,
    });
  }
  out.sort((a, b) => b.profitSol - a.profitSol);
  return out.slice(0, 40);
}

(async () => {
  try {
    if (!KEY) throw new Error("HELIUS_API_KEY not set");
    if (!MINTS.length) throw new Error("TOKEN_MINTS not set (comma-separated mints)");
    const perToken = {};
    for (const mint of MINTS) {
      const txs = await fetchTokenTxs(mint);
      status = `analysing ${mint.slice(0, 6)}… (${txs.length} txs)`;
      perToken[mint] = analyseToken(mint, txs);
    }
    const seen = {};
    for (const [mint, rows] of Object.entries(perToken))
      for (const r of rows)
        (seen[r.wallet] ||= { wallet: r.wallet, coins: 0, totalProfit: 0, avgHoldMin: 0, entries: [] })
          .entries.push({ mint: mint.slice(0, 6), ...r });
    const cross = Object.values(seen).map(s => {
      s.coins = s.entries.length;
      s.totalProfit = +s.entries.reduce((a, e) => a + e.profitSol, 0).toFixed(3);
      s.avgHoldMin = Math.round(s.entries.reduce((a, e) => a + e.holdMin, 0) / s.entries.length);
      return s;
    }).sort((a, b) => (b.coins - a.coins) || (b.totalProfit - a.totalProfit));
    report = {
      tokens: MINTS.length, hoursBack: HOURS, minHoldMin: MIN_HOLD_MIN,
      note: "coins = how many of your tokens this wallet traded patiently AND profitably. 2+ coins = serious candidate. Vet on GMGN before monitoring.",
      multiCoinCandidates: cross.filter(c => c.coins >= 2).slice(0, 15),
      singleCoinTop: cross.filter(c => c.coins === 1).slice(0, 15),
    };
    status = "done";
  } catch (e) { status = `FAILED: ${e.message}`; }
})();

http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(report || { status }, null, 2));
}).listen(PORT, () => console.log(`route2 scanner on ${PORT}`));
