# From now to a peakless.ie link you can share

Checked on 9 October 2026. "You" means something only the owner can do; "me" means
Claude does it once you give the go-ahead or the details.

## Already done in the app

- Quote requests to installers, the installer portal, the "Switch with Peakless"
  partner button and the commission label are gone, in the app and on the server.
- Supplier links are plain links to the supplier's own price page: no tracking tags,
  no click IDs. Every plan has one.
- No email is asked for anywhere it was never used: the sample report, the PDF
  report and the old "email me the report" box. Emails and quote-form details older
  versions kept on people's devices are cleared on load, and never synced.
- Footers no longer say "your data stays on your device" (not true for accounts).
  "All 50 plans in Ireland" now says what we carry: 50 plans from 11 suppliers.
- Vercel's page counter now waits for a yes to usage counts, like everything else.
- Privacy page matches what the app does: meter readings in the account, no
  installers, what Anthropic sees, storage on the device. Terms of use page added.
  Both open from a plain link (peakless.ie/#privacy, peakless.ie/#terms) for anyone.

## Must happen before you share the link

| # | What | Who | Time |
|---|---|---|---|
| 1 | **Decide who runs Peakless**: you as a sole trader, or a limited company. The privacy page and terms must name a real person or company with a postal address. Trading under the name "Peakless" as a sole trader needs a business name registered with the CRO. | You | 1 day to decide; a company takes about a week |
| 2 | **Register peakless.ie** at any .ie registrar. It isn't registered today (checked). .ie needs proof of a connection to Ireland. peakless.com is parked for sale. Do a quick trademark search for "Peakless" on EUIPO and the Irish IP Office before paying. | You | 1 day |
| 3 | **A privacy email** on the domain, e.g. privacy@peakless.ie (mail forwarding from the registrar is enough). | You | 1 hour |
| 4 | **Fill in the name, address and email** in `src/brand.ts`. Until then the privacy page and terms show "[to be added]". | Me | 5 minutes |
| 5 | **Run `supabase/launch_2026_10.sql`** on the live database. The clean-up the privacy page promises (errors after 30 days, usage counts after 26 months, etc.) was never set up, so nothing has been deleted yet. It also removes the old quote-request tables and their 2 rows. | You click Run, or say "apply it" and I do | 10 minutes |
| 6 | **Supabase settings**: Site URL `https://peakless.ie`; add `https://peakless.ie/**` to redirect URLs; turn on leaked-password protection (Auth → Passwords). | You, or me with your OK | 15 minutes |
| 7 | **Vercel**: add the domain peakless.ie, with www redirecting to it; set `APP_URL=https://peakless.ie`. Check the other variables in `docs/server-setup.md` are set. | You (DNS at the registrar), me (the rest) | 1 hour, then DNS takes a few hours |
| 8 | **Email sending**: verify peakless.ie in Resend (it gives 2 or 3 DNS records), and set `MAIL_FROM` to e.g. `Peakless <alerts@peakless.ie>`. Without this, alert emails go to spam or don't send. | You | 30 minutes |
| 9 | **Processor agreements**: accept the data processing agreement for Vercel, Supabase, Anthropic and Resend (each is a click in their dashboard or part of their terms). Keep a copy of each. | You | 1 hour |
| 10 | **Spend limit on Anthropic**: set a monthly cap in the Anthropic console. Uploads are rate limited, but the cap protects you from a bill. | You | 5 minutes |
| 11 | **Google sign-in**: in Google Cloud, put peakless.ie as an authorised domain, add the privacy and terms links to the consent screen, and the new redirect URL. Or turn Google sign-in off until later. | You | 30 minutes |
| 12 | **A solicitor reads the privacy page and terms.** I wrote them carefully, but I'm not your lawyer. Ask for a fixed-fee review covering GDPR, consumer law and the disclaimer. | You | 1 to 2 weeks, about an hour of their time |
| 13 | **Smoke test on the live domain**: sign up, sync, download my data, delete the account, a PDF report, a quote upload, the daily job's clean-up result. | Me, with you watching | 1 hour |

Realistic time: one to two weeks, set by the company decision and the solicitor.
Everything else fits in a day.

## Worth doing, not blockers

- **Soft launch** to 10 to 20 people you know before posting it widely.
- **Records**: a one-page record of what personal data you process and why (GDPR
  asks for it), and a one-page plan for a data breach (the Data Protection
  Commission must hear within 72 hours). I can draft both.
- **Watch the first weeks**: errors in the `client_errors` table, the daily price
  check, and Vercel's logs. A free uptime monitor emails you if the site goes down.
- **Backups**: check the Supabase plan. The free plan has no backups you can restore; Pro keeps daily ones.
- **The tagline** "Your personal Irish energy advisor" sits oddly with the terms
  saying Peakless isn't an adviser. Something like "Compare Irish electricity plans
  on your own home" says the same with less risk. Your call.
- **CRU accreditation** for price comparison sites is voluntary; some rivals have
  it. Worth a look later, not now.
- **Insurance**: ask a broker about professional indemnity once people rely on it.
- Still open from before: the Energia 30% offer needs checking against Energia's
  own page, and PR #14 (gas prices) is waiting for review.

## The website and the phone

One domain is enough. peakless.ie is the website; peakless.ie/app is the phone
version, which people add to their home screen. A separate mobile site (say
app.peakless.ie) would be a different address to the browser, so a home saved on
the website wouldn't show up in the app. App Store and Google Play can come later.
