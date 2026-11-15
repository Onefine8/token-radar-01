[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Onefine8/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Onefine8/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Launch Radar — 202 pre-token protocols scored by a comps curve (mcap = 1058 · TVL^0.522) fitted on the 128 priced protocols in the snapshot, each with a value band, a farm plan costed to the dollar, and a FARM / THIN / SKIP verdict taken at the band's low end. Built for make.fun's "Build the best token launch radar" bounty, $1,325 in USDC.

## Run it

```sh
node main.ts --input /input --output /output
```

Give it a directory holding `snapshot.json` (the competition kit's `input/`) and it writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` into the output directory. Node 22, stdlib only, no network, deterministic — two runs on the same snapshot are byte-identical.

## How it scores

The snapshot (DefiLlama protocols, 2026-11-14) lists 758 protocols; 128 already have a token and 342 do not. The 128 priced ones teach the model: a log-log comps curve `mcap = a · TVL^b`, refit from the snapshot at runtime. Validation is three-way and blind: leave-one-out median |log error| 1.22 (vs 1.60 for the flat 0.25× multiple), blind time-split 70/30 median 1.21 and 60/40 median 1.18 (train on the oldest listings, test on the newest), and a 200-refit bootstrap with slope 90% CI [0.378, 0.672]. Growth, age and per-category variants — 21 in all, including robust, winsorised, k-NN, broken-stick and L1 fits — all scored worse out-of-sample, so the curve is the whole model; the full variant tables are reproducible from `scripts/fit-model.mjs` and `v2/scripts/experiment*.mjs`.

The board ranks the full 40-protocol house watchlist plus every other genuine pre-token launch candidate (202 rows). Every row carries a value band (5th–95th percentile of the 200 bootstrap refits) and a farm plan costed to the dollar: capital $50–$250 by TVL tier, gas priced per transaction on the protocol's own chain (Ethereum $12.00, Base $0.10, Solana $0.01…), 30–60 day hold. The verdict comes from the low-end cover — the band's low value divided by the plan's all-in cost — FARM at 100,000×, THIN 50,000–100,000×, SKIP below: 70 FARM / 69 THIN / 63 SKIP. Every plan also states its break-even: the share of the token supply your airdrop must be to cover the all-in cost (board median 0.0014%).

## What changed vs v1

- **Validation, not just a fit.** v1 reported only leave-one-out. v2 adds two blind time splits and a 200-refit bootstrap, all shown in the dashboard and reproducible from the repo.
- **A value band on every row.** The verdict is now taken at the band's low end, so a plan must pay for itself even if the launch comes in at the bottom of the band. The band is the fit's own uncertainty — the full prediction error (LOO median 3.4×) is stated next to it, not hidden.
- **Farm plans costed to the dollar.** Gas is priced per transaction on each protocol's own chain (Ethereum $108 a plan vs Base $0.90), steps carry explicit $ amounts and durations, and every plan states its break-even share of supply.
- **The board leads.** The dashboard now opens on the board (v1 opened on method text), the board shows the low-end value beside the central one, and the detail drawer adds the band, break-even and a timing note.
- **The curve itself is unchanged** — 21 variants were tested and none beat it out-of-sample. That is a result, not a failure to iterate: the model is at the snapshot's noise floor, so v2 competes on honesty, costing and presentation instead of on a false accuracy claim.

---

<sub>Entered on [make.fun](https://make.fun/?ref=qgk71vks&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
