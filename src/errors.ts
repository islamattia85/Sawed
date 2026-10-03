/**
 * Errors on someone else's phone, reported so they can be fixed.
 *
 * Without this a crash on a user's phone was invisible until they told us.
 * A report carries what broke and where (message, stack, build, screen), never
 * who: anything that looks like an email, a long number or a query string is
 * scrubbed before it leaves the page. At most five reports a session, each
 * different error once.
 */

export interface ErrorReport {
  message: string;
  stack: string;
  source: string;
  build: string;
  version: string;
  screen: string;
  ua: string;
}

const MAX_PER_SESSION = 5;

/** Remove anything that could identify a person or their home. */
export function scrub(text: unknown, max = 2000): string {
  return String(text ?? '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\?[^\s)'"]*/g, '')                       // query strings
    .replace(/\b\d{6,}\b/g, '[n]')                      // MPRNs, phone numbers, ids
    .replace(/https?:\/\/[^/\s]+/g, '')                 // keep the path, drop the host
    .slice(0, max);
}

export function buildReport(err: unknown, extra: { build: string; version: string; screen: string; source?: string }): ErrorReport {
  const e = err as { message?: string; stack?: string } | undefined;
  const message = e && typeof e === 'object' && 'message' in e ? e.message : String(err);
  return {
    message: scrub(message, 300),
    stack: scrub(e && typeof e === 'object' ? e.stack : '', 2000),
    source: scrub(extra.source || '', 200),
    build: String(extra.build).slice(0, 20),
    version: String(extra.version).slice(0, 20),
    screen: String(extra.screen || '').slice(0, 30),
    ua: scrub(typeof navigator !== 'undefined' ? navigator.userAgent : '', 160),
  };
}

export function installErrorReporting(opts: { build: string; version: string; screen: () => string; endpoint?: string }): void {
  if (typeof window === 'undefined') return;
  const seen = new Set<string>();
  const endpoint = opts.endpoint || '/api/error';
  const send = (err: unknown, source = '') => {
    try {
      const r = buildReport(err, { build: opts.build, version: opts.version, screen: opts.screen(), source });
      const key = r.message + '|' + r.stack.split('\n')[1];
      if (seen.has(key) || seen.size >= MAX_PER_SESSION) return;
      seen.add(key);
      const body = JSON.stringify(r);
      // keepalive: the report still goes if the page is closing.
      fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
    } catch { /* reporting must never break the page */ }
  };
  window.addEventListener('error', (ev) => {
    // A failed image or script load is not a code error.
    if (!(ev as ErrorEvent).message && !(ev as ErrorEvent).error) return;
    send((ev as ErrorEvent).error || (ev as ErrorEvent).message, `${(ev as ErrorEvent).filename || ''}:${(ev as ErrorEvent).lineno || ''}`);
  });
  window.addEventListener('unhandledrejection', (ev) => send((ev as PromiseRejectionEvent).reason, 'promise'));
}
