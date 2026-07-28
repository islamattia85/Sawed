/**
 * The design search, off the main thread.
 *
 * A full search is a few hundred 8,760-hour simulations. Run inline that is
 * one to four seconds during which the page cannot scroll, cannot respond to a
 * tap, and cannot animate — the browser is simply gone. Worse, it is the exact
 * moment the reader is waiting for the answer and most likely to touch the
 * screen.
 *
 * Here it costs the main thread nothing, and the wait becomes something the
 * interface can narrate honestly: a progress figure driven by simulations that
 * have genuinely been run, not a spinner that means "please wait".
 *
 * Cost models cannot cross a postMessage boundary — they are functions — so
 * they are named by the caller and reconstructed here from parameters. The
 * alternative, shipping the coefficients as data and evaluating them on the
 * main thread, would put the pricing model in two places and let them drift.
 */

import { searchDesigns, explain, confidence } from './engine/search';

/** The app's install-cost model, as parameters rather than a closure. */
function costModel(p) {
  return {
    installCost: (kwp, batt) => {
      const panelCost = kwp <= p.panelBreakKwp
        ? kwp * p.panelRateLow
        : p.panelBreakKwp * p.panelRateLow + (kwp - p.panelBreakKwp) * p.panelRateHigh;
      const battCost = (batt || 0) > 0 ? p.batteryBase + batt * p.batteryPerKwh : 0;
      return Math.round((p.base + panelCost + battCost) / 100) * 100;
    },
    grant: (kwp) => (kwp <= 0 ? 0
      : Math.min(Math.round(Math.min(kwp, p.grantKwpCap) * p.grantPerKwp), p.grantMax)),
  };
}

self.onmessage = (e) => {
  const { id, home, plans, costs, limits } = e.data || {};
  try {
    const profile = {
      ...home,
      genPerKwp: new Float32Array(home.genPerKwp),
      cons: new Float32Array(home.cons),
      consNoEv: new Float32Array(home.consNoEv),
      wholesale: home.wholesale ? new Float32Array(home.wholesale) : null,
    };

    let lastPost = 0;
    const result = searchDesigns(profile, plans, costModel(costs), limits, (p) => {
      // Throttled: a message per simulation would cost more than the search.
      const now = Date.now();
      if (now - lastPost < 80 && p.fraction < 1) return;
      lastPost = now;
      self.postMessage({ id, type: 'progress', progress: p });
    });

    self.postMessage({
      id,
      type: 'done',
      result,
      reasons: explain(result, limits),
      confidence: confidence(result),
    });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String((err && err.message) || err) });
  }
};
