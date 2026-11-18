[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Onefine8/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Onefine8/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Launch Radar — 202 pre-token protocols scored by a comps curve (mcap = 1058 · TVL^0.522) fitted on the 128 priced protocols in the snapshot, each with a value band, launch odds, and a farm plan costed to the dollar, with a FARM / THIN / SKIP verdict taken from the farmer's expected net. Built for make.fun's "Build the best token launch radar" bounty, $1,325 in USDC.

## Run it

```sh
node main.ts --input /input --output /output
```

Give it a directory holding `snapshot.json` (the competition kit's `input/`) and it writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` into the output directory. Node 22, stdlib only, no network, deterministic — two runs on the same snapshot are byte-identical.

## How it scores

The snapshot (DefiLlama protocols, 2026-11-14) lists 758 protocols; 128 already have a token and 342 do not. The 128 priced ones teach the model: a log-log comps curve `mcap = a · TVL^b`, refit from the snapshot at runtime. Validation is four-way and blind: leave-one-out median |log error| 1.22 (vs 1.59 for the flat 0.25× multiple), blind time-split 70/30 median 1.21 and 60/40 median 1.18 (train on the oldest listings, test on the newest), walk-forward median 1.12 (expanding window, 4 folds), and a 200-refit bootstrap with slope 90% CI [0.378, 0.672]. Eight rival variants — sector offsets, growth tilt, age, sector+growth, Huber, a TVL offset, and a mcap-floor fit — are tested live on the same snapshot in the runtime ablation table; none beats the plain curve on both leave-one-out and walk-forward, so the curve is the whole model. The full experiment tables are in `v3/scripts/experiment-v3*.mjs`.

The board ranks the full 40-protocol house watchlist plus every other genuine pre-token launch candidate (202 rows). Every row carries a value band (5th–95th percentile of the 200 bootstrap refits), a rank range (P10–P90 across refits), launch odds from a logistic model (5-fold CV 64.2% vs a 54.9% base rate), and a farm plan costed to the dollar: capital $50–$250 by TVL tier, gas priced per transaction on the protocol's own chain (Ethereum $12.00, Base $0.10, Solana $0.01…), 30–60 day hold. The verdict comes from the **farmer's expected net** — launch odds × ticket × (implied value / TVL) × a 7% airdrop share, minus gas — taken at the band's low end: FARM when the low-end expected net clears $10 at a $1,000 ticket, THIN when positive but below $10, SKIP when zero or negative: 32 FARM / 74 THIN / 96 SKIP. Capital is not a cost (the deposit comes back); the cost is gas only. The dashboard re-prices every row at a $10,000 ticket and sorts by best farms. Every plan also states its break-even: the share of the token supply your airdrop must be to cover the all-in cost (board median 0.0014%). A ledger accounts for all 758 snapshot protocols, so nothing is silently dropped.

## What changed vs v2

- **Walk-forward validation.** A fourth blind test — expanding window by listing date, mimicking the radar's real job of pricing launches that have not happened yet. Pooled median 1.12.
- **Ablation at runtime.** The dashboard now carries the full 8-variant ablation table with live numbers and the reason each variant was kept or dropped — including the mcap-floor fit, whose better numbers come from an easier test set, not a better model.
- **Launch odds.** A logistic model (TVL, age, growth, sector) scores P(launch) for every row, 5-fold cross-validated, stated as a resemblance score rather than a prediction.
- **Net-based verdict.** v2's verdict priced the launch (low-end cover); v3 prices the farmer (odds-weighted expected slice minus gas). The biggest launches are now honestly SKIP at a $1,000 ticket — Ethereum gas and a thin slice multiple — and the dashboard says why instead of hiding it.
- **Ledger + scatter + rank ranges.** All 758 protocols accounted for in a ledger; a log–log scatter of the 128 fit points against the curve; a P10–P90 rank range on every row.
- **The curve itself is unchanged** — the plain log-log OLS still wins. That is a result, not a failure to iterate: the model is at the snapshot's noise floor, so v3 competes on validation, costing and honesty instead of on a false accuracy claim.

## What changed vs v1

- **Validation, not just a fit.** v1 reported only leave-one-out. v2 adds two blind time splits and a 200-refit bootstrap, all shown in the dashboard and reproducible from the repo.
- **A value band on every row.** The verdict is now taken at the band's low end, so a plan must pay for itself even if the launch comes in at the bottom of the band. The band is the fit's own uncertainty — the full prediction error (LOO median 3.4×) is stated next to it, not hidden.
- **Farm plans costed to the dollar.** Gas is priced per transaction on each protocol's own chain (Ethereum $108 a plan vs Base $0.90), steps carry explicit $ amounts and durations, and every plan states its break-even share of supply.
- **The board leads.** The dashboard now opens on the board (v1 opened on method text), the board shows the low-end value beside the central one, and the detail drawer adds the band, break-even and a timing note.

---

<sub>Entered on [make.fun](https://make.fun/?ref=qgk71vks&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
