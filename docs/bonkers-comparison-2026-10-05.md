# Peakless vs bonkers.ie: who is wrong, and why

Run on 5 October 2026. Same homes entered into both: urban (DG1), smart meter, direct debit, no solar, no EV, no cashback. Four sizes: 2,500, 4,200, 6,500 and 10,000 kWh a year. bonkers.ie was driven through its public comparison form in a browser (its data API is barred to robots and was not used), one home at a time; 49 plans came back for each. Disputed figures were checked against the supplier's own price page the same morning.

## The short answer

| What differs | Size of gap | Who is right |
|---|---|---|
| SSE Airtricity prices | Peakless 8% cheaper on every SSE plan | **bonkers.ie.** SSE's own page: 31.50c a kWh, €279.99 standing. Peakless still has 28.79c and €263.86. |
| Day/night/peak plans (all suppliers) | Peakless 6–8% dearer | **Neither is measured.** Different assumptions about when a home uses power. See below. |
| EV plans for a home with no EV | Peakless 10–13% dearer | Same cause as above. |
| Energia Smart Data | bonkers.ie 23% off, Energia's page 27% off | **Peakless**, on today's prices. Energia's page matches Peakless exactly. bonkers.ie may be showing the plan as it will be after 12 October; not confirmed. |
| One-rate plans (Flogas, Bord Gáis, Yuno) | **€0 to €1** at every size | Both. Standing charge, PSO levy, VAT and the 9 October Bord Gáis rise agree to the euro. |

The arithmetic is not the problem. Where the plan has one rate, the two sites agree to the euro at all four sizes. Every real gap comes from **stale prices** (SSE, Peakless's fault) or **the usage shape** (a choice both sites make).

## 1. Stale SSE Airtricity prices: Peakless is wrong

| Plan, 4,200 kWh | bonkers.ie | Peakless | SSE's own page |
|---|---|---|---|
| Smart Everyday 30% | 31.50c, €280.01, **€1,610** | 28.79c, €263.86, **€1,480** | 31.50c, €279.99, EAB €1,609.72 |
| 30% Day/Night/Peak | 33.82 / 20.55 / 37.88c | 30.47 / 19.58 / 34.12c | (rose with the rest) |

The SSE rows in `src/model.js` say "verified 2026-10-03", but SSE's page now shows the new prices (about +9% unit, +6% standing). The daily check either missed the change or read the page before it went live. **Consequence:** Peakless currently ranks SSE Smart Everyday 30% as the cheapest plan for a typical home, by about €130 a year that isn't there. On bonkers.ie it is 12th.

**Fix:** re-read every SSE plan now. Then find out why the daily check didn't flag it.

## 2. The usage shape: the biggest gap, and nobody's measured fact

bonkers.ie's breakdown shows exactly how it prices a smart day/night/peak plan for a typical home: **54% day, 37% night, 9% peak**, the same for every home of every size. Electric Ireland's and SSE's own "estimated annual bill" figures use the same kind of standard split (EI quotes €1,447 for Home Electric SST Saver 16%; bonkers.ie €1,445).

Peakless spreads the year hour by hour from a profile chosen by heating type. Working back from its own figures, a gas-heated home comes out at **60% day, 18% night, 22% peak**.

That is why every day/night/peak plan costs 6–8% more on Peakless, the same percentage at every size: the cheap night hours carry half the load bonkers.ie gives them, and the dear 5–7pm hours carry more than double.

Who is closer?
- **bonkers.ie's 9% peak is low.** Two hours a day is 8% of the time, and teatime is the busiest part of an Irish day.
- **Peakless's 22% peak is high.** In `SHAPE_GAS_WINTER`, 5pm and 6pm are 2.20 and 2.45 times the base hour. That is a home where almost everything happens at teatime.
- **bonkers.ie's 37% night is high** for a home with no storage heating, no EV and no timed immersion. **Peakless's 18% is on the low side.**

The fair answer: for a typical home the truth sits between the two, and for an actual home only its meter file says. This matters for the ranking, not just the totals. bonkers.ie's split makes night-rate plans look best, while Peakless's makes one-rate plans look best.

**Fix:** set the default shape from ESB Networks' published Standard Load Profile for urban domestic customers, instead of hand-set factors. Keep heating type and hot water as adjustments on top. A meter file still overrides everything. Then re-run this comparison: the day/night gap should drop to a few per cent.

## 3. EV plans for a home without an EV: same cause

Flogas Smart EV Night Charge is 10–13% dearer on Peakless, and the gap grows with size. With no car, Peakless puts very little use in the 2–5am EV window; bonkers.ie's standard split gives that window a share of the night. For a home with no EV, Peakless's view is the more realistic one. But these plans shouldn't be near the top for such a home on either site.

## 4. Energia: unresolved, probably bonkers.ie

Energia's own plan table (prices to 11 October) matches Peakless to the cent: Smart Data 27% off at 30.75 / 16.91 / 34.54c, Smart 24 Hour 28.10c, standing €265.01. bonkers.ie shows Smart Data at **23%** off (32.44 / 17.84 / 36.43c) with €278.01 standing. Smart Day/Night shows a €348.25 standing charge, which Energia's page does not show for that plan.

Energia's prices change on 12 October. bonkers.ie may be quoting part of the new tariff for the whole year, but its night rate (17.84c) doesn't match Energia's announced new night rate either. **Needs Energia's 12 October price sheet to settle.** Until then, Peakless's figures are the ones Energia publishes today.

## 5. Plans on one side only

**On bonkers.ie, not in Peakless:**
- Ecopower: Standard Smart 10%, Smart 24hr 10%
- Energia: EV Smart Drive Plus, Energia SST, Smart Drive 10%
- Yuno Energy: Smart EV Variable, Standard Smart Electricity
- SSE Airtricity: the 25%, 23%, 17% and 10% versions of Smart Everyday and Day/Night/Peak, and Smart Weekend variants (probably existing-customer or loyalty tiers; worth checking)
- Pinergy: Lifestyle SST

**In Peakless, not shown by bonkers.ie for a smart-meter home:**
- Non-smart plans: SSE Home Electricity 24hr and Nightsaver, Electric Ireland Nightsaver, Waterpower Day/Night, Community Power Day/Night, Energia Standard Electricity.
- PrepayPower: pay-as-you-go, filtered out by choosing direct debit.

The first group is a real question for Peakless. A home already on a smart meter can usually stay on a standard 24-hour plan, but a **Nightsaver** plan needs a day/night meter. Peakless shouldn't offer Nightsaver plans to a smart-meter home. It currently does, at €1,491 (third place).

## What to do, in order

1. **Re-read SSE Airtricity now** and find out why the daily check missed it. This one changes the top recommendation.
2. **Stop offering Nightsaver (day/night meter) plans to smart-meter homes.**
3. **Replace the hand-set default shape** with ESB Networks' standard load profile, then re-run this comparison.
4. **Add the missing plans,** starting with Ecopower and the Energia and Yuno smart plans.
5. **Settle Energia** once its 12 October price sheet is out.

## How it was run

- bonkers.ie: Electricity only → continue without upload → current supplier → Urban, Smart meter, Direct debit → "I know how much I consume" → no export, no EV optimising, no cashback, all plans. Two runs at 4,200 kWh, with Electric Ireland and with Pinergy as the current supplier, because bonkers.ie leaves out the current supplier's own plans.
- Peakless: the app's own ranking for the same home, with usage entered in kWh, gas heating and an Electric Ireland baseline.
- Each figure is the first-year cost including VAT, standing charge and PSO levy, with announced price changes counted from the date they start. Welcome credits and cashback are left out on both sides.

## Follow-up, same day

- **SSE Airtricity re-read.** All six plans now carry SSE's prices, which its own price sheet says are "valid from 5 October 2026". The daily check hadn't missed anything: the rise started this morning, and the scheduled run hadn't fired yet.
- **Meter type.** Every plan now says which meter it needs (smart, standard 24-hour, or day/night). Setup asks which meter the home has, and the ranking only offers plans that work with it. A smart-meter home no longer sees Nightsaver plans.
- **Urban or rural.** Every plan now carries a rural standing charge:
  - SSE's comes from SSE's own price sheet.
  - Most others come from bonkers.ie's rural results.
  - Non-smart plans, which bonkers.ie didn't price, are estimated from the same supplier's urban-to-rural difference and labelled as estimates.

  Rural is €55 to €95 a year dearer for most plans. Pinergy charges the same in both, and Yuno's EV plans and Ecopower are about €32 dearer. Setup asks which applies.
- **Still open:** Electric Ireland Night Boost. bonkers.ie shows a €328.54 standing charge, while Peakless has €250.77. To be checked against Electric Ireland's full price list.

## The usage shape, settled with ESB Networks' own profile

ESB Networks publishes the profile the electricity market itself assumes for a home: the Standard Load Profiles, "Load Profile Indexes 2026" on rmdservice.com. For the typical urban home on a 24-hour meter (Load Profile 1) the year splits:

| | Day | Night | Weekday 5–7pm peak |
|---|---|---|---|
| ESB Networks, typical urban home (LP1) | **68%** | **23%** | **9%** |
| bonkers.ie | 54% | 37% | 9% |
| Peakless, before | 60% | 18% | 22% |

bonkers.ie's 54/37/9 is ESB's **Nightsaver** profile (Load Profile 2), which the smart-meter profile (LP25) copies. That profile belongs to homes with night storage heating, and bonkers.ie applies it to every smart-meter home. So for a typical home, bonkers.ie overstates night use. That flatters night-rate plans by about 4–6%.

Peakless's old hand-set curve put far too much in the teatime peak and was too seasonal (winter about 2.3 times summer, against ESB's 1.3).

**Done:** a home with no electric heating now uses ESB Networks' profile month by month: Load Profile 1 for urban homes, Load Profile 3 for rural. That covers both the hourly shape and the split between seasons. Heat pump, storage and direct-electric homes keep their own shapes, because ESB publishes no standard profile for them. A meter file still overrides everything. `scripts/slp.py` rebuilds the data from the next year's file.

**Gap after the change (4,200 kWh, urban, smart):**

| Plan | Before | After |
|---|---|---|
| One-rate plans | 0% | 0% |
| SSE Smart Everyday 30% | −8% | 0% |
| Energia Smart Data | +3% | 0% |
| Waterpower, Flogas, Bord Gáis day/night/peak | +6–8% | +4% |
| SSE 30% Day/Night/Peak | −1% | +6% (bonkers.ie's night share; the prices now agree) |

The remaining 4–6% on day/night/peak plans is bonkers.ie's night share, not a Peakless error. For a home with a meter file, both sites should agree closely.
