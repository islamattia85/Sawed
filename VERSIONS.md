# Versions

Several major lines of this application share one repository and one history,
and nothing else. Each lives on its own branch and deploys to its own URL.

| Line | Branch | Version | What it is |
| --- | --- | --- | --- |
| **V3** | `v3` (and `main`) | `v3.0.0` | The shipped, stable application. Production. |
| **V4** | `v4` | `4.0.0-dev` | The decision-engine rework. Superseded by V5, kept for reference. |
| **V5** | `v5` | `5.0.0-beta.1` | The design overhaul, built on V4's engine. **Parallel beta.** |

## What V5 is

V4 changed what the app *does*; V5 changes what it *is to use*. It adopts the
"warm dark, honest UI" design language from the vision document — a deep warm
navy, a solar-amber gradient for the one primary action, signal-blue and
value-green as the two working accents — and rebuilds the journey around the
questions a homeowner actually arrives with.

The signature screens are built, not mocked:

- **Welcome** — a question, not a login: "Is it worth it, for your home?"
- **The Answer** — the home screen is a confidence ring; the arc is filled from
  the real categorical confidence level, never a fabricated percentage.
- **What-if lab** ("Explore", in the nav) — two sliders that re-answer four
  numbers as you drag, grounded in the real generation model and the same
  cost/grant/NPV helpers as the rest of the app; only self-consumption is a live
  approximation, which is why it hands off to the full simulation on "Use these".
- **The tariff paradox** — "why a higher headline rate can still cost less",
  drawn from each plan's own 8,760-hour battery-dispatched import, not an
  illustration.

Two rules carry the colour grammar: **amber is the input you give and the action
you take; blue is the signal the app gives back.** Dark leads; light is kept as
an alternative. Caps are written literally in the markup, never via
`text-transform`, so a screen reader hears what is written.

## What V4 was

V3 answers *"what if I install this?"* — the reader configures a system and the
simulator prices it. That is a laboratory. V4 inverted it: the engine searches
the space of systems and says *"this is what you should install, and here is
what it beat"*. The engine landed first, deliberately with no interface —
`src/engine/search.ts`, `src/search-worker.js`, `src/engine/roof.ts` — reachable
as `window.runDesignSearch(...)`, answering four goals from one sweep
(`max-return`, `bill-swap`, `independence`, `fast-payback`). V5 is built on top
of that engine; nothing in it was thrown away.

## Why branches and not separate repositories

V3 is finished but not abandoned. If a tariff source changes, a supplier is
renamed, or a defect turns up in the engine, the fix has to reach V3's users
without waiting for a newer line — and it must be one `git cherry-pick` to carry
the same fix forward. Separate repositories make that a manual re-implementation
every time, which in practice means the older line stops getting fixed. Sharing
a repository costs nothing: the lines never share a working tree, a branch, or a
deployment.

## The rules

1. **`v3` does not move except for V3.** Fixes only — no features, no redesigns,
   no dependency bumps that are not security fixes. It stays exactly as reliable
   as it is now.
2. **New work goes on the newest line (`v5`),** through feature branches. It may
   restructure, rename, delete and redesign anything, and owes the older lines
   no compatibility.
3. **Fixes flow forward only: `v3` → newer.** Fix on `v3`, then cherry-pick onto
   `v5` if the same defect is there. Never merge a newer line back into `v3`.
4. **Every promoted release gets a tag** — `v3.0.1`, `v5.0.0` — so any report
   can be tied to an exact bundle.

## Which version am I looking at?

The More screen prints it at the bottom: `v3.0.0 · build 1a2b3c4d` on V3,
`v5.0.0-beta.1 · build …` on the V5 beta. The version comes from `package.json`
at build time and names the line; the build id is the commit. A bug report
without both is a bug report about an unknown program.

## Deployments

All lines can be live at once, each on its own URL, set in the Vercel dashboard
(Settings → Git), not in this repository.

- **Production stays on V3.** `main` holds the V3 tree and serves the main
  address; real users are unaffected by V5.
- **V5 is a parallel beta.** Pushing `v5` produces a Vercel preview deployment
  at a branch URL (`sawed-git-v5-<scope>.vercel.app`) — the link to share for
  testing.

### Promoting V5 to production, later

When V5 is ready to become the live app, it is a two-step cutover, both in the
Vercel dashboard and both reversible:

1. Point the Production Branch at `v5` (Settings → Git → Production Branch), or
   fast-forward `main` to `v5` if production should keep tracking `main`.
2. Tag the promoted commit `v5.0.0` and drop the `-beta` from `package.json`.

Until then, nothing about production changes.

## Carrying a fix into both lines

```sh
git checkout v3
# …fix, test, commit…
npm version patch --no-git-tag-version   # 3.0.0 -> 3.0.1
git commit -am "…"; git tag v3.0.1; git push origin v3 --tags

git checkout v5
git cherry-pick <sha>      # only if V5 has the same defect
```
