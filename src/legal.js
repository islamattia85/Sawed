// @ts-check
/**
 * What Peakless tells people about itself, in one place: the company's
 * details and the wording of the legal pages (11 Oct 2026). The same texts
 * are in "Peakless Energy Limited: legal pack (draft)", which a solicitor
 * reviews before launch; change both together.
 *
 * Pages are built from these as HTML; the buttons that act on the data
 * (download, clear, delete, usage counts) stay with the screens in main.js.
 */
import { CONTROLLER as C } from './brand';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
/** A detail the company has yet to supply shows as such, never as a blank. */
const fill = (v, what) => (v ? esc(v) : `<i>[${what} to be added]</i>`);
const mail = () => (C.email ? `<a href="mailto:${esc(C.email)}">${esc(C.email)}</a>` : fill('', 'email'));
const go = (screen, words) => `<a href="#${screen}" onclick="event.preventDefault();setScreen('${screen}')">${words}</a>`;

/**
 * The particulars a company's website must show (Companies Act 2014,
 * s.151(4)): name and legal form, where it is registered and its number,
 * and its registered office.
 */
export function companyLine(){
  return `${esc(C.name)}, a ${esc(C.form)}. Registered in Ireland, number ${fill(C.number, 'company number')}. Registered office: ${fill(C.address, 'address')}.`;
}

/** The screens the legal pages live on, in the order they are listed. */
export const LEGAL_SCREENS = [
  ['privacy', 'Privacy and your data', 'What we keep, who sees it, delete your account'],
  ['terms', 'Terms of use', 'What the figures are, and what they aren’t'],
  ['ranking', 'How we rank plans', 'One sum for every plan, and nobody pays to move up'],
  ['accessibility', 'Accessibility', 'How far we’ve got, and how to tell us'],
  ['complaints', 'Complaints', 'Who to tell, and when you’ll hear back'],
];

const updated = () => `<p class="privacy-date">Updated ${esc(C.updated)}. ${companyLine()}</p>`;

export function termsHtml(){
  return `<p><b>Short version.</b> Peakless is a free calculator. It estimates what each electricity plan, and a solar panel and battery system, would cost your home. It doesn’t sell energy, switch you, or install anything, and nobody pays us for what it shows. Check the price with the supplier or installer before you sign anything.</p>

    <h3>1. Who we are</h3>
    <p>Peakless is run by ${esc(C.name)}, a ${esc(C.form)}, registered in Ireland under number ${fill(C.number, 'company number')}, with its registered office at ${fill(C.address, 'address')}. Email ${mail()}. By using Peakless you agree to these terms.</p>

    <h3>2. What Peakless does</h3>
    <p>You tell us about your home, or add your meter file, and we work out what each plan would cost you over a year, and what panels and a battery would save. We rank plans by that cost and nothing else. Using Peakless is free.</p>

    <h3>3. What the figures are</h3>
    <p>Every figure is an estimate. It comes from what you tell us, the prices suppliers publish on their own websites, and typical Irish weather. Your real bills and solar will differ, sometimes by more than the range we show. We check prices often, and each plan shows the date we last did, but prices change and we can get one wrong. The supplier’s own price is the one that counts. If you spot a wrong price, email us: we check it against the supplier’s page and correct it once confirmed.</p>

    <h3>4. It isn’t advice</h3>
    <p>Peakless isn’t a regulated financial adviser, an energy supplier, a broker or a switching service. The plan we rank first is the cheapest for the figures you gave us. Whether it suits you, and whether to switch or buy, is your decision.</p>

    <h3>5. Switching and installers</h3>
    <p>You switch on the supplier’s own website, under the supplier’s terms. We aren’t part of that contract and we send the supplier nothing. Our quote check compares a price with typical prices for that size of system. It says nothing about an installer’s work, products or guarantees: check that the installer is SEAI-registered and read the quote yourself.</p>

    <h3>6. Your account</h3>
    <p>You don’t need an account. If you make one, you must be 18 or over, give an email address you use, and keep your sign-in to yourself. You can delete the account at any time in ${go('privacy', 'Privacy')}.</p>

    <h3>7. What you add</h3>
    <p>Only add meter files and quote figures that are yours, or that you have the right to share. They stay yours. You let us use them only to work out your figures, as the ${go('privacy', 'privacy notice')} explains.</p>

    <h3>8. Fair use</h3>
    <p>Don’t try to break, overload or copy Peakless or its plan data in bulk, or use it to mislead anyone. We may block use that does, and close an account that does, after telling you why where we reasonably can.</p>

    <h3>9. Our content</h3>
    <p>The app, its text, designs and plan data belong to ${esc(C.name)}. You may use them for your own home and share your own results. Anything else needs our written permission.</p>

    <h3>10. Changes to Peakless</h3>
    <p>We may change, add or stop features. If we stop something account holders rely on, we’ll tell them by email at least 30 days before, where we can, so they can download their data.</p>

    <h3>11. Our responsibility to you</h3>
    <p>We build Peakless with care and offer it free. We are responsible for loss you suffer that was a foreseeable result of our breaking these terms or not taking reasonable care. We aren’t responsible for loss that wasn’t foreseeable, for business losses (Peakless is for homes), or for decisions you make after checking the supplier’s or installer’s own price. Nothing in these terms limits your rights as a consumer, or our responsibility for death or injury caused by negligence, for fraud, or for anything else the law doesn’t let us limit.</p>

    <h3>12. Complaints</h3>
    <p>Email ${mail()}. We’ll reply within 10 working days and aim to sort it within 30. Our ${go('complaints', 'complaints procedure')} says more. You can also use the Small Claims procedure of the District Court, or contact the Competition and Consumer Protection Commission (ccpc.ie).</p>

    <h3>13. Changes to these terms</h3>
    <p>The date below shows the latest version. If a change affects account holders in a way that matters, we’ll email them at least 30 days before it applies. If you don’t agree, you can delete your account before then.</p>

    <h3>14. Law</h3>
    <p>Irish law applies. You can bring a claim in the Irish courts or, if you live elsewhere in the EU, in the courts where you live.</p>
    ${updated()}`;
}

/**
 * The privacy notice (GDPR Articles 13 and 14).
 * @param {{ quotes: boolean }} o quotes: quote requests to installers are switched on.
 */
export function privacyHtml(o){
  const row = (what, why, keep) => `<tr><td>${what}</td><td>${why}</td><td>${keep}</td></tr>`;
  const Q = o.quotes;
  return `<p><b>Short version.</b> Your home stays on your device unless you make an account. ${Q ? 'We only share your details with installers when you ask for quotes, and never with suppliers' : 'We don’t pass your details to suppliers or installers'}, we have no ads, and we never sell your data.</p>

    <h3>Who we are</h3>
    <p>${esc(C.name)}, registered in Ireland under number ${fill(C.number, 'company number')}, at ${fill(C.address, 'address')}, is the controller of your personal data. Email ${mail()} about anything here. We don’t have a data protection officer; the law doesn’t require one for a service like ours, and our privacy contact answers instead.</p>

    <h3>What we hold, why, and for how long</h3>
    <table class="privacy-table">
      <thead><tr><th>What</th><th>Why (legal basis)</th><th>Kept</th></tr></thead>
      <tbody>
        ${row('Your answers, results and meter file, on your device', 'To give you the answer. We never see them unless you make an account', 'Until you clear them')}
        ${row('Account: email, name, your home’s answers, the meter readings you load, saved quotes', 'To keep your home on every device you sign in on (contract)', 'Until you delete the account')}
        ${Q ? row('Quote request: name, email, phone, county, system', 'To get you installer quotes (your consent)', '24 months') : ''}
        ${row('Alert emails, and the record of which were sent', 'You turned them on (consent)', 'Until you turn them off; the record 13 months')}
        ${row('Figures you type in from an installer’s quote: price, panels, battery', 'To check the price and work out its payback (contract). We never see the quote itself', 'On your device, and in your account if you have one')}
        ${row('Anonymous usage counts', 'To see which parts help people, so we can improve them (consent)', '26 months')}
        ${row('The record of your consent choices', 'To show we asked (legal obligation)', '36 months')}
        ${row('A scrambled form of your internet address', 'To stop abuse of the app (legitimate interest)', '1 day')}
        ${row('Error reports: what went wrong, nothing about you', 'To fix faults (legitimate interest)', '30 days')}
        ${row('Emails you send us', 'To answer you (legitimate interest)', '2 years after the last reply')}
      </tbody>
    </table>

    <h3>About meter files</h3>
    <p>Half-hourly readings can show when a home is busy or empty. We use them only to work out your figures. They stay on your device unless you make an account, and we never share them.</p>

    <h3>Where it comes from</h3>
    <p>From you. Quote figures are what you type in; a meter file comes from ESB Networks through you. If you sign in with Google, Google gives us your name and email.</p>

    <h3>Who receives it</h3>
    <p>Only these services, each bound by a data processing agreement to use it only for us:</p>
    <ul>
      ${Q ? '<li><b>Installers</b>: up to three SEAI-registered installers, only if you ask for quotes. Each then uses your details as its own, to quote for you.</li>' : ''}
      <li><b>Supabase</b>: our database: accounts, saved homes, consent records, error reports. In Ireland.</li>
      <li><b>Vercel</b>: hosts the app and, if you allow it, counts visits without cookies. EU and USA.</li>
      <li><b>Resend</b>: sends our emails. USA.</li>
      <li><b>Google</b>: sign-in, only if you choose it.</li>
    </ul>
    <p>Transfers to the USA are covered by the EU–US Data Privacy Framework where the service is certified, and otherwise by the EU’s standard contractual clauses. We send nothing to suppliers: you switch on their own website.${Q ? '' : ' Installers receive nothing from us.'}</p>

    <h3>Automated decisions</h3>
    <p>Peakless uses no AI on your data. Nothing about you is decided by a computer in a way that has legal or similar effects on you: plan rankings are calculations to help you choose.</p>

    <h3>On your device</h3>
    <p>We set no cookies. The app keeps a few things in your browser’s own storage. Only usage counts need your yes; the rest are needed for what you asked the app to do.</p>
    <table class="privacy-table">
      <thead><tr><th>What</th><th>For</th><th>Kept</th></tr></thead>
      <tbody>
        ${row('Your answers and results', 'Your home, next time you open the app', 'Until you clear them')}
        ${row('Your usage-counts answer', 'So we don’t ask again', 'Until you clear it')}
        ${row('Your sign-in', 'Keeps you signed in, if you have an account', 'Until you sign out')}
        ${row('A copy of your home during the solar guide', 'So leaving the guide puts it back', 'Until the guide ends')}
        ${row('Where you were going, during sign-in', 'To take you back there', 'Until you close the tab')}
        ${row('A random number for this visit', 'Usage counts, only if you allow them', 'Until you close the tab')}
        ${row('The app’s own files', 'So it opens without a signal', 'Until the next version')}
      </tbody>
    </table>

    <h3>Keeping it safe</h3>
    <p>Connections are encrypted, the database lets each account read only its own rows, and the keys that unlock it stay on our servers.</p>

    <h3>Your rights</h3>
    <p>You can see, download, correct or delete your data, restrict or object to how we use it, and withdraw consent at any time. The buttons below do most of it; email us for the rest. It’s free, and we reply within a month. You can also complain to the Data Protection Commission at <a href="https://www.dataprotection.ie" target="_blank" rel="noopener">dataprotection.ie</a>.</p>

    <h3>Children</h3>
    <p>Peakless is for adults running a home. Accounts are for people 18 and over.</p>

    <h3>Changes</h3>
    <p>We’ll date every change here, and email account holders before a change that matters. See also our ${go('terms', 'terms of use')}.</p>
    ${updated()}`;
}

/**
 * How plans are compared and ranked: Article 14 of Directive (EU) 2019/944
 * on comparison tools, and the main parameters of a ranking that consumer
 * law asks a comparison site to give.
 * @param {{ plans: number, suppliers: number, exportTaxFree: number, paid: boolean }} o
 *   paid: a supplier or installer pays us (src/features.js); the page then says so.
 */
export function rankingHtml(o){
  return `<p><b>We rank plans by one thing:</b> what each would cost your home over the next 12 months. Nobody pays us to show a plan, or to move it up.</p>

    <h3>Who runs Peakless</h3>
    <p>${esc(C.name)}. No supplier or installer owns any part of it${o.paid ? '.' : ' or pays it.'}</p>

    <h3>What we compare</h3>
    <p>Every residential electricity plan we find on Irish suppliers’ own websites that a new customer can join: ${o.plans} plans from ${o.suppliers} suppliers today. Plans that need a meter or a setup your home doesn’t have are marked, not hidden.</p>

    <h3>How the cost is worked out</h3>
    <p>For every hour of a typical year we take your use, the plan’s rate for that hour, the standing charge, the PSO levy and VAT. We add the plan’s first-year discounts and credits, take off what it pays for the power you sell back, and add the tax on that income above €${o.exportTaxFree.toLocaleString('en-IE')} a year for each person named on the bill. Where a supplier has announced a price change, the new price counts from the day it applies. ${go('methodology', 'How the figures are worked out')} has the detail.</p>

    <h3>What we don’t rank on</h3>
    <p>Customer service, green credentials and contract terms. Exit fees are shown where the supplier publishes one. Read the supplier’s terms before you switch.</p>

    <h3>Kept up to date</h3>
    <p>We check prices daily against the suppliers’ own pages. Each plan shows the date we last checked it.</p>

    <h3>If we’re ever paid</h3>
    <p>${o.paid ? 'Some suppliers or installers pay us when you switch or ask for a quote. Every plan or quote that touches is marked. It never changes the order.' : 'If a supplier or installer ever pays us, we’ll say so here and on every plan it touches. It will never change the order.'}</p>

    <h3>Spotted a wrong price?</h3>
    <p>Email ${mail()}. We check it against the supplier’s page and correct it once confirmed.</p>
    ${updated()}`;
}

export function accessibilityHtml(){
  return `<p>We want everyone to be able to use Peakless, including people who use a screen reader, a keyboard only, or larger text. We aim to meet the Web Content Accessibility Guidelines (WCAG) 2.2 at level AA.</p>

    <h3>How far we’ve got</h3>
    <p>Peakless partly meets that standard. Every release is checked automatically against WCAG 2.1 A and AA on the main screens and sheets, and must pass before it goes live. It has not yet been checked by a specialist or by disabled users, and automatic checks catch only some problems.</p>

    <h3>What we know isn’t right yet</h3>
    <ul>
      <li>Some charts give their figures only as a picture. The figures are in the text nearby or in a table, but not always beside the chart.</li>
      <li>The picture of your home on Profile reads as one image to a screen reader; the figures are in the rows under it.</li>
    </ul>

    <h3>Tell us</h3>
    <p>If something is hard to use, email ${mail()} and say what you were trying to do. We’ll reply within 10 working days and, where we can, give you the information another way while we fix it.</p>
    ${updated()}`;
}

export function complaintsHtml(){
  return `<p>If something in Peakless went wrong for you, tell us and we’ll put it right where we can.</p>
    <ol>
      <li>Email ${mail()} with what happened and what you’d like us to do.</li>
      <li>We’ll reply within 10 working days, saying who is looking at it.</li>
      <li>We’ll give you our final answer within 30 days. If we need longer, we’ll tell you why and when to expect it.</li>
    </ol>

    <h3>If you’re not happy with our answer</h3>
    <ul>
      <li>About your personal data: the Data Protection Commission, <a href="https://www.dataprotection.ie" target="_blank" rel="noopener">dataprotection.ie</a>.</li>
      <li>About how we treated you as a consumer: the Competition and Consumer Protection Commission, <a href="https://www.ccpc.ie" target="_blank" rel="noopener">ccpc.ie</a>, or the Small Claims procedure of the District Court.</li>
      <li>About a supplier’s bill or switch: the supplier first, then the Commission for Regulation of Utilities, <a href="https://www.cru.ie" target="_blank" rel="noopener">cru.ie</a>. We can’t deal with those for you, but we’ll tell you how.</li>
    </ul>
    ${updated()}`;
}
