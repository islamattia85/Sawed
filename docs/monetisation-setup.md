# Switching on leads, events and the installer portal

## 1. Vercel environment variables (Settings → Environment Variables, Production)

| Name | Type | What |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Secret | Supabase → Project Settings → API → `service_role` key. Lets the server write leads. Never put it in the app. |
| `RESEND_API_KEY` | Secret | Optional. resend.com API key, for the emails to homeowners and installers. |
| `MAIL_FROM` | Config | Optional. e.g. `Sawed <quotes@yourdomain.ie>` (a domain verified in Resend). |
| `APP_URL` | Config | `https://sawed-zeta.vercel.app` — used in installer emails to link the portal. |
| `ANTHROPIC_API_KEY` | Secret | Already added for the quote reader. |

Redeploy after adding them.

## 2. Add an installer (Supabase → SQL editor)

```sql
insert into public.installers (company, seai_reg, email, phone, counties, price_per_lead_eur, max_leads_per_month, active)
values ('Example Solar Ltd', 'SEAI-12345', 'leads@examplesolar.ie', '021 000 0000',
        '{Cork,Kerry}', 60, 20, true)
returning id;
```

## 3. Give someone at that company the portal

They sign in once in the app (More → Installer portal → Sign in), then:

```sql
insert into public.installer_members (installer_id, user_id, role)
select '<installer id from step 2>', id, 'owner' from auth.users where email = 'person@examplesolar.ie';
```

## 4. What happens to a quote request

1. The app sends it to `/api/lead` with the homeowner's explicit consent.
2. It is checked, scored 0–100, de-duplicated (same email + county within 30 days is not a new lead) and stored.
3. `route_lead` offers it to up to three active installers covering the county, fewest leads this month first, never past their monthly cap.
4. Each installer gets an email; the homeowner gets a confirmation.
5. In the portal the installer sees the system and modelled payback, and the contact details once they accept. They move it through contacted, quoted, won or lost.

## 5. Monthly lead billing (until Stripe is wired)

```sql
select i.company, count(*) as leads, sum(a.price_eur) as amount_eur
from public.lead_assignments a join public.installers i on i.id = a.installer_id
where a.status not in ('sent','declined','invalid')
  and a.assigned_at >= date_trunc('month', now()) - interval '1 month'
  and a.assigned_at <  date_trunc('month', now())
group by i.company order by amount_eur desc;
```

Only accepted leads are billable; declined and invalid ones are not.

## 6. Commission partners

When a supplier agreement is signed, add its plan ids to `window.__SAWED_PARTNERS` (in `index.html`) and put its tracking link in `AFFILIATE_URLS` (`src/main.js`). Partner plans are labelled in the app; a test proves the ranking is identical with and without them. Every switch click carries a `sawed_click` id, recorded in `public.events` (with analytics consent), to match against the partner's confirmed-switch report.

## Email alerts (price changes, contract ending)

A daily job (`/api/alerts-cron`, 08:00 UTC, set in `vercel.json`) emails signed-in
households that turned on **Email me these** in My Peakless. It needs, in Vercel →
Settings → Environment Variables:

| Variable | What it is |
|---|---|
| `CRON_SECRET` | Any long random string. Vercel sends it with each cron call; without it the job refuses to run. |
| `RESEND_API_KEY`, `MAIL_FROM` | Same as for lead emails. Without them the job runs but sends nothing. |
| `SUPABASE_SERVICE_ROLE_KEY`, `APP_URL` | Already set. |

Each email is logged in `alert_log`, so none is ever sent twice. "A cheaper plan for
your home" needs the full model, which runs in the app, so it appears in My Peakless
rather than by email.
