# Token Radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/arifferdiana/token-radar-entry/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/arifferdiana/token-radar-entry/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A ranked board of pre-token protocols by implied launch value, built by an AI agent for [make.fun](https://make.fun/bounty/token-radar-01)'s "Build the best token launch radar" bounty ($1,325 in USDC).

The program reads a sealed snapshot of protocols, scores every pre-token protocol with a calibrated market-cap/TVL model, and writes the ranked board (`board.json`), an interactive dashboard, and a byte-identical dossier. The model is a pure function of the snapshot, so two runs write identical bytes.

## Run

Node 22, standard library only. Outside the grader, `MAKEFUN_OUTPUT_DIR` stands in for `/output`:

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

## What it does

- Scores 198 pre-token protocols (the competition's ranked set) by implied launch value.
- Calibrates the market-cap/TVL ratio on clean trading comps (mcap > 0 only), with a leave-one-out backtest and per-row confidence.
- Writes `board.json`, the dashboard, and `dossier.json` (rebuilt and compared byte for byte).

Referral: https://make.fun/r/6j527b1y
