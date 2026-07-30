# Solar Optimiser

Independent Irish electricity tariff and solar payback advisor. Models a home's
hourly consumption against every live Irish residential tariff and reports the
cheapest plan, plus solar/battery payback if the user has or is considering a
system.

**This is V5** (`v5` branch, `5.0.0-beta.1`) — the design overhaul, in parallel
beta on its own preview URL. **V3** (`v3` branch, tag `v3.0.0`) remains the
shipped, stable production line and is unaffected. See [VERSIONS.md](VERSIONS.md)
for the full picture, the colour grammar, and how V5 is promoted to production.

## Running it

```bash
npm ci
npm run dev        # vite dev server
npm run build      # production bundle -> dist/
npm run preview    # serve the built bundle
```

## Checks

```bash
npm run typecheck  # tsc over src/engine + typed tests
npm test           # vitest unit tests
npm run test:e2e   # playwright, runs against the real production bundle
```

`npm run test:e2e` builds and previews automatically. If your machine has a
preinstalled Chromium whose build number does not match this Playwright
release, point at it instead of downloading a second copy:

```bash
PW_CHROMIUM_PATH=/path/to/chromium npm run test:e2e
```

## Layout

```
index.html            thin shell: meta, loader markup, module entry
src/
  main.js             application entry (being split into modules)
  engine/             pure calculation code — no DOM, no globals, fully testable
    units.ts          branded unit types (kWh vs kW, euro vs cent, …)
    constants.ts      hours/days, location profiles, Tariff and Band shapes
    solar.ts          NOAA position, Erbs diffuse split, POA, PV generation
    npv.ts            20-year discounted cash flow, breakeven
    tariff-rules.ts   band resolution, dynamic pricing, annual cost
  styles/main.css     stylesheet
public/
  tariffs.json        runtime tariff data, rewritten daily by the scraper
scraper/              Python tariff scraper (GitHub Action, see workflows)
tests/
  unit/               vitest — engine and project invariants
  e2e/                playwright — drives the real bundle in a browser
```

## Architecture notes

**The engine is pure.** Everything under `src/engine/` must stay free of DOM,
`window`, and rendering. That is what makes the money maths testable, and the
money maths is the part that must not silently regress — it decides whether a
user switches supplier and whether a €12k install pays back.

**Engine functions take their inputs explicitly.** The originals read module
globals — `LOCATION`, which `applyRegion()` mutated, and `CACHE.wholesale`. That
made a result silently depend on whichever region was selected last, which is
both untestable and a real hazard when simulating scenarios side by side. Thin
adapters in `main.js` supply those values so call sites are unchanged; they
shrink as later phases introduce a proper state boundary.

**A known modelling limitation is pinned by test, not hidden.** `buildPoa` uses
an isotropic sky, which under Irish conditions makes roof tilt nearly
irrelevant — see the characterisation test in `tests/unit/solar.test.ts`. It is
asserted deliberately so that switching to an anisotropic model fails loudly
rather than silently moving every payback figure.

**Units are branded types.** `Kwh`, `Kw`, `Eur`, `Cent` and friends erase to
plain numbers at runtime but stop unit confusion at compile time. Construct
them at the boundary with `kwh(…)`, `eur(…)` etc. and pass branded values
inside the engine. See `src/engine/units.ts` for why each brand exists.

**Inline `on*` handlers are on borrowed time.** The app still builds HTML as
strings with inline `onclick` attributes, which evaluate in *global* scope. As
an ES module, top-level bindings are module-scoped, so a bridge at the bottom of
`main.js` publishes the handlers and the few mutable state bindings those
attributes touch. `tests/e2e/inline-handlers.spec.js` exists specifically to
catch breakage there — those tests fail if the bridge is removed. Both the
bridge and the tests' reason to exist go away when handlers become delegated
listeners.

## Deployment

Vercel builds with `npm run build` and serves `dist/` (see `vercel.json`).
`public/tariffs.json` is copied verbatim into the build and fetched at runtime,
so a tariff update is a data commit — it does not require a code change.
