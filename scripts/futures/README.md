# Futures experiment

The scripts behind the Futures module proposal ([docs/futures-module.md](../../docs/futures-module.md)). They price every solar + battery size for one home on the app's own model under the tariff futures in `futures.json`, then score each system on its average and worst 20-year gain.

They are research tools, not app code: nothing here is imported by the app.

## Run it

```bash
npm ci
npx vite-node scripts/futures/run.mts -- --home attia --out futures-out    # about 45 s on a laptop
python3 scripts/futures/analyse.py futures-out/attia-raw.json               # scores, printed
python3 scripts/futures/prototype/build.py futures-out/attia-data.json futures-out/attia.html
```

`futures-out/` is git-ignored.

Options:

- `run.mts`: `--home <id>` (from `homes.json`), `--panels 6,8,…`, `--batteries 0,5,…`
- `analyse.py`: `--tax 0` to leave export income untaxed as the app does today, `--max-panels 20` for the roof limit, `--replacement 400` for the year-12 battery price

## Files

| File | What it is |
| --- | --- |
| `futures.json` | The 10 futures: 8 core ones, averaged equally, plus 10c and 15c export steps for the export chart |
| `homes.json` | Example homes. `attia` is the reference home for the golden figures below |
| `run.mts` | Runs `src/model.js` (one line patched, see its header) for every system in every future |
| `analyse.py` | 20-year value per future, best trade-offs, the home's own system, least regret; writes the page data |
| `prototype/` | The interactive chart page used in the proposal, as a design reference |

## Reference results (5 Oct 2026 tariffs, `v8` at 59da057)

Home `attia`: Cork, 5,300 kWh, air-to-water heat pump, no EV.

| | Value |
| --- | --- |
| Best plan with no panels, today | €1,715 a year (EI-SST) |
| Own system (10 × 460 W + 9 kWh), saving today | €1,429 a year |
| Own system, saving if export pays 0c | €985 a year |
| 30 panels, saving today vs at 0c | €2,418 vs €672 a year |
| Best trade-offs, battery replaced in year 12 | 20 → 8 panels, no battery, plus 14 + 5 kWh and 12 + 5 kWh |
| Own system, battery replaced in year 12 | €6,137 average, €2,527 worst |
| Own system, battery lasts 20 years | €8,662 average, €5,052 worst (the best worst case of all) |

These figures make a good golden test for the module: the engine version must reproduce them to the euro on the same tariff file.
