/**
 * Parts of Peakless that are built but switched off for the first launch.
 * Turning one on shows it in the app and, for quote requests, opens the
 * server endpoint too. Before turning one on, update the privacy page, the
 * terms and docs/monetisation-setup.md: each changes what we say we do.
 */
export const FEATURES = {
  // "Get 3 quotes": quote requests passed to SEAI-registered installers, the
  // installer portal, and the requests listed in Updates and Profile.
  installerQuotes: false,
  // Suppliers that pay us for a switch: "Switch with Peakless", the
  // commission note, and referral links with a click ID.
  partners: false,
  // Asking for an email: the sample report and the PDF report. Nothing sends
  // these yet (LEAD_ENDPOINT in src/main.js is empty).
  emailCapture: false,
};
