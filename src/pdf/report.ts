/**
 * Report composition.
 *
 * Structure and data are separated: `ReportData` is a plain object the caller
 * assembles from app state, and nothing in here reads a global. That makes the
 * whole document renderable in a test with fixed inputs.
 */

import { Canvas, type PdfDoc } from './layout.js';
import { C, T, S, LW, PAGE, reportOrigin } from './theme.js';
import {
  sectionHeader, figureRow, tileRow, rankTable, barChart, cashFlowChart,
  legend, step, money, type RankRow,
} from './components.js';

export interface ReportData {
  generatedAt: Date;
  origin: string;
  home: {
    annualKwh: number;
    heating: string;
    region: string;
    systemLabel: string;
  };
  current: { name: string; annualCost: number };
  best: {
    name: string;
    annualCost: number;
    rates: { label: string; value: string }[];
    exportRate?: string;
  };
  savings: {
    total: number;
    unitRate: number;
    standing: number;
    exportIncome: number;
  };
  ranked: { name: string; cost: number }[];
  usageByPeriod: { label: string; value: number }[];
  usageBasis: string;
  solar?: {
    kwp: number;
    panels: string;
    battery: string;
    orientation: string;
    generated: number;
    selfConsumed: number;
    exported: number;
    gridImport: number;
    grossCost: number;
    grant: number;
    netCost: number;
    year1Saving: number;
    paybackYears: number | null;
    npv20: number;
    cumulative: number[];
    breakevenYear: number | null;
    batteryReplacementYear?: number;
  };
  ev?: {
    electricityIncrease: number;
    petrolAvoided: number;
    netSaving: number;
    km: number;
    fuelPrice: number;
    efficiency: number;
  };
  switchSteps: { title: string; body: string }[];
  methodology: { label: string; value: string }[];
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

/** Full-bleed cover band with the headline figure. */
function cover(c: Canvas, d: ReportData) {
  const bandH = 62;
  c.fill(C.band);
  c.doc.rect(0, 0, PAGE.width, bandH, 'F');
  c.fill(C.gain);
  c.doc.rect(0, bandH - 2, PAGE.width, 2, 'F');

  c.text('Solar Optimiser', c.left, 22, { size: 22, bold: true, color: C.paper });
  c.text('Personalised Irish electricity & solar report', c.left, 30,
    { size: T.body, color: [176, 190, 180] });

  const dateStr = d.generatedAt.toLocaleDateString('en-IE', { day: 'numeric', month: 'long', year: 'numeric' });
  const stamp = [`Generated ${dateStr}`, d.origin].filter(Boolean).join('  ·  ');
  c.text(stamp, c.left, 40, { size: T.micro, color: [128, 146, 134] });
  c.text(
    `${d.home.annualKwh.toLocaleString('en-IE')} kWh/yr  ·  ${d.home.heating} heating  ·  ${d.home.region}  ·  ${d.home.systemLabel}`,
    c.left, 47, { size: T.micro, color: [128, 146, 134], maxWidth: c.width },
  );

  c.y = bandH + 10;

  // Headline: the single number the whole report exists to justify.
  const heroH = 34;
  const hero = c.panel({ h: heroH, bg: C.gainSoft, border: C.gain, accent: C.gain, inset: 6 });
  const inner = hero.inner;
  c.text('ANNUAL SAVING BY SWITCHING PLAN', inner.x, inner.y + 4,
    { size: T.label, bold: true, color: C.gain });
  c.text(money(d.savings.total), inner.x, inner.y + 17,
    { size: T.display, bold: true, color: C.gain });

  // Right-hand EV figure is laid out from measured widths, never against the
  // panel border — this is where the old report clipped its own text.
  if (d.ev && d.ev.netSaving > 0) {
    const label = '+ EV TRANSPORT SAVING';
    const value = `${money(d.ev.netSaving)}/yr`;
    const wNeeded = Math.max(
      c.measure(label, { size: T.label, bold: true }),
      c.measure(value, { size: 15, bold: true }),
    ) + 2;
    const bx = inner.right - wNeeded;
    c.text(label, inner.right, inner.y + 4,
      { size: T.label, bold: true, color: C.gain, align: 'right' });
    c.text(value, inner.right, inner.y + 13,
      { size: 15, bold: true, color: C.gain, align: 'right' });
    c.text('vs running a petrol car', inner.right, inner.y + 17.5,
      { size: T.micro, color: C.inkSoft, align: 'right' });
    void bx;
  }
  c.y += heroH + 3;
  c.text(`Switch to ${d.best.name}`, c.left, c.y + 3,
    { size: T.body, bold: true, color: C.ink, maxWidth: c.width });
  c.y += 8;
}

function planComparison(c: Canvas, d: ReportData) {
  sectionHeader(c, 'Your plan vs the best match', 'Recommendation');

  const rowH = 15;
  const half = (c.width - 4) / 2;
  const cur = c.panel({ x: c.left, w: half, h: rowH, bg: C.costSoft, border: C.cost, inset: 4 });
  c.text('CURRENT PLAN', cur.inner.x, cur.inner.y + 3, { size: T.label, bold: true, color: C.cost });
  c.text(d.current.name, cur.inner.x, cur.inner.y + 8,
    { size: T.dense, color: C.ink, maxWidth: cur.inner.w - 22 });
  c.text(`${money(d.current.annualCost)}/yr`, cur.inner.right, cur.inner.y + 8,
    { size: T.dense, bold: true, color: C.cost, align: 'right' });

  const bx = c.left + half + 4;
  const rec = c.panel({ x: bx, w: half, h: rowH, bg: C.gainSoft, border: C.gain, inset: 4 });
  c.text('RECOMMENDED', rec.inner.x, rec.inner.y + 3, { size: T.label, bold: true, color: C.gain });
  c.text(d.best.name, rec.inner.x, rec.inner.y + 8,
    { size: T.dense, color: C.ink, maxWidth: rec.inner.w - 22 });
  c.text(`${money(d.best.annualCost)}/yr`, rec.inner.right, rec.inner.y + 8,
    { size: T.dense, bold: true, color: C.gain, align: 'right' });
  c.y += rowH + 6;

  // rate card
  const rates = d.best.rates.filter((r) => r.value);
  if (rates.length) {
    c.text('RATES ON THE RECOMMENDED PLAN', c.left, c.y, { size: T.label, bold: true, color: C.inkSoft });
    c.y += 4;
    const cw = c.width / rates.length;
    rates.forEach((r, i) => {
      const x = c.left + i * cw;
      c.text(r.label.toUpperCase(), x, c.y, { size: T.micro, color: C.inkDim, maxWidth: cw - 3 });
      c.text(r.value, x, c.y + 4.6, { size: T.dense, bold: true, color: C.ink, maxWidth: cw - 3 });
    });
    c.y += 11;
  }

  sectionHeader(c, 'Where the saving comes from', 'Breakdown');
  c.paragraph(
    `Both figures below are on the same basis: electricity used, plus the standing charge, minus export income. Comparing ${d.best.name} against ${d.current.name} on your actual usage pattern.`,
    { size: T.dense, color: C.inkSoft, leading: 3.8 },
  );
  c.y += 3;

  const levers = [
    { label: 'Unit rate — electricity you use', v: d.savings.unitRate },
    { label: 'Standing charge', v: d.savings.standing },
    { label: 'Export income', v: d.savings.exportIncome },
  ].filter((l) => Math.abs(l.v) > 0.5);

  const maxLever = Math.max(1, ...levers.map((l) => Math.abs(l.v)));
  levers.forEach((l) => {
    const positive = l.v >= 0;
    c.text(l.label, c.left, c.y, { size: T.dense, color: C.ink, maxWidth: c.width - 30 });
    c.text(`${positive ? '+' : '−'}${money(Math.abs(l.v))}/yr`, c.right, c.y,
      { size: T.dense, bold: true, color: positive ? C.gain : C.cost, align: 'right' });
    c.y += 2.6;
    c.fill(C.rule);
    c.doc.roundedRect(c.left, c.y, c.width, 1.8, 0.5, 0.5, 'F');
    c.fill(positive ? C.gain : C.cost);
    c.doc.roundedRect(c.left, c.y, (Math.abs(l.v) / maxLever) * c.width, 1.8, 0.5, 0.5, 'F');
    c.y += 6.4;
  });

  c.rule();
  c.y += 4.6;
  c.text('Net annual saving', c.left, c.y, { size: T.body, bold: true, color: C.ink });
  c.text(`${money(d.savings.total)}/yr`, c.right, c.y,
    { size: T.body, bold: true, color: C.gain, align: 'right' });
  c.y += S.block;
}

function ranking(c: Canvas, d: ReportData) {
  sectionHeader(c, 'Every plan, ranked on your usage', 'Full comparison', C.gain, 60);
  c.paragraph(
    `All ${d.ranked.length} plans simulated hour by hour against your consumption. The bar shows how much each plan saves against the most expensive option.`,
    { size: T.dense, color: C.inkSoft, leading: 3.8 },
  );
  c.y += 4;

  const worst = Math.max(...d.ranked.map((r) => r.cost));
  const bestCost = Math.min(...d.ranked.map((r) => r.cost));
  const spread = Math.max(1, worst - bestCost);
  const rows: RankRow[] = d.ranked.map((r, i) => ({
    rank: i + 1,
    name: r.name,
    cost: r.cost,
    share: (worst - r.cost) / spread,
    highlight: i === 0,
  }));
  rankTable(c, rows, 'saving vs dearest');
  c.y += 4;
}

function usage(c: Canvas, d: ReportData) {
  sectionHeader(c, 'Your electricity use through the year', 'Consumption', C.use, 52);
  barChart(c, d.usageByPeriod.map((p) => ({ ...p, color: C.use })), {
    height: 34, unit: 'kWh per billing period', color: C.use,
  });
  figureRow(c, 'Total annual consumption',
    `${d.home.annualKwh.toLocaleString('en-IE')} kWh`, { valueColor: C.use });
  figureRow(c, 'Basis', d.usageBasis, { bold: false });
}

function solarSection(c: Canvas, d: ReportData) {
  const s = d.solar;
  if (!s) return;
  sectionHeader(c, 'Solar & battery performance', 'Your system', C.gain, 46);
  c.text(
    `${s.kwp.toFixed(2)} kWp  ·  ${s.panels}  ·  ${s.battery}  ·  ${s.orientation}`,
    c.left, c.y, { size: T.dense, color: C.inkSoft, maxWidth: c.width },
  );
  c.y += 7;

  tileRow(c, [
    { label: 'Generated', value: `${Math.round(s.generated).toLocaleString('en-IE')} kWh`, note: 'per year', color: C.gain, bg: C.gainSoft },
    { label: 'Used at home', value: `${Math.round(s.selfConsumed).toLocaleString('en-IE')} kWh`, note: `${pct(s.selfConsumed, s.generated)}% of generation`, color: C.use, bg: C.useSoft },
    { label: 'Exported', value: `${Math.round(s.exported).toLocaleString('en-IE')} kWh`, note: `${pct(s.exported, s.generated)}% of generation`, color: C.sell, bg: C.sellSoft },
  ]);
  legend(c, [
    { color: C.gain, label: 'generated by your panels' },
    { color: C.use, label: 'consumed in the home' },
    { color: C.sell, label: 'sold back to the grid' },
  ]);

  figureRow(c, 'Still imported from the grid',
    `${Math.round(s.gridImport).toLocaleString('en-IE')} kWh`, { valueColor: C.cost });
  c.y += 2;

  sectionHeader(c, 'What the system costs and returns', 'Payback', C.gain, 52);
  tileRow(c, [
    { label: 'Payback', value: s.paybackYears ? `${s.paybackYears.toFixed(1)} yr` : '—', note: 'simple, at year-1 saving', color: C.ink, bg: C.wash },
    { label: 'Year-1 saving', value: `${money(s.year1Saving)}`, note: 'electricity only', color: C.gain, bg: C.gainSoft },
    { label: '20-year NPV', value: money(s.npv20), note: 'discounted at 3%', color: s.npv20 >= 0 ? C.gain : C.cost, bg: s.npv20 >= 0 ? C.gainSoft : C.costSoft },
  ]);

  figureRow(c, 'Gross installation cost', money(s.grossCost), { valueColor: C.cost });
  figureRow(c, 'SEAI grant', `− ${money(s.grant)}`, { valueColor: C.gain });
  c.rule();
  c.y += 4.4;
  figureRow(c, 'Net cost after grant', money(s.netCost));

  sectionHeader(c, '20-year cumulative position', 'Cash flow', C.gain, 70);
  c.paragraph(
    'Below the line you are still paying the system back; above it you are ahead. The curve already accounts for panel output declining each year.',
    { size: T.dense, color: C.inkSoft, leading: 3.8 },
  );
  c.y += 3;
  cashFlowChart(c, s.cumulative, {
    breakevenYear: s.breakevenYear,
    dipYear: s.batteryReplacementYear,
    height: 46,
  });
}

function evSection(c: Canvas, d: ReportData) {
  const e = d.ev;
  if (!e) return;
  sectionHeader(c, 'Electric vehicle running costs', 'Transport', C.use, 46);
  tileRow(c, [
    { label: 'Extra electricity', value: `+${money(e.electricityIncrease)}`, note: 'to charge the car', color: C.cost, bg: C.costSoft },
    { label: 'Petrol avoided', value: `− ${money(e.petrolAvoided)}`, note: 'fuel you no longer buy', color: C.gain, bg: C.gainSoft },
    { label: 'Net saving', value: money(e.netSaving), note: 'per year vs petrol', color: C.gain, bg: C.gainSoft },
  ]);
  figureRow(c, 'Annual distance', `${e.km.toLocaleString('en-IE')} km`);
  figureRow(c, 'Fuel price assumed', `€${e.fuelPrice.toFixed(2)}/L`);
  figureRow(c, 'Assumed efficiency', `${e.efficiency} kWh / 100 km`);
}

function switching(c: Canvas, d: ReportData) {
  sectionHeader(c, 'How to switch', 'Next steps', C.gain, 40);
  c.paragraph(
    'Switching takes about ten minutes and 10–15 working days to complete. Your supply is never interrupted and the new supplier handles the changeover.',
    { size: T.dense, color: C.inkSoft, leading: 3.8 },
  );
  c.y += 4;
  d.switchSteps.forEach((s, i) => step(c, i + 1, s.title, s.body));
}

function methodology(c: Canvas, d: ReportData) {
  sectionHeader(c, 'How these numbers were produced', 'Methodology');
  d.methodology.forEach((m) => figureRow(c, m.label, m.value, { bold: false }));

  c.y += 2;
  const discH = 22;
  c.reserve(discH + 4);
  const box = c.panel({ h: discH, bg: C.wash, border: C.rule, inset: 4.5 });
  c.text('IMPORTANT', box.inner.x, box.inner.y + 3, { size: T.label, bold: true, color: C.inkSoft });
  c.y = box.inner.y + 7;
  c.paragraph(
    'This report is an independent estimate for general information, not financial advice. Figures use modelled consumption and published tariff rates at the time of generation; your actual bills will differ. Confirm rates with the supplier before switching. SEAI grant eligibility is subject to SEAI terms — see seai.ie.',
    { x: box.inner.x, width: box.inner.w, size: T.micro, color: C.inkSoft, leading: 3 },
  );
  c.y = box.y + discH + 4;
}

/** Page furniture, applied to every page once the document is complete. */
function footers(c: Canvas, d: ReportData) {
  const total = c.doc.getNumberOfPages();
  for (let p = 1; p <= total; p += 1) {
    c.doc.setPage(p);
    c.stroke(C.rule).lineWidth(LW.hairline);
    c.doc.line(PAGE.margin, PAGE.height - 13, PAGE.width - PAGE.margin, PAGE.height - 13);
    const foot = ['Solar Optimiser', d.origin, 'Independent, not financial advice']
      .filter(Boolean).join('  ·  ');
    c.text(foot, PAGE.margin, PAGE.height - 9, { size: T.micro, color: C.inkDim });
    c.text(`${p} / ${total}`, PAGE.width - PAGE.margin, PAGE.height - 9,
      { size: T.micro, color: C.inkDim, align: 'right' });
  }
}

/** Render the whole report into an existing jsPDF document. */
export function renderReport(doc: PdfDoc, data: ReportData): void {
  const c = new Canvas(doc);
  const d: ReportData = { ...data, origin: data.origin || reportOrigin() };

  cover(c, d);
  planComparison(c, d);
  ranking(c, d);
  usage(c, d);
  solarSection(c, d);
  evSection(c, d);
  switching(c, d);
  methodology(c, d);
  footers(c, d);
}
