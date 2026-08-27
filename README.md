# Wallet Source Finder

Finds which wallets a target trader is likely copying, from public Solana chain data.

## Railway setup

1. New service in your Railway project, pointed at this repo
2. Variables tab — add:
   - HELIUS_API_KEY = your key from dashboard.helius.dev (free)
   - TARGET_WALLETS = wallet addresses, comma-separated
3. Settings > Networking > Generate Domain
4. Open the domain on your phone — it runs automatically and shows results when done

Optional variables: LOOKBACK_DAYS (default 30), WINDOW_SECONDS (90),
MAX_BUYS_PER_WALLET (300), MIN_HITS (3), AUTORUN (false = don't start on boot)

## Reading results

- Long bar, 20%+ hit rate, 5-90s ahead = probable source wallet
- Stub bar at near-zero with huge hit rate = sniper bot, ignore
- Precedes multiple targets = strongest signal
- Verify candidates on Solscan before following

## When finished

Stop or delete the service — rerunning on restart burns Helius credits.
