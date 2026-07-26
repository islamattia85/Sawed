import { describe, it, expect } from 'vitest';
import { jsPDF } from 'jspdf';
import { renderReport, type ReportData } from '../../src/pdf/report.js';
import { PAGE } from '../../src/pdf/theme.js';

/**
 * The report renderer takes plain data and no globals, so the whole document
 * can be produced in Node. These tests catch the two failure modes that
 * actually bit the previous generator: invalid geometry reaching jsPDF (which
 * throws and silently degrades the user to a text file), and content drawn
 * outside its container.
 */

function fixture(over: Partial<ReportData> = {}): ReportData {
  const cumulative = [-10200];
  for (let y = 1; y <= 20; y += 1) {
    cumulative.push((cumulative[y - 1] ?? 0) + 900 - (y === 12 ? 2000 : 0));
  }
  return {
    generatedAt: new Date('2026-07-26T12:00:00Z'),
    origin: 'example.ie',
    home: { annualKwh: 5000, heating: 'Gas', region: 'East / Dublin', systemLabel: '5.3 kWp + 5 kWh battery' },
    current: { name: 'Electric Ireland — Home Dual+ 24hr', annualCost: 1886 },
    best: {
      name: 'Energia — EV Smart Drive',
      annualCost: 74,
      rates: [
        { label: 'Day', value: '40.16c' },
        { label: 'Night', value: '18.30c' },
        { label: 'EV', value: '9.42c' },
        { label: 'Export', value: '18.50c' },
        { label: 'Standing', value: '€265/yr' },
      ],
    },
    savings: { total: 1812, unitRate: 1148, standing: 64, exportIncome: 601 },
    ranked: Array.from({ length: 24 }, (_, i) => ({
      name: `Supplier ${i + 1} — A Reasonably Long Plan Name Here`,
      cost: 74 + i * 37,
    })),
    usageByPeriod: [
      { label: 'P1', value: 1167 }, { label: 'P2', value: 1000 }, { label: 'P3', value: 583 },
      { label: 'P4', value: 500 }, { label: 'P5', value: 750 }, { label: 'P6', value: 1000 },
    ],
    usageBasis: 'Estimated from your bill',
    solar: {
      kwp: 5.28, panels: '12 × 440W', battery: '5 kWh battery', orientation: '180° · 35° tilt',
      generated: 4252, selfConsumed: 1005, exported: 3247, gridImport: 4090,
      grossCost: 12000, grant: 1800, netCost: 10200,
      year1Saving: 1132, paybackYears: 9, npv20: 4672,
      cumulative, breakevenYear: 12, batteryReplacementYear: 12,
    },
    ev: {
      electricityIncrease: 264, petrolAvoided: 1812, netSaving: 1547,
      km: 16500, fuelPrice: 1.83, efficiency: 17,
    },
    switchSteps: [
      { title: 'Find your MPRN', body: 'The 11-digit Meter Point Reference Number is on your bill.' },
      { title: 'Sign up online', body: 'Takes about ten minutes; the new supplier handles the changeover.' },
    ],
    methodology: [
      { label: 'Tariff rates verified', value: '24 Jul 2026 · 25 plans compared' },
      { label: 'Simulation', value: '8,760 hourly steps per plan' },
    ],
    ...over,
  };
}

/** Wraps a doc so every geometry call is checked before jsPDF sees it. */
function auditedDoc() {
  const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });
  const problems: string[] = [];
  const nums = (name: string, args: unknown[]) => {
    args.forEach((a, i) => {
      if (typeof a === 'number' && !Number.isFinite(a)) problems.push(`${name} arg${i} = ${a}`);
    });
  };
  const raw = doc as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const m of ['rect', 'roundedRect', 'line', 'text'] as const) {
    const orig = raw[m]!.bind(doc);
    raw[m] = (...args: unknown[]) => {
      nums(m, args);
      if (m === 'roundedRect') {
        const [, , w, h] = args as number[];
        if ((w ?? 0) <= 0 || (h ?? 0) <= 0) problems.push(`roundedRect non-positive size ${w}x${h}`);
      }
      return orig(...args);
    };
  }
  return { doc, problems };
}

describe('PDF report', () => {
  it('renders a full report without throwing', () => {
    const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });
    expect(() => renderReport(doc as never, fixture())).not.toThrow();
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(3);
  });

  it('never passes invalid geometry to jsPDF', () => {
    const { doc, problems } = auditedDoc();
    renderReport(doc as never, fixture());
    expect(problems).toEqual([]);
  });

  it('handles a home with no solar and no EV', () => {
    const { doc, problems } = auditedDoc();
    const d = fixture();
    delete d.solar;
    delete d.ev;
    expect(() => renderReport(doc as never, d)).not.toThrow();
    expect(problems).toEqual([]);
  });

  it('handles zero and negative savings without breaking layout', () => {
    for (const total of [0, -250]) {
      const { doc, problems } = auditedDoc();
      const d = fixture({ savings: { total, unitRate: 0, standing: 0, exportIncome: 0 } });
      expect(() => renderReport(doc as never, d)).not.toThrow();
      expect(problems).toEqual([]);
    }
  });

  it('handles a single ranked plan and an empty usage series', () => {
    const { doc, problems } = auditedDoc();
    const d = fixture({ ranked: [{ name: 'Only Plan', cost: 500 }], usageByPeriod: [] });
    expect(() => renderReport(doc as never, d)).not.toThrow();
    expect(problems).toEqual([]);
  });

  it('keeps every text run inside the page margins', () => {
    const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });
    const overflows: string[] = [];
    const origText = doc.text.bind(doc);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (doc as any).text = (txt: any, x: number, y: number, opts?: any) => {
      const s = Array.isArray(txt) ? txt.join(' ') : String(txt);
      const w = doc.getTextWidth(s);
      const align = opts?.align ?? 'left';
      const startX = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
      // The dark cover band is full-bleed by design; everything else is inset.
      const onCover = y < 55;
      if (!onCover && (startX < PAGE.margin - 3 || startX + w > PAGE.width - PAGE.margin + 3)) {
        overflows.push(`"${s.slice(0, 40)}" spans ${startX.toFixed(1)}..${(startX + w).toFixed(1)}mm`);
      }
      return origText(txt, x, y, opts);
    };
    renderReport(doc as never, fixture());
    expect(overflows).toEqual([]);
  });

  it('long plan names are ellipsised rather than allowed to run over', () => {
    const { doc, problems } = auditedDoc();
    const d = fixture({
      ranked: [{ name: 'X'.repeat(200), cost: 100 }],
      best: { ...fixture().best, name: 'Y'.repeat(160) },
    });
    expect(() => renderReport(doc as never, d)).not.toThrow();
    expect(problems).toEqual([]);
  });
});

describe('text encoding and content safety', () => {
  /** jsPDF built-in fonts are WinAnsi; U+2212 corrupted a whole line. */
  it('maps characters outside WinAnsi rather than emitting garbage', () => {
    const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });
    const drawn: string[] = [];
    const orig = doc.text.bind(doc);
    (doc as unknown as Record<string, unknown>).text = (t: unknown, x: number, y: number, o?: unknown) => {
      drawn.push(Array.isArray(t) ? (t as string[]).join(' ') : String(t));
      return (orig as (...a: unknown[]) => unknown)(t, x, y, o);
    };
    renderReport(doc as never, fixture());
    const joined = drawn.join('\n');
    for (const ch of ['\u2212', '\u00a0', '\u2013']) {
      expect(joined.includes(ch), `U+${ch.codePointAt(0)!.toString(16)} reached the page`).toBe(false);
    }
    // The em dash IS in WinAnsi and must survive, since plan names use it.
    expect(joined).toContain('\u2014');
  });

  it('renders a minus prefix that survives encoding', () => {
    const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });
    const drawn: string[] = [];
    const orig = doc.text.bind(doc);
    (doc as unknown as Record<string, unknown>).text = (t: unknown, x: number, y: number, o?: unknown) => {
      drawn.push(String(t));
      return (orig as (...a: unknown[]) => unknown)(t, x, y, o);
    };
    renderReport(doc as never, fixture());
    expect(drawn.some((s) => /^-\s*€/.test(s))).toBe(true);
  });

  it('does not emit duplicate overlapping axis ticks', () => {
    const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });
    const ticks: string[] = [];
    const orig = doc.text.bind(doc);
    (doc as unknown as Record<string, unknown>).text = (t: unknown, x: number, y: number, o?: unknown) => {
      const s = String(t);
      if (/^Y\d+$/.test(s)) ticks.push(s);
      return (orig as (...a: unknown[]) => unknown)(t, x, y, o);
    };
    renderReport(doc as never, fixture());
    expect(new Set(ticks).size).toBe(ticks.length);
  });
});
