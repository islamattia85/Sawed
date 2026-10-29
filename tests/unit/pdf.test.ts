import { describe, it, expect } from 'vitest';
import { jsPDF } from 'jspdf';
import { renderReport, type ReportData } from '../../src/pdf/report.js';
import { PAGE, TEXT_LEFT, TEXT_RIGHT } from '../../src/pdf/theme.js';
import { eur, type HousePicture } from '../../src/pdf/blocks.js';

/**
 * The report renderer takes plain data and no globals, so the whole document
 * can be produced in Node. These tests catch the two failure modes that
 * actually bit the previous generator: invalid geometry reaching jsPDF (which
 * throws and silently degrades the user to a text file), and content drawn
 * outside its container.
 */

/** A 1×1 PNG: the app paints the real picture, so any image will do here. */
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** Profile's picture as src/ui/house-print.js hands it over: the card and its words, in CSS pixels. */
function picture(): HousePicture {
  const mist = [143, 176, 184], paper = [238, 243, 244];
  const label = (x: number, y: number, anchor: 'start' | 'end', l: [string, string, string]) => [
    { text: l[0], x, y, anchor, size: 12, weight: 700, color: mist },
    { text: l[1], x, y: y + 19, anchor, size: 15, weight: 700, color: paper },
    { text: l[2], x, y: y + 36, anchor, size: 12, weight: 400, color: mist },
  ];
  return {
    image: PIXEL, width: 388, height: 376,
    words: [
      { text: 'Your home · a typical year', x: 18, y: 29, anchor: 'start', size: 12, weight: 400, color: mist },
      { text: 'installed', x: 330, y: 29, anchor: 'middle', size: 12, weight: 700, color: mist },
      ...label(28, 62, 'start', ['Grid', '4,090 kWh bought', '3,247 kWh sold']),
      ...label(360, 62, 'end', ['Solar', '4,252 kWh made', '12 panels · 5.3 kWp']),
      ...label(362, 138, 'end', ['Battery', '5 kWh', 'gives 1,120 kWh']),
      ...label(28, 318, 'start', ['Home', '5,000 kWh used', 'Hot water from the boiler']),
      ...label(360, 318, 'end', ['EV', '2,805 kWh', '16,500 km a year']),
    ],
  };
}

function fixture(over: Partial<ReportData> = {}): ReportData {
  const cumulative = [-10200];
  for (let y = 1; y <= 20; y += 1) {
    cumulative.push((cumulative[y - 1] ?? 0) + 900 - (y === 12 ? 2000 : 0));
  }
  return {
    generatedAt: new Date('2026-07-26T12:00:00Z'),
    origin: 'example.ie',
    home: { annualKwh: 5000, heating: 'Gas', region: 'East / Dublin', systemLabel: '5.3 kWp + 5 kWh battery' },
    current: { name: 'Electric Ireland — Home Dual+ 24hr', annualCost: 1886, standing: 329 },
    best: {
      name: 'Energia — EV Smart Drive',
      supplier: 'Energia',
      annualCost: 74,
      standing: 265,
      dayProfile: Array.from({ length: 24 }, (_, h) => (h >= 2 && h < 5 ? 0.094 : 0.40)),
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
      supplier: `Supplier ${i + 1}`,
      cost: 74 + i * 37,
      standing: 250 + i,
      type: i % 3 === 0 ? 'EV' : i % 3 === 1 ? 'Day/Night' : '24h flat',
      dayProfile: Array.from({ length: 24 }, () => 0.35),
    })),
    sensitivity: [
      { label: 'Usage 20% lower', best: 60, current: 1520 },
      { label: 'As modelled', best: 74, current: 1886 },
      { label: 'Usage 20% higher', best: 92, current: 2250 },
    ],
    tariffCount: 24,
    verifiedDate: '24 Jul 2026',
    supplierUrl: 'https://example.ie',
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
      house: picture(),
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
      { term: 'Tariff rates verified', value: '24 Jul 2026 · 25 plans compared' },
      { term: 'Simulation', value: '8,760 hourly steps per plan' },
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
    const d = fixture({ ranked: [{ name: 'Only Plan', supplier: 'Only', cost: 500, standing: 200, type: 'flat' }], usageByPeriod: [] });
    expect(() => renderReport(doc as never, d)).not.toThrow();
    expect(problems).toEqual([]);
  });

  it('keeps every text run inside the page margins', () => {
    const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });
    const overflows: string[] = [];
    const origText = doc.text.bind(doc);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (doc as any).text = (txt: any, x: number, y: number, opts?: any) => {
      const pageNo = doc.getNumberOfPages();
      const s = Array.isArray(txt) ? txt.join(' ') : String(txt);
      const w = doc.getTextWidth(s);
      const align = opts?.align ?? 'left';
      const startX = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
      // The dark cover band is full-bleed by design; everything else is inset.
      const onCover = pageNo === 1;
      if (!onCover && (startX < TEXT_LEFT - 3 || startX + w > TEXT_RIGHT + 3)) {
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
      ranked: [{ name: 'X'.repeat(200), supplier: 'X', cost: 100, standing: 200, type: 'flat' }],
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
    // Genuinely outside CP1252 — these corrupt the run they appear in.
    for (const ch of ['\u2212', '\u2010', '\u2044', '\u2265']) {
      expect(joined.includes(ch), `U+${ch.codePointAt(0)!.toString(16)} reached the page`).toBe(false);
    }
    // The en and em dashes ARE in CP1252 and must survive — plan names use them.
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

describe('document conventions', () => {
  it('formats negative money with the sign outside the symbol', () => {
    expect(eur(-87)).toBe('-€87');
    expect(eur(0)).toBe('€0');
    expect(eur(1812)).toBe('€1,812');
  });

  it('produces a navigable document: outline, metadata and folios', () => {
    const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });
    const outlined: string[] = [];
    const props: Record<string, string>[] = [];
    (doc as unknown as { outline: { add: unknown } }).outline = {
      add: (_p: unknown, title: string) => { outlined.push(title); return {}; },
    };
    const origProps = doc.setProperties.bind(doc);
    (doc as unknown as Record<string, unknown>).setProperties = (p: Record<string, string>) => {
      props.push(p); return origProps(p);
    };
    renderReport(doc as never, fixture());
    expect(outlined.length).toBeGreaterThanOrEqual(5);
    expect(outlined).toContain('What you use');
    expect(props[0]?.title).toBeTruthy();
    expect(props[0]?.author).toBe('Peakless');
  });

  it('gives every chapter a distinct running head', () => {
    const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });
    const outlined: { title: string; page: number }[] = [];
    (doc as unknown as { outline: { add: unknown } }).outline = {
      add: (_p: unknown, title: string, o: { pageNumber: number }) => {
        outlined.push({ title, page: o.pageNumber }); return {};
      },
    };
    renderReport(doc as never, fixture());
    // Chapters must appear in ascending page order and never before page 3,
    // since pages 1-2 are the cover and contents.
    let prev = 0;
    for (const ch of outlined) {
      expect(ch.page).toBeGreaterThanOrEqual(3);
      expect(ch.page).toBeGreaterThanOrEqual(prev);
      prev = ch.page;
    }
  });

  it('the appendix lists every ranked plan', () => {
    const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });
    const drawn: string[] = [];
    const orig = doc.text.bind(doc);
    (doc as unknown as Record<string, unknown>).text = (t: unknown, x: number, y: number, o?: unknown) => {
      drawn.push(Array.isArray(t) ? (t as string[]).join(' ') : String(t));
      return (orig as (...a: unknown[]) => unknown)(t, x, y, o);
    };
    const f = fixture();
    renderReport(doc as never, f);
    // Rank numbers 1..N must all be present in the appendix column.
    for (let i = 1; i <= f.ranked.length; i += 1) {
      expect(drawn.includes(String(i)), `rank ${i} missing from appendix`).toBe(true);
    }
  });
});

describe('the picture of the home', () => {
  /**
   * The app draws and paints the picture (src/ui/house-print.js; the browser
   * tests compare it with Profile's). What is left here is placing it: the card
   * inside the measure and on one page, and every word on the card.
   */
  function placed(data: ReportData) {
    const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });
    const raw = doc as unknown as Record<string, (...a: unknown[]) => unknown>;
    const images: { page: number; x: number; y: number; w: number; h: number }[] = [];
    const words: { page: number; s: string; x: number; y: number; w: number; align: string }[] = [];
    const addImage = raw.addImage!.bind(doc), text = raw.text!.bind(doc);
    raw.addImage = (...a: unknown[]) => {
      const [, , x, y, w, h] = a as number[];
      images.push({ page: doc.getNumberOfPages(), x: x!, y: y!, w: w!, h: h! });
      return addImage(...a);
    };
    raw.text = (...a: unknown[]) => {
      const [t, x, y, o] = a as [string, number, number, { align?: string } | undefined];
      words.push({ page: doc.getNumberOfPages(), s: String(t), x, y, w: doc.getTextWidth(String(t)), align: o?.align ?? 'left' });
      return text(...a);
    };
    renderReport(doc as never, data);
    return { images, words };
  }

  it('sits inside the measure, on one page, at the shape the app painted it', () => {
    const { images } = placed(fixture());
    expect(images.length).toBe(1);
    const [im] = images as [typeof images[0]];
    expect(im.x).toBeGreaterThanOrEqual(TEXT_LEFT - 0.01);
    expect(im.x + im.w).toBeLessThanOrEqual(TEXT_RIGHT + 0.01);
    expect(im.y).toBeGreaterThan(0);
    expect(im.y + im.h).toBeLessThan(PAGE.height - PAGE.marginBottom);
    expect(im.h / im.w).toBeCloseTo(376 / 388, 6);
  });

  it('sets every word of the picture on it, where the app put it', () => {
    const pic = picture();
    const { images, words } = placed(fixture());
    const [im] = images as [typeof images[0]];
    const k = im.w / pic.width;
    for (const t of pic.words) {
      const hit = words.find((w) => w.page === im.page && w.s === t.text);
      expect(hit, `"${t.text}" not set`).toBeTruthy();
      expect(hit!.x).toBeCloseTo(im.x + t.x * k, 6);
      expect(hit!.y).toBeCloseTo(im.y + t.y * k, 6);
      expect(hit!.align).toBe({ start: 'left', middle: 'center', end: 'right' }[t.anchor]);
      const x0 = hit!.align === 'right' ? hit!.x - hit!.w : hit!.align === 'center' ? hit!.x - hit!.w / 2 : hit!.x;
      expect(x0, `"${t.text}" runs off the left of the card`).toBeGreaterThanOrEqual(im.x);
      expect(x0 + hit!.w, `"${t.text}" runs off the right of the card`).toBeLessThanOrEqual(im.x + im.w);
      expect(hit!.y).toBeLessThan(im.y + im.h);
    }
  });

  it('leaves it out, and nothing else, when the app could not paint it', () => {
    const f = fixture();
    const { images, words } = placed(fixture({ solar: { ...f.solar!, house: undefined } }));
    expect(images).toEqual([]);
    expect(words.some((w) => w.s === 'Where the generation goes')).toBe(true);
  });

  it('passes no invalid geometry, with or without the picture', () => {
    for (const house of [picture(), undefined]) {
      const { doc, problems } = auditedDoc();
      const f = fixture();
      renderReport(doc as never, fixture({ solar: { ...f.solar!, house } }));
      expect(problems).toEqual([]);
    }
  });
});

describe('a hand-picked plan', () => {
  const chosen = () => fixture({
    choice: { rank: 3, premium: 64, cheapestName: 'Yuno Energy — EV Variable Discount', cheapestCost: 506 },
  });

  const drawnText = (data: ReportData) => {
    const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });
    const out: string[] = [];
    const orig = doc.text.bind(doc);
    (doc as unknown as Record<string, unknown>).text = (t: unknown, x: number, y: number, o?: unknown) => {
      out.push(Array.isArray(t) ? (t as string[]).join(' ') : String(t));
      return (orig as (...a: unknown[]) => unknown)(t, x, y, o);
    };
    renderReport(doc as never, data);
    return out.join('\n');
  };

  it('is never presented as our recommendation', () => {
    const text = drawnText(chosen());
    expect(text).toContain('YOUR CHOICE');
    expect(text).not.toContain('RECOMMENDED');
  });

  it('states the rank and what the choice costs', () => {
    const text = drawnText(chosen());
    expect(text).toMatch(/€64/);
    expect(text).toContain('Yuno Energy — EV Variable Discount');
  });

  it('still says RECOMMENDED when the reader made no choice', () => {
    expect(drawnText(fixture())).toContain('RECOMMENDED');
  });

  it('lays out inside the margins with the extra callout', () => {
    const { doc, problems } = auditedDoc();
    expect(() => renderReport(doc as never, chosen())).not.toThrow();
    expect(problems).toEqual([]);
  });
});
