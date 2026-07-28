# Versions

Two major lines of this application are maintained at the same time. They share
one repository and one history, and nothing else.

| Line | Branch | Tag | What it is |
| --- | --- | --- | --- |
| **V3** | `v3` | `v3.0.0` | The application as it stands today. Feature-complete and shipped. |
| **V4** | `main` | — | The next major version. Free to break anything. |

### What V4 is

V3 answers *"what if I install this?"* — the reader configures a system and the
simulator prices it. That is a laboratory. V4 inverts it: the engine searches
the space of systems and says *"this is what you should install, and here is
what it beat"*. Nothing in V3 is deleted; the laboratory becomes the layer
underneath the advice, for the people who want it.

The engine for that landed first, deliberately, with no interface on it:
`src/engine/search.ts` and `src/search-worker.js`. It is reachable as
`window.runDesignSearch(onProgress, { goal, finance, maxPanels })`, and it
answers four goals from one sweep — `max-return`, `bill-swap`, `independence`
and `fast-payback` — because "best" is not a technical question and the engine
has no business deciding it. The ceiling on every design comes from
`src/engine/roof.ts`, which sizes the roof from the kind of house and the
bedroom count that onboarding now asks for. If the search could not produce a stable answer in
a couple of seconds on a phone, every screen planned on top of it would have
been built on sand.

## Why a branch and not a second repository

V3 is finished but not abandoned. If a tariff source changes, a supplier is
renamed, or a defect turns up in the engine, the fix has to reach the people
using V3 without waiting for V4 to be ready — and it has to be possible to
apply the same fix to both lines with one `git cherry-pick`. A separate
repository makes that a manual re-implementation every time, which in practice
means the older line stops getting fixed.

Sharing a repository costs nothing here. The two lines never share a working
tree, a branch, or a deployment.

## The rules

1. **`v3` does not move except for V3.** Fixes only — no new features, no
   redesigns, no dependency bumps that are not security fixes. Its purpose is to
   stay exactly as reliable as it is now.
2. **V4 work goes on `main`,** through feature branches as before. It may
   restructure, rename, delete, and redesign anything. It owes V3 no
   compatibility.
3. **Fixes flow one way: `v3` → `main`.** Fix on `v3`, then cherry-pick onto
   `main` if V4 still has the same defect. Never merge `main` into `v3`; that
   would drag V4 changes into a line that is supposed to be frozen.
4. **Every V3 release gets a tag** — `v3.0.1`, `v3.1.0` — so any report can be
   tied to an exact bundle.

### Fixing something in both lines

```sh
git checkout v3
# …fix, test, commit…
npm version patch --no-git-tag-version   # 3.0.0 -> 3.0.1
git commit -am "…"; git tag v3.0.1; git push origin v3 --tags

git checkout main
git cherry-pick <sha>      # only if V4 has the same defect
```

## Which version am I looking at?

The More screen prints it at the bottom: `v3.0.0 · build 1a2b3c4d`. The version
comes from `package.json` at build time and names the line; the build id is the
commit. A bug report without both is a bug report about an unknown program.

## Deployments

Both lines can be live simultaneously. In the Vercel project, `main` is the
production deployment and `v3` is added as a deployed branch, which gives it a
permanent URL of its own (`sawed-zeta-git-v3-<scope>.vercel.app`). Until V4 is
worth showing to anyone, the two should be swapped: point production at `v3` so
the stable app keeps the main address, and let `main` deploy to a preview URL.

That swap is a setting in the Vercel dashboard — Settings → Git → Production
Branch — not something in this repository.
