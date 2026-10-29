/**
 * Parts of Peakless that are built but switched off for the first launch.
 * Turning one on shows it in the app and, for quote requests, opens the
 * server endpoint too. Before turning one on, update the privacy page, the
 * terms and docs/monetisation-setup.md: each changes what we say we do.
 */
export const FEATURES = {
  // "Get 3 quotes": quote requests passed to SEAI-registered installers, the
  // installer portal, and the requests listed in Updates and Profile. Off, its
  // database functions are closed: run the grant in
  // supabase/portal_locked_2026_10.sql before switching it on.
  installerQuotes: false,
  // Suppliers that pay us for a switch: "Switch with Peakless", the
  // commission note, and referral links with a click ID.
  partners: false,
  // Asking for an email before the PDF report. Nothing sends it yet
  // (LEAD_ENDPOINT in src/main.js is empty).
  emailCapture: false,
  // Reading an uploaded quote with AI (api/extract-quote.js): the upload
  // buttons, the file picker in the quote sheet, and the endpoint. Off, a
  // quote is checked from the figures the person types in.
  quoteReader: false,
  // Signing in or up, and every prompt to. Off for the private test (29 Oct
  // 2026): each home stays on its own device, and nothing of it reaches the
  // database. Someone already signed in keeps their account.
  accounts: false,
  // The private test: a line under the top bar saying so, with a button to
  // send feedback to the company's contact address (CONTROLLER.email).
  testVersion: true,
};
