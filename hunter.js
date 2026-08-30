/**
 * WALLET HUNTER — never-ending search for followable traders
 * ----------------------------------------------------------
 * Loops forever:
 *   1. DISCOVER  pull trending Solana coins (GeckoTerminal, free) and filter
 *      to multi-day coins with real liquidity — the pond patient traders fish
 *   2. HARVEST   for each coin, find wallets that bought late enough to not be
 *      snipers, held 10+ minutes, and exited in profit
 *   3. VET       score each new candidate on the full followability checklist
 *   4. RANK      store verdicts in a league table (persists if /data mounted)
 *   5. SEED      best finds become next cycle's extra seeds via co-buyer scan
 *   6. SLEEP     then go again, forever
 *
 * Dashboard at "/" — ranked wallets, verdicts, stats, copy-ready addresses.
 * Live trading is NOT touched by this service. It only reads the chain.
 *
 * Env: HELIUS_API_KEY (required)
 *      CYCLE_MINUTES (default 45) · COINS_PER_CYCLE (6) · MAX_VET_PER_CYCLE (5)
 *      MIN_LIQ_USD (30000) · MIN_COIN_AGE_H (24) · VET_DAYS (30)
 *      MIN_HOLD_MIN (10) · MAX_TOKENS (400) · MIN_WR (25) · MAX_WR (75)
 *      DATA_DIR (/data)
 */

import http from "http";
import fs from "fs";
import path from "path";

const CFG = {
  KEY: process.env.HELIUS_API_KEY || "",
  PORT: Number(process.env.PORT || 3000),
  CYCLE_MINUTES: Number(process.env.CYCLE_MINUTES || 45),
  COINS_PER_CYCLE: Number(process.env.COINS_PER_CYCLE || 6),
  MAX_VET_PER_CYCLE: Number(process.env.MAX_VET_PER_CYCLE || 5),
  MIN_LIQ_USD: Number(process.env.MIN_LIQ_USD || 30000),
  MIN_COIN_AGE_H: Number(process.env.MIN_COIN_AGE_H || 24),
  VET_DAYS: Number(process.env.VET_DAYS || 30),
  MIN_HOLD_MIN: Number(process.env.MIN_HOLD_MIN || 10),
  MAX_TOKENS: Number(process.env.MAX_TOKENS || 400),
  MIN_WR: Number(process.env.MIN_WR || 25),
  MAX_WR: Number(process.env.MAX_WR || 75),
  MIN_BUY_SOL: Number(process.env.MIN_BUY_SOL || 0.05),
  SNIPE_CUTOFF_S: Number(process.env.SNIPE_CUTOFF_S || 120),
  COIN_PAGES: Number(process.env.COIN_PAGES || 10),
  WALLET_PAGES: Number(process.env.WALLET_PAGES || 40),
  DATA_DIR: process.env.DATA_DIR || "/data",
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
const LAMPORTS = 1e9;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);

/* ── persistence (optional) ─────────────────────────────── */

let persistOk = false;
const DB_FILE = path.join(CFG.DATA_DIR, "hunter-db.json");
try {
  fs.mkdirSync(CFG.DATA_DIR, { recursive: true });
  fs.appendFileSync(path.join(CFG.DATA_DIR, ".touch"), "");
  persistOk = true;
} catch { persistOk = false; }

const DB = {
  wallets: {},       // address -> scorecard
  seenCoins: {},     // mint -> lastScannedTs
  cycles: 0,
  startedAt: now(),
  lastCycleAt: null,
  log: [],
};

function loadDb() {
  if (!persistOk) return;
  try {
    if (!fs.existsSync(DB_FILE)) return;
    const j = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    Object.assign(DB, j, { startedAt: j.startedAt || now() });
  } catch (e) { console.warn("db load failed:", e.message); }
}
function saveDb() {
  if (!persistOk) return;
  try { fs.writeFileSync(DB_FILE, JSON.stringify(DB)); }
  catch (e) { console.warn("db save failed:", e.message); }
}
loadDb();

let status = "booting…";
function logLine(msg) {
  DB.log.unshift({ at: new Date().toISOString(), msg });
  while (DB.log.length > 60) DB.log.pop();
  console.log(msg);
}

/* ── helius helpers ─────────────────────────────────────── */

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

/* ── 1. DISCOVER: trending coins worth scanning ─────────── */

async function discoverCoins() {
  const out = [];
  const urls = [
    "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=1",
    "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=2",
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) { await sleep(2000); continue; }
      const j = await res.json();
      for (const p of j.data || []) {
        const a = p.attributes || {};
        const liq = Number(a.reserve_in_usd || 0);
        const created = a.pool_created_at ? Date.parse(a.pool_created_at) / 1000 : null;
        const ageH = created ? (now() - created) / 3600 : 999;
        const mint = (p.relationships?.base_token?.data?.id || "").replace("solana_", "");
        if (!mint || QUOTES.has(mint)) continue;
        if (liq < CFG.MIN_LIQ_USD) continue;
        if (ageH < CFG.MIN_COIN_AGE_H) continue;
        out.push({ mint, name: a.name || mint.slice(0, 8), liq: Math.round(liq), ageH: Math.round(ageH) });
      }
    } catch {}
    await sleep(2500);
  }
  // prefer coins we haven't scanned recently
  const fresh = out.filter((c) => !DB.seenCoins[c.mint] || now() - DB.seenCoins[c.mint] > 7 * 86400);
  const pool = fresh.length ? fresh : out;
  // shuffle so we don't scan the same top few every cycle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, CFG.COINS_PER_CYCLE);
}

/* ── 2. HARVEST: patient winners on a coin ──────────────── */

async function harvestCoin(coin) {
  const buyers = {};
  let before = "";
  let firstSeen = null;
  for (let page = 0; page < CFG.COIN_PAGES; page++) {
    status = `harvest ${coin.name} page ${page + 1}`;
    let batch;
    try { batch = await heliusPage(coin.mint, before); }
    catch { break; }
    if (batch === null) { page--; continue; }
    if (!batch.length) break;
    for (const tx of batch) {
      if (firstSeen === null || tx.timestamp < firstSeen) firstSeen = tx.timestamp;
      for (const tr of tx.tokenTransfers || []) {
        if (tr.mint !== coin.mint) continue;
        const buyer = tr.toUserAccount, seller = tr.fromUserAccount;
        if (buyer && !QUOTES.has(buyer) && !PROGRAMS.has(buyer)) {
          const { paid } = solLeg(tx, buyer);
          if (paid >= CFG.MIN_BUY_SOL) {
            const b = (buyers[buyer] ||= { buys: [], sells: [] });
            b.buys.push({ ts: tx.timestamp, sol: paid });
          }
        }
        if (seller && !QUOTES.has(seller) && !PROGRAMS.has(seller)) {
          const { recv } = solLeg(tx, seller);
          if (recv >= CFG.MIN_BUY_SOL) {
            const b = (buyers[seller] ||= { buys: [], sells: [] });
            b.sells.push({ ts: tx.timestamp, sol: recv });
          }
        }
      }
    }
    before = batch[batch.length - 1].signature;
    await sleep(400);
  }

  const winners = [];
  for (const [w, b] of Object.entries(buyers)) {
    if (!b.buys.length || !b.sells.length) continue;
    const firstBuy = Math.min(...b.buys.map((x) => x.ts));
    const lastSell = Math.max(...b.sells.map((x) => x.ts));
    const buySol = b.buys.reduce((s, x) => s + x.sol, 0);
    const sellSol = b.sells.reduce((s, x) => s + x.sol, 0);
    const holdMin = (lastSell - firstBuy) / 60;
    if (firstSeen !== null && firstBuy - firstSeen <= CFG.SNIPE_CUTOFF_S) continue;  // sniper
    if (holdMin < CFG.MIN_HOLD_MIN) continue;                                        // scalper
    if (sellSol <= buySol * 1.05) continue;                                          // not a winner
    winners.push({ wallet: w, profitSol: +(sellSol - buySol).toFixed(3), holdMin: Math.round(holdMin) });
  }
  winners.sort((a, b) => b.profitSol - a.profitSol);
  DB.seenCoins[coin.mint] = now();
  return winners.slice(0, 8);
}

/* ── 3. VET: full scorecard for one wallet ──────────────── */

async function fetchWalletTxs(wallet) {
  const cutoff = now() - CFG.VET_DAYS * 86400;
  const txs = [];
  let before = "";
  for (let page = 0; page < CFG.WALLET_PAGES; page++) {
    status = `vet ${wallet.slice(0, 6)}… page ${page + 1}`;
    let batch;
    try { batch = await heliusPage(wallet, before); }
    catch { break; }
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

  const perMint = {};
  let airdropped = 0;
  for (const tx of txs) {
    const { paid, recv } = solLeg(tx, wallet);
    for (const tr of tx.tokenTransfers || []) {
      if (!tr.mint || QUOTES.has(tr.mint)) continue;
      const amt = Math.abs(Number(tr.tokenAmount || 0));
      if (!amt) continue;
      if (tr.toUserAccount === wallet) {
        const m = (perMint[tr.mint] ||= { buys: [], sells: [] });
        if (paid > 0.002) m.buys.push({ ts: tx.timestamp, sol: paid });
        else airdropped++;
      } else if (tr.fromUserAccount === wallet) {
        const m = (perMint[tr.mint] ||= { buys: [], sells: [] });
        if (recv > 0.002) m.sells.push({ ts: tx.timestamp, sol: recv });
      }
    }
  }

  const positions = [];
  for (const [mint, m] of Object.entries(perMint)) {
    if (!m.buys.length) continue;
    const buySol = m.buys.reduce((s, b) => s + b.sol, 0);
    const sellSol = m.sells.reduce((s, x) => s + x.sol, 0);
    const firstBuy = Math.min(...m.buys.map((b) => b.ts));
    const lastSell = m.sells.length ? Math.max(...m.sells.map((s) => s.ts)) : null;
    positions.push({
      mint, buySol, sellSol, closed: !!m.sells.length,
      pnl: m.sells.length ? sellSol - buySol : 0,
      holdMin: lastSell ? (lastSell - firstBuy) / 60 : null,
      firstBuy,
    });
  }
  if (!positions.length) return null;

  const closed = positions.filter((p) => p.closed);
  if (closed.length < 3) return null;
  const wins = closed.filter((p) => p.pnl > 0);
  const totalPnl = closed.reduce((s, p) => s + p.pnl, 0);
  const holds = closed.map((p) => p.holdMin).filter((h) => h !== null).sort((a, b) => a - b);
  const medHold = holds.length ? holds[Math.floor(holds.length / 2)] : 0;
  const fastFlips = closed.filter((p) => p.holdMin !== null && p.holdMin < 1 / 12).length;
  const fastPct = (fastFlips / closed.length) * 100;
  const winRate = (wins.length / closed.length) * 100;

  const byDay = {};
  for (const p of closed) {
    const d = new Date(p.firstBuy * 1000).toISOString().slice(0, 10);
    byDay[d] = (byDay[d] || 0) + p.pnl;
  }
  const days = Object.values(byDay);
  const greenDays = days.filter((v) => v > 0).length;

  const recentMints = positions.sort((a, b) => b.firstBuy - a.firstBuy).map((p) => p.mint);
  status = `vet ${wallet.slice(0, 6)}… liquidity`;
  const liq = (await liquiditySample(recentMints)).filter((v) => v > 0).sort((a, b) => a - b);
  const medLiq = liq.length ? liq[Math.floor(liq.length / 2)] : 0;

  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass, detail });
  add("hold duration", medHold >= CFG.MIN_HOLD_MIN, `median ${medHold.toFixed(0)}m`);
  add("not a scalper", fastPct <= 10, `${fastPct.toFixed(0)}% exits <5s`);
  add("human pace", positions.length <= CFG.MAX_TOKENS, `${positions.length} tokens/${CFG.VET_DAYS}d`);
  add("win rate band", winRate >= CFG.MIN_WR && winRate <= CFG.MAX_WR, `${winRate.toFixed(0)}%`);
  add("profitable", totalPnl > 0, `${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)} SOL`);
  add("tradeable liquidity", medLiq >= CFG.MIN_LIQ_USD, `median pool $${Math.round(medLiq).toLocaleString()}`);
  add("consistent", days.length >= 4 && greenDays / days.length >= 0.4, `${greenDays}/${days.length} green days`);
  add("clean wallet", airdropped / Math.max(positions.length, 1) < 0.5, `${airdropped} airdrops`);

  const passed = checks.filter((c) => c.pass).length;
  const critical = ["hold duration", "not a scalper", "profitable"];
  const criticalFail = checks.some((c) => critical.includes(c.name) && !c.pass);
  const verdict = criticalFail ? "REJECT" : passed >= 7 ? "FOLLOW" : passed >= 5 ? "WATCH" : "REJECT";

  return {
    wallet, verdict, passed, checksTotal: checks.length,
    vettedAt: now(),
    stats: {
      tokens: positions.length, closed: closed.length,
      winRatePct: +winRate.toFixed(1),
      realisedSol: +totalPnl.toFixed(3),
      medianHoldMin: +medHold.toFixed(1),
      fastFlipPct: +fastPct.toFixed(1),
      medianPoolUsd: Math.round(medLiq),
      greenDays, totalDays: days.length,
    },
    checks,
  };
}

/* ── 4/5. CYCLE ─────────────────────────────────────────── */

let running = false;

async function cycle() {
  if (running) return;
  running = true;
  const cycleNo = DB.cycles + 1;
  try {
    logLine(`cycle ${cycleNo} — discovering coins`);
    status = "discovering trending coins";
    const coins = await discoverCoins();
    if (!coins.length) { logLine(`cycle ${cycleNo} — no coins passed filters`); }

    const candidates = new Map();
    for (const c of coins) {
      status = `harvesting ${c.name} ($${c.liq.toLocaleString()}, ${c.ageH}h)`;
      const winners = await harvestCoin(c);
      logLine(`  ${c.name}: ${winners.length} patient winners`);
      for (const w of winners) {
        const prev = candidates.get(w.wallet) || { hits: 0, profit: 0 };
        candidates.set(w.wallet, {
          hits: prev.hits + 1,
          profit: +(prev.profit + w.profitSol).toFixed(3),
        });
      }
    }

    // prioritise: multi-coin first, then biggest profit, skip already-vetted-recently
    const queue = [...candidates.entries()]
      .filter(([w]) => {
        const known = DB.wallets[w];
        return !known || now() - known.vettedAt > 14 * 86400;
      })
      .sort((a, b) => (b[1].hits - a[1].hits) || (b[1].profit - a[1].profit))
      .slice(0, CFG.MAX_VET_PER_CYCLE);

    logLine(`cycle ${cycleNo} — vetting ${queue.length} candidates`);
    for (const [w, meta] of queue) {
      try {
        const card = await vetWallet(w);
        if (!card) continue;
        card.discoveredVia = `${meta.hits} trending coin(s)`;
        DB.wallets[w] = card;
        logLine(`  ${w.slice(0, 6)}… ${card.verdict} (${card.passed}/${card.checksTotal})`);
      } catch (e) {
        logLine(`  ${w.slice(0, 6)}… vet failed: ${e.message}`);
      }
    }

    DB.cycles = cycleNo;
    DB.lastCycleAt = now();
    saveDb();
    const follows = Object.values(DB.wallets).filter((w) => w.verdict === "FOLLOW").length;
    logLine(`cycle ${cycleNo} done — ${Object.keys(DB.wallets).length} wallets known, ${follows} FOLLOW`);
  } catch (e) {
    logLine(`cycle ${cycleNo} error: ${e.message}`);
  } finally {
    running = false;
    status = `sleeping ${CFG.CYCLE_MINUTES}m until next cycle`;
  }
}

/* ── dashboard ──────────────────────────────────────────── */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function renderPage() {
  const all = Object.values(DB.wallets);
  const rank = { FOLLOW: 0, WATCH: 1, REJECT: 2 };
  all.sort((a, b) => (rank[a.verdict] - rank[b.verdict]) || (b.stats.realisedSol - a.stats.realisedSol));
  const follows = all.filter((w) => w.verdict === "FOLLOW");
  const watches = all.filter((w) => w.verdict === "WATCH");
  const ago = (ts) => {
    if (!ts) return "never";
    const d = now() - ts;
    if (d < 60) return `${d}s ago`;
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    return `${Math.floor(d / 3600)}h ago`;
  };

  const row = (w) => `<li class="row ${w.verdict.toLowerCase()}"><div class="body">
    <div class="head"><span class="sym">${esc(w.wallet.slice(0, 6))}…${esc(w.wallet.slice(-4))}</span>
      <span class="x">${w.verdict} ${w.passed}/${w.checksTotal}</span></div>
    <div class="meta">${w.stats.realisedSol >= 0 ? "+" : ""}${w.stats.realisedSol} SOL · ${w.stats.winRatePct}% win · hold ${w.stats.medianHoldMin}m · ${w.stats.tokens} tokens · pool $${w.stats.medianPoolUsd.toLocaleString()}</div>
    <div class="meta">${esc(w.discoveredVia || "")} · vetted ${ago(w.vettedAt)}</div>
    <div class="meta mono">${esc(w.wallet)}</div>
  </div></li>`;

  const logRows = (DB.log || []).slice(0, 20).map((l) =>
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
  .card{background:var(--panel);border:1px solid var(--edge);padding:10px 12px;min-width:88px;flex:1}
  .card b{font-size:17px;display:block}
  .card span{color:var(--slate);font-size:10px;text-transform:uppercase;letter-spacing:.08em}
  h2{font-family:'Space Grotesk',sans-serif;font-size:14px;margin:22px 0 10px}
  ul{list-style:none}
  .row{background:var(--panel);border:1px solid var(--edge);border-left:2px solid var(--slate);padding:11px 12px;margin-bottom:8px}
  .row.follow{border-left-color:var(--green)}
  .row.watch{border-left-color:var(--amber)}
  .row.reject{border-left-color:var(--clay);opacity:.45}
  .head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px}
  .sym{font-weight:600}
  .x{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:13px}
  .row.follow .x{color:var(--green)}
  .row.watch .x{color:var(--amber)}
  .row.reject .x{color:var(--clay)}
  .meta{color:var(--slate);font-size:10.5px;margin-top:2px}
  .mono{word-break:break-all;font-size:9.5px;user-select:all}
  .none{color:var(--slate);font-size:12px;padding:12px;background:var(--panel);border:1px dashed var(--edge)}
  .logline{color:var(--slate);font-size:10px;padding:2px 0;border-bottom:1px solid var(--edge)}
  .status{background:var(--panel);border:1px solid var(--edge);padding:10px 12px;font-size:11.5px;margin-bottom:14px}
</style></head><body>
  <h1>Wallet <em>hunter</em></h1>
  <div class="sub">
    cycle every ${CFG.CYCLE_MINUTES}m · ${CFG.COINS_PER_CYCLE} coins/cycle · vet ${CFG.MAX_VET_PER_CYCLE}/cycle ·
    filters: hold ≥${CFG.MIN_HOLD_MIN}m · win ${CFG.MIN_WR}-${CFG.MAX_WR}% · pool ≥$${CFG.MIN_LIQ_USD.toLocaleString()} · coins ≥${CFG.MIN_COIN_AGE_H}h old ·
    ${persistOk ? "database saved ✓" : "IN MEMORY ONLY (mount /data)"} · <a href="/db.json" style="color:var(--green)">db.json</a>
  </div>
  <div class="status">▶ ${esc(status)}<br>cycles run: ${DB.cycles} · last: ${ago(DB.lastCycleAt)} · coins scanned: ${Object.keys(DB.seenCoins).length}</div>
  <div class="cards">
    <div class="card"><b style="color:var(--green)">${follows.length}</b><span>follow</span></div>
    <div class="card"><b style="color:var(--amber)">${watches.length}</b><span>watch</span></div>
    <div class="card"><b>${all.length}</b><span>vetted</span></div>
  </div>
  <h2>✅ Worth following</h2>
  ${follows.length ? `<ul>${follows.map(row).join("")}</ul>` : `<div class="none">None yet — first cycle takes ~20 minutes.</div>`}
  <h2>👀 Watch list</h2>
  ${watches.length ? `<ul>${watches.map(row).join("")}</ul>` : `<div class="none">None yet.</div>`}
  <h2>Recent activity</h2>
  <ul>${logRows}</ul>
</body></html>`;
}

/* ── server + loop ──────────────────────────────────────── */

http.createServer((req, res) => {
  const p = req.url.split("?")[0];
  if (p === "/db.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status, cycles: DB.cycles, wallets: DB.wallets }, null, 2));
  }
  if (p === "/health") { res.writeHead(200); return res.end("ok"); }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(renderPage());
}).listen(CFG.PORT, () => {
  console.log(`Wallet hunter on ${CFG.PORT} — persistence ${persistOk ? "ON" : "OFF"}`);
  if (!CFG.KEY) { status = "FAILED: HELIUS_API_KEY not set"; return; }
  cycle();
  setInterval(cycle, CFG.CYCLE_MINUTES * 60 * 1000);
});
