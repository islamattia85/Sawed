import { describe, it, expect } from 'vitest';
import { runAlerts, ALERT_FIELDS } from '../../api/_alerts-run.js';

/**
 * A stand-in for the database, answering the calls the run makes the way
 * Supabase does: `->` gives a JSON value, `->>` its text, and range() a page.
 * It records every read, so the test can see nothing more was asked for.
 */
function fakeDb(profiles: any[]) {
  const log = new Set<string>();
  const reads: { fields: string; from: number; to: number }[] = [];
  const pick = (p: any, fields: string) => Object.fromEntries(fields.split(',').map((f) => f.trim()).map((f) => {
    const [alias, path] = (f.includes(':') ? f.split(':') : [f, f]) as [string, string];
    const m = path.match(/^app_state(->>?)(\w+)$/);
    if (!m) return [alias, p[path]];
    const v = p.app_state?.[m[2] as string];
    return [alias, v === undefined ? null : m[1] === '->>' ? (typeof v === 'string' ? v : JSON.stringify(v)) : v];
  }));
  return {
    reads, log,
    from(table: string) {
      if (table === 'alert_log') return {
        insert: async (r: any) => { const k = `${r.user_id}|${r.alert_key}`; if (log.has(k)) return { error: { code: '23505' } }; log.add(k); return { error: null }; },
        delete: () => ({ eq: (_: string, id: string) => ({ eq: async (__: string, key: string) => { log.delete(`${id}|${key}`); return { error: null }; } }) }),
      };
      let fields = '', filter: [string, string] | null = null;
      const q: any = {
        select(f: string) { fields = f; return q; },
        eq(c: string, v: string) { filter = [c, v]; return q; },
        order() { return q; },
        async range(a: number, b: number) {
          reads.push({ fields, from: a, to: b });
          const key = filter && filter[0].match(/^app_state->>(\w+)$/)?.[1];
          const rows = profiles.filter((p) => !key || String(p.app_state?.[key]) === filter![1]).sort((x, y) => (x.id < y.id ? -1 : 1));
          return { data: rows.slice(a, b + 1).map((p) => pick(p, fields)), error: null };
        },
      };
      return q;
    },
  };
}

const plan = { id: 'BG-24', supplier: 'Bord Gáis Energy', plan: 'Smart All Day', price_change: { effective_date: '2026-10-20', pct: 0.091, direction: 'increase' } };
const METER = { days: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`d${i}`, Array(48).fill(0.5)])) };
const homes = (n: number, on = true) => Array.from({ length: n }, (_, i) => ({ id: `u${String(i).padStart(5, '0')}`, email: `home${i}@example.ie`,
  app_state: { alerts_email: on, onboarding_complete: true, baseline: 'BG-24', meter: METER } }));

describe('the daily alert run', () => {
  it('reads only the homes that turned emails on, and only the four answers the rules use, never the meter readings', async () => {
    const db = fakeDb([...homes(3), ...homes(2, false).map((h) => ({ ...h, id: `x${h.id}` }))]);
    const sent: string[] = [];
    const r = await runAlerts({ db, tariffs: [plan], today: '2026-10-05', send: async (m) => { sent.push(m.to); return true; } });
    expect(r).toMatchObject({ ok: true, households: 3, sent: 3, more: false });
    expect(db.reads.every((x) => x.fields === ALERT_FIELDS)).toBe(true);
    expect(ALERT_FIELDS).not.toMatch(/meter|app_state(?!->)/);
  });

  it('goes past 5,000 homes, a page at a time, and sends each email once even when run again', async () => {
    const db = fakeDb(homes(5200));
    let n = 0;
    const send = async () => { n++; return true; };
    const r = await runAlerts({ db, tariffs: [plan], today: '2026-10-05', send, page: 500 });
    expect(r).toMatchObject({ households: 5200, sent: 5200, more: false });
    expect(db.reads.length).toBe(11);
    const again = await runAlerts({ db, tariffs: [plan], today: '2026-10-05', send, page: 500 });
    expect(again).toMatchObject({ sent: 0, skipped: 5200 });
    expect(n).toBe(5200);
  }, 30_000);   // 10,400 homes in all: past vitest's 5 s when the machine is busy

  it('stops starting new homes when its time is up, says so, and the next run finishes the rest', async () => {
    const db = fakeDb(homes(50));
    let t = 0;
    const first = await runAlerts({ db, tariffs: [plan], today: '2026-10-05', send: async () => true, now: () => (t += 10), budgetMs: 200 });
    expect(first.more).toBe(true);
    expect(first.sent).toBeGreaterThan(0);
    expect(first.sent).toBeLessThan(50);
    const second = await runAlerts({ db, tariffs: [plan], today: '2026-10-05', send: async () => true });
    expect(second.sent + first.sent).toBe(50);
  });

  it('an email that fails to send is tried again next run', async () => {
    const db = fakeDb(homes(1));
    expect((await runAlerts({ db, tariffs: [plan], today: '2026-10-05', send: async () => false })).sent).toBe(0);
    expect((await runAlerts({ db, tariffs: [plan], today: '2026-10-05', send: async () => true })).sent).toBe(1);
  });
});
