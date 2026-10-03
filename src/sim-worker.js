/**
 * Simulations off the page's thread.
 *
 * A year simulated on every plan takes a moment on a phone; done on the page
 * it held every tap until it finished. Here the same model code (src/model.js)
 * runs in a worker: the page sends the household and the tariffs, and gets the
 * figures back while it stays free to scroll and tap.
 */
import { setState, setTariffs, invalidate, withSimState, outcomeAgainst, noSolarNetNow, sweepSetup, evaluateDesign, finishSweep } from './model';

self.onmessage = (e) => {
  const { id, job, state, tariffs } = e.data || {};
  try {
    setState(state);
    if (tariffs) setTariffs(tariffs);
    invalidate();
    const noSolar = noSolarNetNow();
    let result;
    if (job.kind === 'sweep') {
      const J = sweepSetup();
      result = finishSweep(J.list.map(([p, b]) => evaluateDesign(J, p, b, noSolar)), noSolar);
    } else if (job.kind === 'outcomes') {
      result = {};
      for (const [key, ch] of job.items) result[key] = ch ? withSimState(ch, () => outcomeAgainst(noSolar)) : outcomeAgainst(noSolar);
    } else throw new Error('unknown job ' + job.kind);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
