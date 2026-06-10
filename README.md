# AI Infra Price Index

A live price index for AI infrastructure — GPU compute, CPU, and memory — in the
spirit of a CPI for the AI buildout. Team CareClarity.

## What it tracks

| Component | Measure | Source |
|---|---|---|
| GPU | best available $/GPU·hr per model (H100 SXM/PCIe, A100 80GB, RTX 4090, L40S, B200) | RunPod public GraphQL + Vast.ai marketplace (median of verified offers) |
| CPU | $/vCPU·hr | AWS EC2 on-demand, decomposed from c7i/r7i pricing (ec2.shop) |
| RAM | $/GB·hr | same decomposition: `(r7i − c7i) / 48 GiB` |

**Index methodology** — weighted geometric mean (GPU 60% / CPU 20% / RAM 20%),
each component as a ratio to the first-ever snapshot (baseline = 100). Falling
index = compute getting cheaper.

## Run it

```bash
# 1. Collect a price snapshot (stdlib only, no pip installs; appends to web/data/history.json)
python3 collector/collect.py

# 2. Serve the dashboard
cd web && python3 -m http.server 8000
# open http://localhost:8000
```

Schedule the collector (e.g. hourly) to grow the index time series:

```cron
0 * * * * cd /path/to/infra-index && python3 collector/collect.py
```

## Layout

- `collector/collect.py` — fetches all sources, computes indices, appends a snapshot
- `web/` — static dashboard (vanilla JS + Chart.js CDN), reads `web/data/history.json`
- `web/data/history.json` — committed so the site renders out of the box; the
  baseline (first snapshot) anchors the index, so don't delete it casually

## Notes

- All sources are free public APIs, no keys required.
- Prices are on-demand list/marketplace prices, not negotiated or reserved rates.
- The dashboard needs internet for the Chart.js CDN; if it's unreachable the
  chart is skipped but stats and the price table still render.
