# Versions

Two major lines of this application are maintained at the same time. They share
one repository and one history, and nothing else.

| Line | Branch | Tag | What it is |
| --- | --- | --- | --- |
| **V3** | `main`, `v3` | `v3.0.0` | The application as it stands today. Feature-complete, shipped, and what production serves. |
| **V4** | `v4` | `4.0.0-dev` | The next major version. Free to break anything. |

### Why V3 is on `main`

Not for a good reason — for a hosting one, and it is worth writing down rather
than leaving the next person to work it out.

V4 was developed on `main`, which meant every V4 commit went live the moment it
was pushed. The host's production branch was changed to `v3` to stop that, and
production kept serving the last build made from `main` regardless. Rather than
keep fighting a dashboard, `main` was reverted to the V3 tree: whatever the
host believes its production branch to be, `main` now holds the code that
should be public.

Nothing was rewritten to do it. The revert is an ordinary commit, so every V4
commit is still in this repository's history and still on `v4`.

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

1. **`main` and `v3` hold the same thing** — V3, and only V3. `main` exists
   because that is what the host deploys; `v3` exists because that is the
   line's name. Any V3 fix goes to both.
2. **`v3` does not move except for V3.** Fixes only — no new features, no
   redesigns, no dependency bumps that are not security fixes. Its purpose is to
   stay exactly as reliable as it is now.
3. **V4 work goes on `v4`,** through feature branches as before. It may
   restructure, rename, delete, and redesign anything. It owes V3 no
   compatibility.
4. **Fixes flow one way: V3 → V4.** Fix on `v3` (and `main`), then cherry-pick
   onto `v4` if V4 still has the same defect. Never merge `v4` into either; that
   would drag V4 into a line that is supposed to be frozen — and straight into
   production.
5. **Every V3 release gets a tag** — `v3.0.1`, `v3.1.0` — so any report can be
   tied to an exact bundle.

### Fixing something in both lines

```sh
git checkout v3
# …fix, test, commit…
npm version patch --no-git-tag-version   # 3.0.0 -> 3.0.1
git commit -am "…"; git tag v3.0.1; git push origin v3 --tags

git checkout main && git cherry-pick <sha> && git push origin main   # goes live
git checkout v4   && git cherry-pick <sha>                           # if V4 has it too
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
