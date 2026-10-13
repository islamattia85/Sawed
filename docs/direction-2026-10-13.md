# Direction: narrow the focus and make the beta safe to show

13 October 2026. For Claude Code, from the founder and co-founder, after a full
evaluation of V8 at 0b61fe1. This document is the whole brief for the next two
weeks. Nothing outside it is in scope.

## What we are doing and why

Peakless has no users yet. Before fifty real households go through it, the
product must (1) not mislead in the first minute, (2) carry fewer ideas, and
(3) be measured. Two things come out: the quarterly AI suggestions and the
savings score with its challenges, levels and points. The rest of this
document is the defects found in a walk-through, the operational debts that
must close before strangers use the site, and the measurement that will tell
us what they do.

Narrowing means fewer products, not fewer answers to the solar question. The
EV guide, the futures map, the quote check and the meter-file work all serve
"will solar pay back on my home, on which plan" and stay. They are frozen, not
removed: no new work on them unless a PR below names it.

## Rules

- Branch `direction/focus` off `v8`. One pull request per numbered section,
  in the order given. Each PR passes the full suite (`npm run typecheck`,
  `npm test`, `npm run test:e2e`, the golden households) before the next starts.
- Removing a feature means removing its code, CSS, state fields, tests, copy
  and legal-page text, and adding a state migration that drops its saved
  fields. No dead code left behind a comment.
- Do not touch `src/model.js`, `src/engine/*`, the scraper or the tariff
  registry except where a section names a change. Accuracy is gated by the
  golden households; keep them green and do not widen their limits.
- Stop the edge-case work on EVs in meter files. The last seven commits on v8
  were all on that; it is good enough for the golden test and for testers.
- Wording follows `docs/voice.md`. Every new user-facing sentence is plain
  Irish English, no jargon, no exclamation marks.
- Each PR description lists what was removed, what changed on screen, and the
  test count before and after.

## 1. First-minute defects

These are what a tester sees in their first five minutes. They go first.

### 1.1 "Add solar" marks panels as installed

On Profile, a home with `has_solar` false or unset that taps "Add solar" gets
a 10-panel system with the toggle on **It's installed**; Home then says "with
your solar" and shows a €427 bill for a home that has no panels.

- Default the system sheet to **Planning it** unless the user has said the
  panels are installed (`has_solar === true` from setup or the "I have solar"
  door).
- Rename the illustration button for a no-solar home to **Plan solar**. Inside
  the sheet, "It's installed" stays available.
- Test: a gas home from the "Just a better plan" door taps Plan solar; Home
  must read "planned panels", never "your solar".

### 1.2 The first answer assumes a discounted plan

A user who picks "Not sure which plan" is assumed to be on the supplier's
discounted smart plan (for Electric Ireland, Energysaver 16%). The headline
becomes "€51 less a year" inside a ±9% band. Most people who have not switched
within a year are on the supplier's standard rates after their discount ended.

- After "Not sure which plan" (and after "I'm not sure: assume a standard
  plan" at supplier level), ask one question: **When did you last switch
  supplier or sign up to a plan?** Options: *Within the last year* · *One to
  three years ago* · *Longer, or never* · *Not sure*.
- *Within the last year* keeps today's assumption (the supplier's current
  discounted plan for that meter). The other three assume the supplier's
  standard plan for that meter type (`EI-24`, `EI-SST`, `BG-24` and so on).
  Check the registry has a standard plan for every supplier and meter type;
  where one is missing, fall back to the discounted plan and say so.
- Home and Analytics say which plan was assumed: "Now, on Electric Ireland's
  standard smart plan (assumed; change it if you know your plan)".
- Record the answer in state (`last_switched`) so the contract-end reminder
  can use it later. No other use now.
- Test: the typical 4,200 kWh gas home, Electric Ireland, "longer, or never",
  must show the standard plan as "Now" and a saving in the hundreds, with the
  assumption stated on Home.

### 1.3 Plan counts disagree

The front page says 50 plans, Plans says 35, Home and the PDF say 33.

- One function returns the count for the home's meter type; Home, Plans,
  the PDF and the share card use it. In-app copy: "35 plans for a smart
  meter". The front page may say "50 plans from 11 suppliers" and add "35 of
  them for smart meters".
- Find why Home says 33 when Plans lists 35 and make them agree.

### 1.4 Scraper notes shown to users

Plan details → Full rate card renders the registry's `notes` field, for
example "A dearer 28% version is also sold (bonkers.ie, kilowatt.ie);
switcher.ie lists both … valid to 11 Oct 2026". These are audit notes.

- Never render `notes` in the app or the PDF. If a plan needs a user-facing
  line (a withdrawn plan kept for existing customers, a plan with a sign-up
  condition), add a separate `public_note` field in the registry and render
  only that.

### 1.5 Sheets reopen on reload

`_sheet` is saved with the state, so a reload or a return to the app reopens
the last sheet, including the meter-upload sheet with no sign that a file is
already loaded.

- Do not persist `_sheet`, `_an_tab` or `_return_to` across loads (the
  `UI_ONLY` set and the save path already handle similar keys).
- When the meter sheet opens and a file is loaded, show the loaded summary
  (dates covered, kWh, exports present or not) with **Replace the file**, not
  the empty upload card.

### 1.6 Home headline with planned panels

"Switch plan and add your planned solar to save €1,108 less a year" combines
€65 from switching with €1,043 from panels not yet bought.

- Lead with the panels: "Your planned panels would cut your bill by €1,043 a
  year" and a second line "Switching plan saves €65 today". The combined
  figure appears only in the four-bill breakdown.

### 1.7 Small ones

- "Get the app" in the front-page nav links to `/app`. There is no app.
  Rename it **Open Peakless**, or remove it since **My answer** is there.
- A 404 is logged on the Plans tab. Find the missing asset and fix it.
- The plan sheet shows no contract length or exit fee. The registry has
  `length` and `exit`; show both on the sheet under the rates ("12-month
  contract · €50 exit fee"). Where a plan has neither, show nothing.

## 2. Remove the savings score, levels, challenges and points

Everything that scores the household or rewards an action goes.

- Delete `householdScore`, `checkScoreRise`, `scoreLevel`, `renderScoreBlock`,
  `renderTallyBlock`, the quests and the Challenge sheet ("+30 points", "Do it
  now", "new level"), `state.score_seen`, the `up-progress` block on Updates
  and all their CSS.
- Delete the Energy health score on Analytics → Bill (`computeEnergyScore`,
  `renderEnergyScore`, "Plan health: 89 of 100"). If its weakest-factor
  sentence is already computed from the hour breakdown, keep that one
  sentence under the breakdown; build nothing new.
- Keep the **To do** rows on Updates (upload your meter file, confirm the
  roof, add your contract end date) as plain rows: title, one line, chevron.
  No points, no badges. The meter-file row opens the upload sheet directly.
- Keep the price news cards, Price watch and the email toggle.
- A state migration drops the score fields from saved state and from the
  account copy on next sync.
- Update the PDF and the share card if either shows a score.
- Tests: delete the score and challenge tests; adjust `journeys`, `v7`,
  `user-test-*`, `home-answer` and `desktop` where they expect the score.

## 3. Remove the quarterly AI suggestions; put the quote reader behind a flag

### 3.1 Quarterly suggestions

- Delete `generateAdvice`, `getAdvice`, `renderAdviceBlock`, `adviceSummary`,
  `quarterKey` and `state.advice`; the "This quarter" section on Updates; the
  "Written by AI (Anthropic's Claude)" copy; `api/advice.js`, `api/_advice.js`,
  their `.d.ts` files, the `advice` rate-limit bucket in `api/_server.js`;
  `tests/unit/advice.test.ts`.

### 3.2 Quote reader

The AI reading of uploaded quote PDFs stays in the codebase but off. Without
an API key it already answers 503 "Quote reading is not switched on yet",
which today is a dead end a tester can reach from three places.

- Add `quoteReader: false` to `src/features.js`, with the same comment style
  as the other flags.
- When off: hide "Upload an installer's quote" (Profile, the solar sheet, the
  Updates row), hide the file upload inside the quote sheet, and have
  `api/extract-quote.js` answer 404.
- Keep the manual path and make it the only one: "I have a price" on the
  system sheet, the quote check against the usual price for that size, and
  the payback on the home. The front-page card "Is my quote fair?" must land
  on that manual path.

### 3.3 Legal pages and the launch checklist

- Privacy notice and terms: remove the AI paragraphs and remove Anthropic from
  the processors list. Say instead that uploaded quote figures are typed in by
  the person and stay on the device.
- `docs/launch-checklist.md`: move the Anthropic data processing agreement and
  spending limit to "when the quote reader is switched on".
- `docs/monetisation-setup.md`: note the flag.

## 4. Shorten the front page and lead with solar

The phone front page is about 28 screens. Keep what shows the product; cut
what argues for it. Target: at most eight phone screens.

Keep, in this order:

1. Header, brand line, headline, sub-line, the three doors. Order the doors
   **I'm thinking about solar** · **I have solar** · **Just a better plan**.
2. The four-bill card ("One home, four bills a year").
3. "How it works", three steps.
4. "Why the plan matters", cut to its three numbered lines and nothing else.
5. The questions, five cards: *They told me five years* · *Is it the right
   system for my roof?* · *Is my quote fair?* · *What if export pay drops?* ·
   *I just want a cheaper plan*. Drop the EV card and the "I have solar" card
   (the doors cover both).
6. Five questions of "Good to know".
7. The footer with the company line and the legal links.

Cut: the second payback block ("Years to earn back €11,700"), "What you get",
"Try it" (the inline mini-calculator), "Built to be checked", "The plans we
compare, by kind", and the remaining FAQ entries.

Change the sub-line's last sentence from "Free, no commission from anyone" to
**Free. No supplier pays to be ranked.** It is true today and stays true when
installer quotes are switched on. The ranking page already says the rest.

Desktop keeps the same content in its two-column hero. Do not design a new
desktop layout in this PR.

## 5. Build, CI and deploys

### 5.1 Source maps

`vite.config.js` has `sourcemap: process.env.VERCEL_ENV !== 'preview'`, so
production serves the engine's source. Set `sourcemap: false` when
`VERCEL_ENV === 'production'`, keep it on locally and on previews, and delete
any `dist/**/*.map` in the Vercel build command as a belt and braces.
`keepNames: true` stays so error reports keep function names. Acceptance: the
live site's `.map` URLs answer 404.

### 5.2 CI cost

CI runs 17 minutes on every push: about 6,000 minutes a month, which a
private repo cannot afford on the free plan.

- `ci.yml` becomes two jobs. **quick** on every push to `v8` and `main`: type
  check, build, unit tests, scraper tests (about 3 minutes). **full** on pull
  requests, on push to `main`, and nightly at 02:00 Dublin time: the quick job
  plus the browser tests and the golden households.
- Cache the Playwright browser (`~/.cache/ms-playwright`, keyed on the
  `@playwright/test` version) instead of installing it each run.
- `paths-ignore` for `docs/**` and `**/*.md` on the push trigger.
- Drop `v3`, `v5` and `v6` from the branch list. Keep `v7` only while it is
  still deployed; ask the owner.
- Keep `concurrency: cancel-in-progress`.

### 5.3 Production comes from `main`

Today every push to `v8` deploys to the live site, up to 36 times a day; the
6 October regression went live that way.

- Create `main` from the current `v8` head. The owner sets Vercel's production
  branch to `main`; `v8` pushes become preview deployments.
- The price-update workflows open their pull requests against `main`, so
  prices still reach the site daily without an app release.
- App work merges `v8 → main` by a pull request, at most once a day, after
  the full job is green. Write this as a short section in `README.md`.

## 6. Database hardening

- A migration in `supabase/` that revokes `EXECUTE` from `authenticated` and
  `anon` on `installer_leads`, `installer_leads_v2`, `is_installer_member`,
  `my_quote_requests` and `set_assignment_status`, or switches each to
  `SECURITY INVOKER` where the installer portal (flagged off) does not need
  the definer. The portal is off; nothing should be able to call these.
- Apply `supabase/security_2026_10.sql` (the clean-up function the privacy
  page promises). Verify with the advisors: no WARN left except the ones the
  owner clears in the dashboard.
- Note for the owner in the PR: turn on leaked-password protection
  (Authentication → Password security) and move the project to Pro for
  backups.

## 7. Measurement

Nothing tells us what people do. Fifty testers without this is a wasted
cohort.

### 7.1 PostHog, EU cloud

- Install `posthog-js` from npm and bundle it; no external script, so the CSP
  only needs `connect-src https://eu.i.posthog.com`. Project key from
  `VITE_POSTHOG_KEY`; when unset, `trackEvent` is a no-op.
- Before the person taps **Allow** on the usage question: `persistence:
  'memory'`, `autocapture: false`, `capture_pageview: false`, no session
  recording, no identify. Events still send, with a per-session random id.
- After **Allow**: `persistence: 'localStorage'` so return visits count. Never
  call `identify` with an email or a user id. **No thanks** keeps memory
  persistence. Session recording stays off everywhere.
- Remove the Plausible branch from `trackEvent` and `plausible.io` from the
  CSP. Keep `/api/event` as it is.
- Privacy notice: add PostHog (EU, Frankfurt) to the processors list with one
  line on what is counted.

### 7.2 Tracking plan

One `trackEvent(name, props)` call per row. Properties are coarse: region,
heating type, meter type, a saving band (`<50`, `50-200`, `200-500`, `500+`),
never a kWh figure, a bill, an MPRN or a plan the person is on.

| Event | When | Properties |
| --- | --- | --- |
| `app_opened` | first paint of the app, once a session | `entry` (front, app, share) |
| `door_chosen` | a front-page door or question card | `door` |
| `setup_step` | each setup step shown | `path`, `step`, `part` |
| `setup_left` | Leave, or the page closed mid-setup | `path`, `step` |
| `first_answer` | the answer screen after setup | `path`, `has_file`, `accuracy`, `saving_band` |
| `meter_file_added` | a file accepted | `days`, `has_export`, `warned`, `question_asked` |
| `meter_file_rejected` | a file refused | `reason` |
| `plan_sheet_opened` | a plan's sheet | `rank` |
| `switch_clicked` | the supplier link | `supplier`, `rank` |
| `solar_sheet_opened` | the system sheet | `mode` (planning, installed) |
| `system_chosen` | a preset or a saved system picked | `panels`, `battery_kwh`, `preset` |
| `futures_opened` | the "If prices change" block expanded | — |
| `report_downloaded` | the PDF saved | `pages` |
| `shared` | the share sheet used | `method` |
| `account_created` | sign-up completed | `provider` |
| `error_shown` | an error card or toast | `kind` |

Add a short `docs/tracking-plan.md` that is this table, and keep it in step
with the code.

### 7.3 Errors reach a person

`client_errors` holds three rows nobody has read. Add `api/error-digest.js` on
a daily Vercel cron at 07:00 that emails the owner the last 24 hours of client
and server errors through Resend (count, first line, screen, build), only when
there are any. Needs `RESEND_API_KEY`, `MAIL_FROM` and `DIGEST_TO`; without
them it logs and exits.

## 8. For the owner, alongside the PRs

- Vercel: set the production branch to `main` (after PR 5); move to Pro.
- GitHub: make the repository private after PR 5 is merged; add a payment
  method with a $10 monthly Actions budget.
- Supabase: Pro plan; turn on leaked-password protection.
- PostHog: create the EU project; put the key in Vercel as `VITE_POSTHOG_KEY`.
- Resend: verify `peakless.ie` and set `DIGEST_TO`.
- Decisions to confirm before PR 4 starts: the door order (solar first) and
  the new sub-line.

## 9. Done means

- A gas home from "Just a better plan" sees a standard-plan assumption when it
  has not switched in a year, and planning solar never shows "your solar".
- No score, level, points, challenge or quarterly suggestion anywhere in
  `src/`, the PDF, the tests or the legal pages. `grep -ri "points\|challenge\|
  savings score\|this quarter" src/` finds nothing user-facing.
- The quote reader is off and unreachable; the manual quote check works from
  the front page card.
- The phone front page is at most eight screens; the doors lead with solar.
- The live site serves no `.map` files; CI quick job under four minutes;
  production deploys only from `main`.
- `get_advisors` shows no SECURITY DEFINER warning.
- PostHog receives the events in the tracking plan, consent-gated as described.
- Full suite green; golden households unchanged; test count reported.

## 10. Not in this brief

Desktop layout, the App Store wrapper and Sign in with Apple, installer quotes
and partners (stay flagged off), new futures or EV work, renaming tabs, more
competitor benchmarks, model or engine changes, CRU paperwork.
