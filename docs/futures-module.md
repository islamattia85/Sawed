# Futures module: how each solar system holds up if prices change

Status: proposal, ready to build on `v8`. Scripts and reference figures: [`scripts/futures/`](../scripts/futures/README.md).

## 1. Summary

Today Peakless prices every solar and battery size at today's prices and recommends the best. Most people aren't worried about today's prices. They want to know if the system will still be worth it after export payments drop or night rates rise.

The Futures module runs every system through a small set of plausible price futures and gives each one two numbers: its average 20-year value and its worst. The app can then show which systems are a bet and which are steady, name the one belief each recommendation rests on ("pays off if selling back stays above 15c"), and let the person choose how much risk they want.

No other Irish comparison tool does this. bonkers.ie, switcher.ie and kilowatt.ie all answer "what does it save at today's prices".

## 2. Why: what the experiment found

`scripts/futures/run.mts` ran `src/model.js` (v8 at 59da057, tariffs checked 5 Oct 2026) for one Cork home: 5,300 kWh a year, air-to-water heat pump, no EV. It covered 60 panel and battery sizes plus the owner's own system, in 10 futures.

1. **The best system changes with the future.** In 5 of the 8 futures the largest array the roof takes (20 panels) wins. At 5c export the winner is 18 panels; at 0c it is 8. That makes four different winners across 8 futures, or five if batteries last 20 years, so a risk view adds real information.
2. **Export payments are the decision.** 30 panels save €2,418 a year at today's export rates and €672 at 0c. The owner's 10 panels + 9 kWh go from €1,429 to €985, the steadiest of all.
3. **A small battery is insurance, a big one never pays.** On 12–16 panels a 5 kWh battery adds €175–195 a year at today's export rates and about €300 when export pays 5c or less. Going from 10 to 15 kWh adds €16–34 a year in every future, which never pays for about €1,900 more battery.
4. **Battery life decides the battery question.** With the app's assumption (replaced in year 12 at €400/kWh), no battery reaches the best trade-offs except 5 kWh on 12–14 panels. If the battery lasts 20 years, the owner's system has the best worst case of every system (€5,052).

Section 4.6 lists four model gaps the experiment found. They affect today's figures too, so fix them first.

## 3. Definitions

| Term | Meaning |
| --- | --- |
| Future | An end state for prices, reached in a straight line by year 5 and held to year 20. Defined in data (`futures.json`), never in code |
| Core futures | The 8 futures that feed the averages. Two more (export at 10c and 15c) are only drawn on the export chart |
| Benefit in a future | The cheapest plan with no panels minus the cheapest plan with the system, both priced in that future. Each side picks its own best plan, as `evaluateDesign()` does today |
| 20-year value | Benefit over 20 years minus the price after the grant. Uses `computeNpv20()` conventions: 3% discount, 0.5% a year panel loss, battery replacement per section 4.6c |
| Average, worst | The mean and the minimum of the 20-year value across the core futures. Equal weights unless the person's answers change them (section 7) |
| Best trade-offs | Systems that no other system beats on both average and worst. Everything else can be hidden |
| Least regret | The system whose largest shortfall against the best system in any single future is smallest |
| Depends on | The export rate at which the system stops beating the next steadier best trade-off, found from the 0c, 5c, 10c, 15c and today ladder |

The 8 core futures: today's prices hold; export pays 5c; export pays nothing; night and EV rates up 80%; wider gap between peak and night; energy crisis (imports up 40%, export up 20%); cheap power (imports down 20%, export halves); fixed charges up 70% with unit rates down 12%.

## 4. Engine and model

### 4.1 `src/engine/futures.ts` (pure, no DOM, no state)

```ts
export interface Future { id: string; core: boolean; label: string;
  imports?: number; night_ev?: number; peak?: number; export_to?: number; export_mult?: number; standing?: number }
export function planInFuture(plan: Tariff, f: Future): Tariff            // the transform in run.mts inFuture()
export function withAnnouncedChange(plan: Tariff): Tariff                // a pending price_change applied in full
export function value20(net: Eur, battKwh: number, today: Eur, future: Eur, opts: ValueOpts): Eur
export function score(systems: SystemRun[], futures: Future[], weights?: number[]): Scored[]  // avg, worst, regret, onEdge, beatenBy
export function dependsOnExport(ladder: Record<string, number>, rival: Record<string, number>): number | null
```

`futures.json` moves to `public/futures.json` so the futures can be tuned without a release, and is checked by a unit test the way `tariffs.json` is.

### 4.2 A fast path for the money

`model.simulate()` builds 13 hourly arrays per call. Futures needs about 60 systems × 46 plans × 2 battery strategies × 10 futures: 55,000 years of hours. With the full model that took 45 s on a laptop, which is too slow for a phone.

Add `simulateNet()` to the engine. It is the same hourly loop as `simulate()` but only adds up import cost and export income. An earlier port of exactly that loop ran a home's whole set in about 0.5 s per future. A parity test runs both on every plan for three homes (gas, gas + EV, heat pump) with batteries of 0, 5 and 10 kWh, and fails on any difference over 1 cent. `simulate()` stays as it is for the screens that draw hours.

### 4.3 The worker job

Add `job.kind === 'futures'` to `src/sim-worker.js`, beside `sweep` and `outcomes`. For each future it sets the transformed tariffs, prices every system with the fast path, and posts a partial result. Today `runInWorker()` resolves once, so give the protocol a progress message (`{ id, partial }`) so screens fill in future by future. With no worker, fall back to the page one future per frame, as the sweep does now.

Cache key: `goalSweepCk()` plus the tariff build id, the `futures.json` version and the person's answers (section 7).

### 4.4 Battery strategy

Keep the app's `auto` rule: each plan is priced with whichever of grid-charging or solar-only suits it, in each future.

### 4.5 The night-rate threshold

`simulate()` only grid-charges on a night band when the rate is at or below a fixed 20c (`model.js`, `band === "night" && rate <= 0.20`). In a future where all prices rise 40%, that line switches grid-charging off for reasons that have nothing to do with the battery. Make it a parameter (`priceIndex`, 1 today) so today's figures do not move. The script patches the same line the same way.

### 4.6 Model gaps to fix first (each its own pull request, with before and after figures)

| | Gap | Effect, measured on the reference home | Fix |
| --- | --- | --- | --- |
| a | `evaluateDesign()` never sets `inverter_kw`, so every suggested size runs on the person's inverter (5 kW by default) | 20 panels save €1,819 a year on 5 kW and €1,905 on 6 kW. Big systems are undervalued in the systems list | Size the inverter with the array (kWp ÷ 1.2, at most 6 kW single-phase) in `evaluateDesign()` and the guide, and show it in My system |
| b | `simulate()` charges and discharges at a fixed 5 kW. `battery_charge_kw` and `battery_discharge_kw` are stored but not read | Small batteries are overrated and large ones underrated at the edges | Read both from state, with defaults by battery size |
| c | Every battery is replaced in year 12 at €400/kWh (`computeNpv20()`, `outcomeAgainst()`) | This one assumption decides whether any battery is worth it (section 2, point 4) | A battery-life setting (10, 15 or 20 years; default 15) with a replacement price that falls over time. Asked once (section 5.3) |
| d | Export income is never taxed | Above €400 a year, microgeneration income is taxed at the person's marginal rate. The disregard runs to the end of 2028. This cuts the value of big arrays most | A tax-rate setting (none, 20%, 40%) and the €400 disregard, in My home |

## 5. What the person sees

Copy follows [docs/voice.md](voice.md). "Futures" is the internal name; the screens say "if prices change".

### 5.1 Systems list in My system

Each system card gets one more line under its figures:

- A chip: **Steady**, **Some risk** or **A bet**, from where its worst case sits relative to the edge.
- One sentence naming what it depends on: "Pays off if selling back stays above 15c."

### 5.2 Analytics → Solar → If prices change

1. **What you'd save if selling back pays less.** Yearly saving (y) against the export rate from 0c to today (x), one line each for the person's system, the best trade-off at each end, and the largest the roof takes.
2. **Average against worst.** Every size up to the roof limit as a dot. The best trade-offs are joined and ringed, and the person's system is marked. Tap a dot for its panels, battery, price before and after the grant, saving today, and its value in each future. Then "Use this system", which works like the systems list.
3. A **battery-life switch** above both charts, and a table of every system below them.

`scripts/futures/prototype/` has a working version of chart 2, the switch and the table.

### 5.3 Solar guide: two questions before the price step

One tap each, any answer can be "Not sure":

1. "What do you think you'll get for selling back in 2030?" About the same / About half / Close to nothing.
2. "How long do you expect a battery to last?" 10 years / 15 years / 20 years.

Then the reveal leads with the best trade-off that suits those answers. It shows one line on the alternative: "If selling back holds up, 18 panels would earn about €400 more over 20 years."

### 5.4 Home solar card

One line under the payback: "Holds up in 7 of 8 price changes", or "Depends on selling back staying above 15c".

## 6. AI explanation (optional, last)

`api/explain-system.js`, built like `api/extract-quote.js`: the same guard, rate limit, model and Zod output. It sends only figures the app has already worked out (the system, its value in each future, the best trade-offs, the person's answers). It returns `{ headline, why, watch_out }`, three sentences at most, in the voice of docs/voice.md.

Rules:

- The model explains and never calculates. Every number in the reply must appear in the input, checked on the server. If one doesn't, the app shows the built-in template text instead.
- Nothing personal is sent: no address, meter file or MPRN.
- Cache by a hash of the input. Behind a flag until user testing shows it helps.

## 7. Answers become weights

Default: the 8 core futures count equally. The guide's answers change the weights:

| Answer | Change |
| --- | --- |
| Selling back: about the same | Export-cut futures (5c, 0c, cheap power) at half weight |
| Selling back: about half | 5c and cheap power at double weight |
| Selling back: close to nothing | 0c at triple weight |
| Battery life | Sets 4.6c directly, not a weight |

Show the weights on the If prices change page ("Counting your answer: selling back about half"), with a way to clear them.

## 8. Tests and budgets

- **Unit:** `planInFuture` (every field, cheap band capped below the day rate), `value20` against `computeNpv20` at zero change, `score` (edge, worst, regret on a hand-made set), `dependsOnExport`.
- **Parity:** `simulateNet` against `simulate` (section 4.2).
- **Golden:** the reference home in `scripts/futures/homes.json` on a frozen copy of the 5 Oct tariffs must reproduce the figures in `scripts/futures/README.md` to the euro.
- **End to end:** the guide's two questions change the recommendation; the If prices change page draws both charts and the table; tapping a dot then "Use this system" changes My system and Back undoes it; the Home line appears with planned and installed solar.
- **Budgets:** first result on screen within 1 s and all futures within 5 s on a mid-range phone, in the worker. No paint blocked for more than 100 ms.
- **Events** (added to the fixed list in `api/event.js`, consent as today): `futures_viewed`, `futures_answer_set`, `futures_system_used`.

## 9. Order of work

| PR | Contents | Done when |
| --- | --- | --- |
| 1 | Model gaps 4.6a–d, each with before and after figures in the commit | Systems list and guide figures move as measured; all tests pass |
| 2 | `engine/futures.ts`, `simulateNet`, `public/futures.json`, unit, parity and golden tests | Golden figures reproduced; parity within 1 cent |
| 3 | Worker job with progress, systems-list chip and "depends on" line | Chips fill in within budget; works with the worker off |
| 4 | If prices change page (both charts, switch, table) | End-to-end tests above |
| 5 | Guide questions, weights, Home line | Recommendation follows the answers; Back undoes everything |
| 6 | AI explanation, behind a flag | Number check rejects any figure not in the input |

Add a task to the user testing kit after PR 5: "You're thinking about solar. Find a system that would still be worth it if selling back paid less."

## 10. Open questions

1. Default battery life: 15 years with a falling replacement price, or keep the app's 12 years?
2. Default tax rate when the person hasn't said: none (as today) or 20%?
3. Should "A bet" ever be the recommendation, or only shown?
4. Free for everyone, or the first premium feature once the beta proves it is used?
