/**
 * The document.
 *
 * Structured as a report a person reads: a cover, contents, then chapters that
 * argue a case in prose supported by tables, closing with an appendix of the
 * full working. `ReportData` is plain data — nothing here reads a global, so
 * the whole document renders in a test.
 */

import { Doc, type PdfDoc } from './doc.js';
import {
  PAGE, TYPE, lines, LW, TEXT_LEFT, TEXT_RIGHT,
  INK, INK_MID, INK_SOFT, RULE, RULE_SOFT, TINT, PAPER,
  ACCENT, ACCENT_TINT, DEBIT, SERIES, SERIES_ALT, reportOrigin,
} from './theme.js';
import {
  chapter, heading, label, pullFigure, table, cellBar, definitions, callout,
  columnChart, rateProfile, cashFlow, splitBar, eur, kwh, signed, type Column,
} from './blocks.js';

export interface RankedPlan {
  name: string;
  supplier: string;
  cost: number;
  standing: number;
  type: string;
  /** Hourly unit rate across a day, euro/kWh. */
  dayProfile?: number[];
}

export interface ReportData {
  generatedAt: Date;
  origin: string;
  home: {
    annualKwh: number;
    heating: string;
    region: string;
    systemLabel: string;
    occupancyNote?: string;
  };
  usageByPeriod: { label: string; value: number }[];
  usageBasis: string;
  current: { name: string; annualCost: number; standing: number };
  best: {
    name: string; supplier: string; annualCost: number; standing: number;
    rates: { label: string; value: string }[];
    dayProfile?: number[];
  };
  savings: { total: number; unitRate: number; standing: number; exportIncome: number };
  ranked: RankedPlan[];
  /** Cost of the recommended and current plan under usage shocks. */
  sensitivity?: { label: string; best: number; current: number }[];
  solar?: {
    kwp: number; panels: string; battery: string; orientation: string;
    generated: number; selfConsumed: number; exported: number; gridImport: number;
    grossCost: number; grant: number; netCost: number;
    year1Saving: number; paybackYears: number | null; npv20: number;
    cumulative: number[]; breakevenYear: number | null; batteryReplacementYear?: number;
  };
  ev?: {
    electricityIncrease: number; petrolAvoided: number; netSaving: number;
    km: number; fuelPrice: number; efficiency: number;
  };
  switchSteps: { title: string; body: string }[];
  supplierUrl?: string;
  methodology: { term: string; value: string }[];
  tariffCount: number;
  verifiedDate: string | null;
}

const pctOf = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

/* ── front matter ────────────────────────────────────────────────────────── */

function cover(d: Doc, r: ReportData) {
  d.bareePages.add(1);
  const M = PAGE.marginInner;

  d.fill(INK);
  d.doc.rect(0, 0, PAGE.width, 4, 'F');

  d.text('SOLAR OPTIMISER', M, 30, { ...TYPE.subhead!, color: INK_MID, tracking: 1.4 });

  d.y = 58;
  d.text('Your electricity', M, d.y, TYPE.coverTitle!);
  d.y += lines(2.6);
  d.text('and solar report', M, d.y, TYPE.coverTitle!);
  d.y += lines(2.2);
  d.text('An independent assessment of what you pay now,', M, d.y, TYPE.coverSub!);
  d.y += lines(1.4);
  d.text('what you could pay, and what it would take to change.', M, d.y, TYPE.coverSub!);

  // Headline figure, given the whole width of the page to itself.
  d.y = 128;
  d.stroke(RULE).weight(LW.hair);
  d.doc.line(M, d.y, TEXT_RIGHT, d.y);
  d.y += lines(2.4);
  d.text('ANNUAL SAVING AVAILABLE', M, d.y, { ...TYPE.subhead!, color: ACCENT });
  d.y += lines(2.6);
  d.text(eur(r.savings.total), M, d.y, { ...TYPE.coverFigure!, color: ACCENT });
  d.y += lines(1.6);
  d.text(`by moving to ${r.best.name}`, M, d.y, { ...TYPE.body!, color: INK_MID, maxWidth: d.width });
  d.y += lines(1.8);
  d.stroke(RULE).weight(LW.hair);
  d.doc.line(M, d.y, TEXT_RIGHT, d.y);

  // Prepared-for block, foot of page.
  const rows: [string, string][] = [
    ['Prepared', r.generatedAt.toLocaleDateString('en-IE', { day: 'numeric', month: 'long', year: 'numeric' })],
    ['Consumption', `${r.home.annualKwh.toLocaleString('en-IE')} kWh per year · ${r.usageBasis}`],
    ['Home', `${r.home.heating} heating · ${r.home.region}`],
    ['System', r.home.systemLabel],
    ['Plans compared', `${r.tariffCount}${r.verifiedDate ? ` · rates verified ${r.verifiedDate}` : ''}`],
  ];
  d.y = 226;
  rows.forEach(([k, v]) => {
    d.text(k.toUpperCase(), M, d.y, { ...TYPE.micro!, color: INK_SOFT, tracking: 0.5 });
    d.text(v, M + 34, d.y, { ...TYPE.data!, maxWidth: d.width - 34 });
    d.y += lines(1.4);
  });

  d.newPage();
}

function contents(d: Doc, r: ReportData) {
  d.bareePages.add(d.page);
  d.y = PAGE.marginTop + lines(2);
  d.text('Contents', d.left, d.y, TYPE.chapter!);
  d.y += lines(1);
  d.rule(INK, LW.heavy, d.left, d.left + 22);
  d.y += lines(2.4);
  // Filled in by finish(); a placeholder position is recorded here.
  d.contentsAnchor = { page: d.page, y: d.y };

  // The short version, so page two already answers the question.
  d.y = 150;
  d.text('The short version', d.left, d.y, TYPE.heading!);
  d.y += lines(1.6);

  const pts: string[] = [];
  pts.push(
    r.savings.total > 1
      ? `You are on ${r.current.name}, costing about ${eur(r.current.annualCost)} a year on your usage. ${r.best.name} would cost ${eur(r.best.annualCost)} — a saving of ${eur(r.savings.total)}.`
      : `You are already on ${r.current.name}, and nothing in the ${r.tariffCount} plans compared beats it on your usage. No action is needed.`,
  );
  if (r.solar) {
    pts.push(
      r.solar.paybackYears
        ? `Your ${r.solar.kwp.toFixed(1)} kWp system generates about ${kwh(r.solar.generated)} a year, of which ${pctOf(r.solar.selfConsumed, r.solar.generated)}% is used in the house. It pays back in ${r.solar.paybackYears.toFixed(1)} years and is worth ${eur(r.solar.npv20)} over twenty.`
        : `Your ${r.solar.kwp.toFixed(1)} kWp system generates about ${kwh(r.solar.generated)} a year. On current rates it does not pay back inside twenty years.`,
    );
  }
  if (r.ev) {
    pts.push(`Running the car on electricity rather than petrol saves about ${eur(r.ev.netSaving)} a year — separate from, and larger than, the tariff saving.`);
  }
  pts.push('Switching takes about ten minutes and completes in 10–15 working days. Your supply is not interrupted.');

  pts.forEach((p, i) => {
    d.ensure(lines(3));
    d.text(String(i + 1), d.left, d.y, { ...TYPE.microBold!, color: ACCENT });
    d.paragraph(p, TYPE.body!, { x: d.left + 6, width: d.width - 6 });
    d.skip(0.5);
  });

  d.newPage();
}

/* ── chapters ────────────────────────────────────────────────────────────── */

function chUsage(d: Doc, r: ReportData) {
  chapter(d, 'One', 'What you use',
    `Everything in this report rests on how much electricity you use and when. ${r.usageBasis}.`);

  columnChart(d, r.usageByPeriod, {
    color: SERIES,
    caption: 'Consumption by billing period, kWh. Irish bills run in six two-month periods.',
  });

  definitions(d, [
    { term: 'Total annual consumption', value: kwh(r.home.annualKwh) },
    { term: 'Average per billing period', value: kwh(r.home.annualKwh / 6) },
    { term: 'Heating', value: r.home.heating, note: 'Heating type sets how much load falls in the evening and overnight.' },
    { term: 'Region', value: r.home.region },
  ]);

  callout(d, 'Why this matters',
    'Two homes using the same annual total can pay very different amounts, because tariffs price each hour differently. A plan with a cheap night rate only helps if you actually use electricity at night. Every figure in this report is produced by pricing your usage hour by hour rather than multiplying an average.');
}

function chComparison(d: Doc, r: ReportData) {
  const saved = r.savings.total > 1;
  chapter(d, 'Two', 'What you could pay',
    saved
      ? `Every one of the ${r.tariffCount} plans available was simulated against your consumption across all 8,760 hours of a year. The cheapest for your usage is ${r.best.name}.`
      : `Every one of the ${r.tariffCount} plans available was simulated against your consumption. None beats what you are on.`);

  // The recommendation, side by side with what it replaces.
  const half = (d.width - 6) / 2;
  const top = d.y;
  d.text('YOU ARE ON', d.left, d.y, { ...TYPE.subhead!, color: DEBIT });
  d.y += lines(1.3);
  d.text(r.current.name, d.left, d.y, { ...TYPE.data!, maxWidth: half });
  d.y += lines(1.3);
  d.text(`${eur(r.current.annualCost)}/yr`, d.left, d.y, { ...TYPE.figureSmall!, color: DEBIT });

  const rx = d.left + half + 6;
  d.y = top;
  d.text('RECOMMENDED', rx, d.y, { ...TYPE.subhead!, color: ACCENT });
  d.y += lines(1.3);
  d.text(r.best.name, rx, d.y, { ...TYPE.data!, maxWidth: half });
  d.y += lines(1.3);
  d.text(`${eur(r.best.annualCost)}/yr`, rx, d.y, { ...TYPE.figureSmall!, color: ACCENT });
  d.y += lines(2);
  d.rule(RULE_SOFT, LW.hair);
  d.y += lines(1.4);

  if (saved) {
    heading(d, 'Where the difference comes from');
    d.paragraph(
      'Both figures are on the same basis — electricity used, plus the standing charge, minus any export income. The three lines below account for the whole difference between the two plans.',
      TYPE.body!);
    d.skip(0.6);

    const levers = [
      { term: 'Unit rates on the electricity you use', v: r.savings.unitRate },
      { term: 'Standing charge', v: r.savings.standing },
      { term: 'Export income', v: r.savings.exportIncome },
    ].filter((l) => Math.abs(l.v) > 0.5);
    definitions(d, levers.map((l) => ({ term: l.term, value: `${signed(l.v)}/yr` })));
    d.rule(INK, LW.rule);
    d.y += lines(1.3);
    d.text('Net annual saving', d.left, d.y, { ...TYPE.body!, style: 'bold' });
    d.text(`${eur(r.savings.total)}/yr`, d.right, d.y, { ...TYPE.dataBold!, color: ACCENT, align: 'right' });
    d.y += lines(1.6);
  }

  // Hour-of-day rate profile — the mechanism, not just the outcome.
  const cur = r.ranked.find((p) => p.dayProfile && p.name === r.current.name);
  if (r.best.dayProfile) {
    heading(d, 'How the two plans price a day');
    rateProfile(d, [
      { name: r.best.supplier, color: ACCENT, rates: r.best.dayProfile },
      ...(cur?.dayProfile ? [{ name: 'Your current plan', color: DEBIT, rates: cur.dayProfile }] : []),
    ], { caption: 'Unit rate by hour, cents per kWh, excluding the standing charge.' });
  }

  label(d, 'Rates on the recommended plan');
  const cw = d.width / Math.max(1, r.best.rates.length);
  r.best.rates.forEach((rt, i) => {
    const x = d.left + i * cw;
    d.text(rt.label.toUpperCase(), x, d.y, { ...TYPE.micro!, maxWidth: cw - 3 });
    d.text(rt.value, x, d.y + lines(1.2), { ...TYPE.dataBold!, maxWidth: cw - 3 });
  });
  d.y += lines(2.6);

  if (r.sensitivity?.length) {
    heading(d, 'If your usage is not quite what we assumed');
    d.paragraph(
      'Consumption estimated from a bill carries real uncertainty. The recommendation holds across a wide band either side of the figure used here.',
      TYPE.body!);
    d.skip(0.5);
    const cols: Column[] = [
      { head: 'Scenario', width: 0, cell: (row: never) => (row as { label: string }).label },
      { head: 'Recommended', width: 30, align: 'right', cell: (row: never) => eur((row as { best: number }).best) },
      { head: 'Current plan', width: 30, align: 'right', cell: (row: never) => eur((row as { current: number }).current) },
      {
        head: 'Saving', width: 28, align: 'right',
        cell: (row: never) => {
          const x = row as { best: number; current: number };
          return eur(Math.max(0, x.current - x.best));
        },
        color: () => ACCENT,
        bold: () => true,
      },
    ];
    table(d, r.sensitivity, cols, {
      note: 'Annual cost under each scenario, all other assumptions unchanged.',
    });
  }
}

function chSolar(d: Doc, r: ReportData) {
  const s = r.solar;
  if (!s) return;
  chapter(d, 'Three', 'Your solar and battery',
    `A ${s.kwp.toFixed(2)} kWp array — ${s.panels}, ${s.orientation} — with ${s.battery}.`);

  heading(d, 'Where the generation goes');
  splitBar(d, [
    { label: 'Used in the house', value: s.selfConsumed, color: ACCENT },
    { label: 'Exported to the grid', value: s.exported, color: SERIES_ALT },
  ], { caption: `Of ${kwh(s.generated)} generated a year. You still import ${kwh(s.gridImport)} from the grid.` });

  d.paragraph(
    `Electricity you use yourself is worth the full unit rate you would otherwise have paid. Electricity you export earns only the export rate, which is lower. That is why self-consumption — currently ${pctOf(s.selfConsumed, s.generated)}% of what you generate — matters more to the return than the size of the array.`,
    TYPE.body!);
  d.skip(0.8);

  heading(d, 'What it cost and what it returns');
  definitions(d, [
    { term: 'Gross installation cost', value: eur(s.grossCost) },
    { term: 'SEAI grant', value: `- ${eur(s.grant)}` },
    { term: 'Net cost after grant', value: eur(s.netCost) },
    { term: 'Electricity saved, first year', value: `${eur(s.year1Saving)}/yr` },
    { term: 'Simple payback', value: s.paybackYears ? `${s.paybackYears.toFixed(1)} years` : 'beyond 20 years' },
    { term: 'Net present value over 20 years', value: eur(s.npv20), note: 'Future savings discounted at 3% a year, panel output falling 0.5% a year.' },
  ]);

  heading(d, 'The twenty-year position', lines(14));
  cashFlow(d, s.cumulative, {
    breakeven: s.breakevenYear,
    dip: s.batteryReplacementYear,
    caption: `Cumulative position after the up-front cost. Below the line the system is still paying itself back; above it, you are ahead.${s.breakevenYear ? ` It crosses in year ${s.breakevenYear}.` : ''}`,
  });

  callout(d, 'What would change this',
    'The return is driven by the unit rate you avoid paying. If electricity gets dearer, solar pays back faster; if it gets cheaper, slower. Shifting flexible loads — immersion, dishwasher, car charging — into daylight hours raises self-consumption and is the single cheapest way to improve the figure above.');
}

function chTransport(d: Doc, r: ReportData) {
  const e = r.ev;
  if (!e) return;
  chapter(d, r.solar ? 'Four' : 'Three', 'Running the car',
    `Charging at home instead of buying petrol, over ${e.km.toLocaleString('en-IE')} km a year.`);

  definitions(d, [
    { term: 'Extra electricity to charge the car', value: `${signed(-e.electricityIncrease)}/yr` },
    { term: 'Petrol no longer bought', value: `${signed(e.petrolAvoided)}/yr`, note: `At €${e.fuelPrice.toFixed(2)} per litre.` },
    { term: 'Net saving on transport', value: `${eur(e.netSaving)}/yr` },
    { term: 'Assumed efficiency', value: `${e.efficiency} kWh per 100 km` },
  ]);

  d.paragraph(
    'This is a transport saving, not an electricity saving — it appears nowhere in the tariff comparison, which comes earlier in this report. The two add together.',
    TYPE.caption!);
  d.skip(0.8);
}

function chAct(d: Doc, r: ReportData) {
  const n = r.solar && r.ev ? 'Five' : r.solar || r.ev ? 'Four' : 'Three';
  chapter(d, n, 'Acting on this',
    'Switching supplier in Ireland is a short online process. Your supply is never interrupted and nobody visits the property.');

  r.switchSteps.forEach((s, i) => {
    d.ensure(lines(4));
    d.text(String(i + 1).padStart(2, '0'), d.left, d.y, { ...TYPE.microBold!, color: ACCENT });
    d.text(s.title, d.left + 8, d.y, { ...TYPE.body!, style: 'bold', maxWidth: d.width - 8 });
    d.y += lines(1.15);
    d.paragraph(s.body, TYPE.caption!, { x: d.left + 8, width: d.width - 8 });
    d.skip(0.5);
  });

  if (r.supplierUrl) {
    d.skip(0.5);
    const t = `Go to ${r.best.supplier}`;
    const w = d.text(t, d.left, d.y, { ...TYPE.body!, style: 'bold', color: ACCENT });
    d.link(d.left, d.y, w, 4, r.supplierUrl);
    d.y += lines(1.4);
  }

  callout(d, 'Before you sign',
    'Confirm the unit rates and standing charge on the supplier’s own site. Rates change, and this report is a snapshot. Check any exit fee on your current contract, and if you have solar, ask to be registered for the Clean Export Guarantee at the same time — it is not always automatic.',
    DEBIT);
}

function chMethod(d: Doc, r: ReportData) {
  const n = r.solar && r.ev ? 'Six' : r.solar || r.ev ? 'Five' : 'Four';
  chapter(d, n, 'Method and assumptions',
    'Every figure in this report can be traced to an input. Those inputs are listed here so you can judge how much weight to put on the result.');

  definitions(d, r.methodology.map((m) => ({ term: m.term, value: m.value })));

  d.skip(0.6);
  callout(d, 'Important',
    'This is an independent estimate for general information, not financial advice. It uses modelled consumption and published tariff rates at the time of generation; your actual bills will differ. Verify rates with the supplier before switching. SEAI grant eligibility is subject to SEAI’s own terms and conditions.');
}

function appendix(d: Doc, r: ReportData) {
  d.newPage();
  chapter(d, 'Appendix', 'Every plan, ranked',
    `All ${r.ranked.length} plans priced against your consumption. Cost is what you would pay in a year, including the standing charge and net of any export income.`);

  const worst = Math.max(...r.ranked.map((p) => p.cost));
  const best = Math.min(...r.ranked.map((p) => p.cost));
  const spread = Math.max(1, worst - best);

  const cols: Column[] = [
    { head: '#', width: 8, cell: (_row: never, _d, _x, _w) => '' },
    { head: 'Supplier and plan', width: 0, cell: (row: never) => (row as RankedPlan).name },
    { head: 'Type', width: 20, cell: (row: never) => (row as RankedPlan).type },
    {
      head: 'vs dearest', width: 26,
      cell: (row: never, dd, x, w) => {
        cellBar(dd, x, w, (worst - (row as RankedPlan).cost) / spread, ACCENT);
        return '';
      },
    },
    { head: 'Standing', width: 22, align: 'right', cell: (row: never) => eur((row as RankedPlan).standing) },
    { head: 'Annual cost', width: 26, align: 'right', cell: (row: never) => eur((row as RankedPlan).cost), bold: () => true },
  ];

  // Rank numbers are drawn by index, which the column API does not see.
  let i = 0;
  const numbered = r.ranked.map((p) => ({ ...p, _n: (i += 1) }));
  cols[0]!.cell = (row: never) => String((row as { _n: number })._n);

  table(d, numbered, cols, {
    emphasise: (row) => (row as { _n: number })._n === 1,
    note: 'Dynamic wholesale-tracking plans are excluded from the ranking unless enabled in the app, because their real cost depends on market movements that cannot be forecast.',
  });
}

/* ── entry ───────────────────────────────────────────────────────────────── */

export function renderReport(pdf: PdfDoc, data: ReportData): void {
  const d = new Doc(pdf);
  const r: ReportData = { ...data, origin: data.origin || reportOrigin() };

  cover(d, r);
  contents(d, r);
  chUsage(d, r);
  chComparison(d, r);
  chSolar(d, r);
  chTransport(d, r);
  chAct(d, r);
  chMethod(d, r);
  appendix(d, r);

  d.finish({
    title: `Electricity and solar report — ${r.generatedAt.toLocaleDateString('en-IE')}`,
    subject: `Tariff comparison across ${r.tariffCount} Irish plans, with solar and battery analysis`,
    origin: r.origin,
  });
}
