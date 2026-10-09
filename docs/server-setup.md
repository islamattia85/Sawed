# Server setup

Peakless takes no money from suppliers or installers. Quote requests to
installers, the installer portal and commission links were removed before
launch (October 2026). Bringing any of them back needs new terms, a new
privacy notice and a new consent text first.

## Vercel environment variables (Settings → Environment Variables, Production)

| Name | Type | What |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Secret | Supabase → Project Settings → API → `service_role` key. Used by account deletion, consent records and the daily job. Never put it in the app. |
| `ANTHROPIC_API_KEY` | Secret | For the quote reader and the quarterly suggestions. |
| `RESEND_API_KEY` | Secret | resend.com API key, for alert emails. |
| `MAIL_FROM` | Config | e.g. `Peakless <alerts@peakless.ie>`, on a domain verified in Resend. |
| `APP_URL` | Config | The public address, e.g. `https://peakless.ie`. Used in emails, and allowed to call the server functions. |
| `APP_ORIGIN` | Config | Another address allowed to call the server functions, if the app is served from a second one. |
| `CRON_SECRET` | Secret | Any long random string. Vercel sends it with each cron call; without it the daily job refuses to run. |

Redeploy after adding them.

## Email alerts (price changes, contract ending)

A daily job (`/api/alerts-cron`, 08:00 UTC, set in `vercel.json`) emails signed-in
households that turned on **Email me these** in My Peakless. Without `RESEND_API_KEY`
and `MAIL_FROM` it runs but sends nothing. The same job runs the retention purge in
`supabase/security_2026_10.sql`.

Each email is logged in `alert_log`, so none is ever sent twice. "A cheaper plan for
your home" needs the full model, which runs in the app, so it appears in My Peakless
rather than by email.

## Before launch: run `supabase/launch_2026_10.sql`

It creates `purge_expired()` (missing on the live project, so the daily job has
removed nothing so far) and drops the old quote-request tables and functions,
with the rows in them.
