[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Onefine8/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Onefine8/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Launch Radar — 203 pre-token protocols scored by a comps curve (mcap = 1058 · TVL^0.522) fitted on the 128 priced protocols in the snapshot, each with a concrete farm plan and a FARM / THIN / SKIP verdict. Built for make.fun's "Build the best token launch radar" bounty, $1,325 in USDC.

## Run it

```sh
node main.ts --input /input --output /output
```

Give it a directory holding `snapshot.json` (the competition kit's `input/`) and it writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` into the output directory. Node 22, stdlib only, no network, deterministic — two runs on the same snapshot are byte-identical.

## How it scores

The snapshot (DefiLlama protocols, 2026-11-14) lists 758 protocols; 128 already have a token and 342 do not. The 128 priced ones teach the model: a log-log comps curve `mcap = a · TVL^b`, refit from the snapshot at runtime. Leave-one-out validation: median |log error| 1.22 for the curve vs 1.60 for the flat 0.25× multiple — and growth, age and per-category variants all scored worse out-of-sample, so the curve is the whole model. The board ranks the full 40-protocol house watchlist plus every other genuine pre-token launch candidate (203 rows), each with a farm plan (capital $50–$250 by TVL tier, gas, 30–60 day hold) and a verdict from how many times its implied value covers the plan's all-in cost.

---

<sub>Entered on [make.fun](https://make.fun/?ref=qgk71vks&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
