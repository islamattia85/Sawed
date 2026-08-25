import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Tariff } from '../../src/engine/constants.js';

/**
 * Freshness invariants on the tariff registry.
 *
 * These exist because of what August 2026 found in the shipped data. Electric
 * Ireland raised every unit rate by 9.5% on 1 July 2026. Four of its five plans
 * still carried June rates seven weeks later, and two of them carried a note
 * that said, in plain English, "Prices changing 1 July 2026" — a warning
 * written by a human, read by nobody, and never asserted on.
 *
 * The damage is worse than staleness. Understating one supplier's rates does
 * not make every answer a little wrong; it makes that supplier win rankings it
 * should lose, so the app confidently sends people to the wrong plan. A whole
 * suite of engine tests passed throughout, because none of them ever asked
 * whether the numbers going in were still true.
 *
 * Both checks below are about provenance, not arithmetic. Neither can tell you
 * a rate is correct — only the supplier's own price list does that. What they
 * can do is refuse to let a rate go quietly out of date.
 */

type Registry = (Tariff & {
  verified_date?: string;
  notes?: string;
  discontinued?: boolean;
})[];

/**
 * Pull the embedded registry out of the entry module without executing the app.
 * Mirrors tests/unit/tariff-data.test.ts — see the note there.
 */
function loadTariffs(): Registry {
  const src = readFileSync('src/main.js', 'utf8');
  const start = src.indexOf('const EMBEDDED_TARIFFS = [');
  expect(start).toBeGreaterThan(-1);
  const open = src.indexOf('[', start);
  let depth = 0;
  let end = open;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '[') depth += 1;
    else if (src[i] === ']') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  // eslint-disable-next-line no-new-func
  return new Function(`return ${src.slice(open, end + 1)};`)() as Registry;
}

const REGISTRY = loadTariffs();
const RUNTIME = JSON.parse(readFileSync('public/tariffs.json', 'utf8')) as Registry;

const active = (rows: Registry) => rows.filter((t) => t.id !== '__meta__' && !t.discontinued);

const DAY = 86_400_000;
const parseDay = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

/**
 * A plan is allowed to lag its siblings only if it says so. Two words carry
 * that admission and both are shouted, because they have to survive being
 * skimmed and stay greppable when someone asks which numbers are load-bearing:
 * UNVERIFIED means nobody has re-checked it, DISPUTED means somebody did and a
 * published source disagreed.
 */
const declaresItselfUnverified = (t: Registry[number]) =>
  /\b(UNVERIFIED|DISPUTED)\b/.test(t.notes ?? '');

describe.each([
  ['embedded registry', REGISTRY],
  ['public/tariffs.json', RUNTIME],
] as const)('%s', (_label, rows) => {
  const plans = active(rows);

  it('has plans to check', () => {
    expect(plans.length).toBeGreaterThan(10);
  });

  /**
   * The exact defect. A note announcing a future price change is a promise to
   * come back; once the date passes, either the rates were updated or the
   * promise was broken. Nothing else about the file records which happened.
   */
  it('carries no promise of a price change that has already passed', () => {
    const broken: string[] = [];
    for (const t of plans) {
      const notes = t.notes ?? '';
      const m = notes.match(
        /pric\w*\s+chang\w*\s+(?:on\s+|from\s+)?(\d{1,2}\s+\w+\s+\d{4})/i,
      );
      if (!m) continue;
      const when = Date.parse(`${m[1]} UTC`);
      if (!Number.isFinite(when)) continue;
      const verified = t.verified_date ? parseDay(t.verified_date) : 0;
      if (when < Date.now() && verified < when) {
        broken.push(
          `${t.id}: notes promise a change on ${m[1]}, but verified_date is ${t.verified_date ?? 'unset'}`,
        );
      }
    }
    expect(broken).toEqual([]);
  });

  it('dates every plan it prices', () => {
    const undated = plans.filter((t) => typeof t.verified_date !== 'string');
    expect(undated.map((t) => t.id)).toEqual([]);
  });

  /**
   * A supplier changes all of its prices on one day. So when the plans of a
   * single supplier carry different verification dates, somebody went through
   * that supplier's price list and missed one — which is exactly what happened
   * to Electric Ireland's dynamic plan while its other four were corrected, and
   * to Bord Gáis's day rate, which the runtime file updated and the embedded
   * fallback did not.
   *
   * A plan may lag its siblings only by saying so in its notes. The point is
   * not to forbid an unverified rate; it is to forbid an unverified rate that
   * looks verified.
   */
  it('keeps each supplier internally consistent about when it was checked', () => {
    const bySupplier = new Map<string, Registry>();
    for (const t of plans) {
      const list = bySupplier.get(t.supplier) ?? [];
      list.push(t);
      bySupplier.set(t.supplier, list);
    }

    const offenders: string[] = [];
    for (const [supplier, list] of bySupplier) {
      const newest = Math.max(...list.map((t) => parseDay(t.verified_date as string)));
      for (const t of list) {
        const lag = newest - parseDay(t.verified_date as string);
        if (lag > 7 * DAY && !declaresItselfUnverified(t)) {
          offenders.push(
            `${t.id}: ${supplier} was last checked on ${new Date(newest).toISOString().slice(0, 10)}, ` +
            `but this plan still says ${t.verified_date} and does not admit to being unverified`,
          );
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  /** A verified_date in the future means somebody mistyped a year. */
  it('claims no verification that has not happened yet', () => {
    const future = plans
      .filter((t) => t.verified_date && parseDay(t.verified_date) > Date.now() + DAY)
      .map((t) => `${t.id} (${t.verified_date})`);
    expect(future).toEqual([]);
  });
});

/**
 * The two files are read by the same engine and one silently overrides the
 * other at runtime. A rate corrected in only one of them is a defect that no
 * screen can show you.
 */
describe('the embedded registry and the runtime file agree', () => {
  it('prices every shared plan identically', () => {
    const embedded = new Map(active(REGISTRY).map((t) => [t.id, t]));
    const mismatches: string[] = [];

    for (const t of active(RUNTIME)) {
      const e = embedded.get(t.id);
      if (!e) continue;
      for (const band of ['day', 'night', 'peak', 'ev'] as const) {
        const a = e.rates?.[band];
        const b = t.rates?.[band];
        if (a == null && b == null) continue;
        if (a !== b) mismatches.push(`${t.id}.${band}: embedded ${a} vs runtime ${b}`);
      }
      if (e.standing !== t.standing) {
        mismatches.push(`${t.id}.standing: embedded ${e.standing} vs runtime ${t.standing}`);
      }
    }

    expect(mismatches).toEqual([]);
  });
});
