# From now to a peakless.ie link you can share

Step by step, in order. Each step says who does it, what it costs and how long it
takes. Prices were checked on 9 October 2026; where a price is my estimate rather
than a published price, it says so. US dollar prices are converted at about
€0.88 to the dollar.

**Who:** "You" is something only the owner can do (pay, sign, own an account).
"Me" is something Claude does once you say go or give the details.

---

## Part 1. Decide and register (you)

### Step 1. Decide who runs Peakless
The privacy page and terms must name a real person or company with a postal address.

- **Option A, sole trader (cheapest, fastest).** You run it in your own name.
  Because you trade as "Peakless" and not your own name, register the business
  name with the CRO: form RBN1, online through CORE, within a month of starting to
  use the name.
  - Cost: **€20** online (€40 on paper).
  - Time: about 20 minutes to file; the CRO says up to about 5 weeks for the
    certificate. You can launch while it is being processed.
- **Option B, limited company.** Protects your personal money if something goes
  wrong; makes sense once money comes in (partners, installer quotes).
  - Cost: **€50** online (form A1 through CORE), plus €25 to reserve the name
    first if you want (taken off the €50). Every year after: an annual return
    (€20 if filed on time) and accounts, usually done by an accountant
    (my estimate: a few hundred to €1,500 a year; get quotes).
  - Time: about 1 to 2 weeks.
- **My suggestion:** Option A now, Option B before you switch on quote requests or
  partners. A 30-minute call with an accountant can confirm this for your situation.

**Who:** you. **Cost:** €20 (A) or €50 plus yearly costs (B).

### Step 2. Check nobody else owns the name
Search "Peakless" on TMview (tmdn.org, covers the EU and Ireland). Free.
Registering your own trade mark is optional: about €70 for one class in Ireland
(check the current fee at ipoi.gov.ie), or €850 for an EU trade mark.

**Who:** you, 15 minutes. **Cost:** €0 to search.

### Step 3. Register peakless.ie
It isn't registered today (I checked). peakless.com is parked for sale.
Any .ie registrar (Blacknight is Irish and among the cheapest). The .ie registry
asks for proof of a connection to Ireland, such as an Irish address.

**Who:** you, 30 minutes. **Cost:** about **€7 to €45** for the first year,
about €20 to €45 a year after, depending on the registrar.

### Step 4. A privacy email address on the domain
For example privacy@peakless.ie. It only needs to forward to your own inbox.

- Free: a forwarding service such as ImprovMX or Cloudflare Email Routing.
  I'll give you the exact records to add at the registrar.
- Paid, if you want a full mailbox: Google Workspace, about €7 to €8 a month.

**Who:** you, with my records. **Cost:** **€0**.

### Step 5. Send me three details
Your name (or the company's), the postal address, and the privacy email.
I put them in the app (`src/brand.ts`); the privacy page and terms stop showing
"[to be added]".

**Who:** you, then me (5 minutes). **Cost:** €0.

---

## Part 2. The legal paperwork (you)

### Step 6. Accept the data processing agreements
Each service that handles people's data for us needs one. They are standard,
free, and accepted in each provider's dashboard or legal pages. Keep a copy of
each (a PDF in a folder is enough).

- Vercel (hosts the site)
- Supabase (database: accounts and saved homes)
- Anthropic (reads uploaded quotes, writes the quarterly suggestions)
- Resend (sends the alert emails)

**Who:** you, about 1 hour. **Cost:** €0.

### Step 7. A solicitor reads the privacy page and the terms
I wrote both carefully, but I'm not a lawyer. Ask two or three solicitors for a
fixed fee to review a privacy notice and website terms (GDPR and consumer law)
for a free online tool. Send them the two pages and the one-line description:
"a free calculator that compares Irish electricity plans; it takes no money from
anyone; accounts are optional".

**Who:** you. **Cost:** my estimate **€300 to €1,000**; no published prices, so
get quotes. **Time:** 1 to 2 weeks. This is usually the longest wait.

---

## Part 3. Accounts and plans (you choose, I set up)

### Step 8. Vercel plan (the website host)
The free Hobby plan is for non-commercial use only. While Peakless earns nothing it
is arguably fine; once you are a company, or any money comes in, use Pro.

**Who:** you choose and pay. **Cost:** **€0** (Hobby) or about **€18 a month** (Pro, $20).

### Step 9. Supabase plan (the database)
The free plan works, but it has no backups you can restore, and a project with no
activity for about a week is paused (our daily job keeps it awake). Pro has daily
backups. Since accounts hold people's saved homes, I recommend Pro from launch.

**Who:** you choose and pay. **Cost:** **€0** (Free) or about **€22 a month** (Pro, $25).

### Step 10. Anthropic spending limit
Pay as you go. Reading one quote costs my estimate of 5 to 15 cent; the quarterly
suggestions cost about the same each. Set a monthly limit in the Anthropic console,
say €20, so a busy month can never surprise you.

**Who:** you, 5 minutes. **Cost:** **€0 to €20 a month** at launch.

### Step 11. Resend (alert emails)
The free plan sends up to 3,000 emails a month (100 a day), plenty for launch.
Verify peakless.ie in Resend: it gives 2 or 3 DNS records to add at the
registrar, so emails don't land in spam.

**Who:** you add the records (I tell you exactly which), 30 minutes. **Cost:** **€0**.

### Step 12. Run the database clean-up script
The privacy page says error reports are deleted after 30 days, usage counts after
26 months, and so on. The function that deletes them was never created on the
live database, so nothing has been deleted yet. `supabase/security_2026_10.sql`
creates it, and removes one old database function nothing uses. Safe to run twice.

**Who:** me, if you say "apply it"; or you paste it into the Supabase SQL editor
and press Run. 10 minutes. **Cost:** €0.

---

## Part 4. Connect the domain (both)

### Step 13. Point peakless.ie at the site
1. Me: add peakless.ie and www.peakless.ie to the Vercel project (or you, in Vercel
   → Settings → Domains) and give you the 2 DNS records.
2. You: add those records at the registrar. It takes a few minutes to a few hours.
3. Me: set `APP_URL=https://peakless.ie` in Vercel, so emails link to the right
   place and the server accepts calls from the new address.

**Who:** both, about 1 hour plus waiting. **Cost:** €0.

### Step 14. Tell the sign-in services the new address
1. Supabase → Authentication → URL configuration: Site URL `https://peakless.ie`,
   add `https://peakless.ie/**` to redirect URLs. Turn on leaked-password
   protection (Authentication → Passwords) if your plan includes it.
2. Google Cloud (only if you keep "Continue with Google"): add peakless.ie as an
   authorised domain, add the privacy and terms links (peakless.ie/#privacy and
   peakless.ie/#terms) to the consent screen, and the new redirect address.
   Or turn Google sign-in off for now; email sign-in still works.

**Who:** you, with my step-by-step, 30 minutes. **Cost:** €0.

---

## Part 5. Check and open (both)

### Step 15. Test the live site end to end
On peakless.ie: create an account, sync a home, download my data, delete the
account, make a PDF report, upload a quote, and check the daily job ran its
clean-up.

**Who:** me, with you watching, about 1 hour. **Cost:** a few cent of Anthropic usage.

### Step 16. Soft launch
Share the link with 10 to 20 people you know first. Ask them one question: "what
confused you?" Fix what comes back, then share it widely.

**Who:** you. **Cost:** €0.

---

## What it costs in total

| | One-off | Each month |
|---|---|---|
| **Cheapest** (sole trader, free plans) | about €330 to €1,070 (business name €20, domain €7 to €45, solicitor €300 to €1,000) | about €0 to €20 (Anthropic) |
| **Recommended** (sole trader, Supabase Pro, Vercel Pro) | the same | about €40 to €60 |
| **As a company** | add €50 | add accountant and annual return (my estimate: a few hundred to €1,500 a year) |

The solicitor is most of the one-off cost. Everything else is small.

## How long it takes

About **one to two weeks**, set by the solicitor (step 7) and, for a company,
the CRO. Steps 2 to 6 and 8 to 15 fit in one or two days between us.

---

## Hidden for the first launch, kept for later

These are built and kept in the code, switched off in one place
(`src/features.js`). Nothing of them shows, and the server refuses quote
requests while they are off. Turning one on is a one-line change, but each needs
the privacy page, the terms and probably a company (step 1, option B) first.

- **Get 3 installer quotes**, the installer portal, and the request lists in
  Updates and Profile (`installerQuotes`).
- **Partner suppliers**: "Switch with Peakless", the commission note and referral
  links (`partners`).
- **Email capture** for the sample report and the PDF report (`emailCapture`).
  Nothing sends these emails yet.

The database keeps the tables for quote requests. There are 2 rows in them from
testing; delete them if they are yours.

## Already fixed for launch

- Footers no longer say "your data stays on your device" (not true for accounts).
  "All 50 plans in Ireland" now says "50 plans from 11 Irish suppliers".
- Supplier links are plain links to the supplier's own price page; every plan has one.
- The report window no longer promises an email app that never opened, and no
  longer makes the PDF twice.
- Vercel's visitor counter waits for a yes to usage counts.
- The privacy page matches what the app does (meter readings in the account, what
  Anthropic sees, storage on the device). A terms of use page is added. Both open
  from a plain link for anyone and are linked from the footers and the sign-up form.

## Worth doing, not blockers

- A one-page record of what personal data you process and why, and a one-page
  plan for a data breach (the Data Protection Commission must hear within 72
  hours). I can draft both, free.
- A free uptime monitor that emails you if the site goes down.
- Professional indemnity insurance once people rely on it: ask an Irish broker.
  UK quotes for small online businesses start around €100 to €300 a year; Irish
  prices differ.
- The tagline "Your personal Irish energy advisor" sits oddly with the terms saying
  Peakless isn't an adviser. Your call.
- CRU accreditation for price comparison sites is voluntary; worth a look later.
- Still open: check the Energia 30% offer against Energia's own page, and review
  PR #14 (gas prices).

## The website and the phone

One domain is enough. peakless.ie is the website; peakless.ie/app is the phone
version, which people add to their home screen. A separate site (say
app.peakless.ie) is a different address to the browser, so a home saved on the
website wouldn't show up in the app. App Store and Google Play can come later.

## Where the prices come from

- Business name: [CRO, business names](https://www.cro.ie/Registration/Business-Name)
- Company: [CRO fees leaflet](https://cro.ie/wp-content/uploads/2024/04/Leaflet-4-v6.2.pdf), [CRO registration methods](https://cro.ie/registration/company/registration-methods/)
- .ie domains: [domainoffer.net .ie price comparison](https://domainoffer.net/tld/ie)
- Vercel: [Vercel pricing summary](https://schematichq.com/blog/vercel-pricing) (check vercel.com/pricing)
- Supabase: [Supabase pricing guide](https://www.jetadmin.io/blog/supabase-pricing-2026-guide-to-plans-limits-and-real-world-costs/) (check supabase.com/pricing)
- Resend: [Resend pricing](https://resend.com/pricing.md)
- Google Workspace: [Irish reseller note on 2025 prices](https://cksolutions.ie/google-workspace-price-increase-for-flexible-customers-what-you-need-to-know/)
- Insurance (UK figures): [Simply Business](https://www.simplybusiness.co.uk/business-insurance/professional-indemnity/)
- Solicitor, accountant, Anthropic per quote: my estimates, no published price.
