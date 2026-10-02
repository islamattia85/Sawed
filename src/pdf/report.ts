/**
 * The document.
 *
 * Structured as a report a person reads: a cover, contents, then chapters that
 * argue a case in prose supported by tables, closing with an appendix of the
 * full working. `ReportData` is plain data — nothing here reads a global, so
 * the whole document renders in a test.
 */

import { BRAND } from '../brand';
import { Doc, type PdfDoc } from './doc.js';
import {
  PAGE, TYPE, lines, LW, TEXT_LEFT, TEXT_RIGHT,
  INK, INK_MID, INK_SOFT, RULE, RULE_SOFT, TINT, PAPER,
  ACCENT, ACCENT_TINT, DEBIT, SERIES, SERIES_ALT, reportOrigin,
} from './theme.js';
import {
  chapter, heading, label, pullFigure, table, cellBar, definitions, callout,
  columnChart, rateProfile, cashFlow, splitBar, eur, kwh, signed, type Column,
  monthlyEnergyChart, dayChart, dayChartLegend, barBreakdown, houseScene,
} from './blocks.js';
import {
  NAVY, NAVY_2, GOLD, GREEN, CARD, NIGHT, DAY, PEAK, MADE, KEPT, FIXED, BAND_COLOR, BAND_NAME,
  box, finding, tiles, hbars, stack, columns, heatmap, meter, diverging,
} from './viz.js';

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
  current: { name: string; annualCost: number; standing: number; bands?: string[] };
  best: {
    name: string; supplier: string; annualCost: number; standing: number;
    rates: { label: string; value: string }[];
    dayProfile?: number[];
    bands?: string[];
  };
  savings: { total: number; unitRate: number; standing: number; exportIncome: number };
  /**
   * Present when the reader picked `best` themselves rather than taking the
   * cheapest. The report then reports their decision and prices it, instead of
   * passing the choice off as our recommendation.
   */
  choice?: {
    rank: number | null;
    premium: number;
    cheapestName: string;
    cheapestCost: number;
  };
  ranked: RankedPlan[];
  /** Cost of the recommended and current plan under usage shocks. */
  sensitivity?: { label: string; best: number; current: number }[];
  solar?: {
    kwp: number; panels: string; battery: string; orientation: string;
    generated: number; selfConsumed: number; exported: number; gridImport: number;
    grossCost: number; grant: number; netCost: number;
    year1Saving: number; paybackYears: number | null; npv20: number;
    cumulative: number[]; breakevenYear: number | null; batteryReplacementYear?: number;
    /** Array size, for the illustration. */
    panelCount?: number;
    batteryKwh?: number;
  };
  ev?: {
    electricityIncrease: number; petrolAvoided: number; netSaving: number;
    km: number; fuelPrice: number; efficiency: number;
  };
  /** Month-by-month energy and money, from the hourly simulation. */
  months?: {
    month: string; generated: number; consumed: number; selfUsed: number;
    imported: number; exported: number; cost: number; revenue: number;
    selfSufficiency: number; selfConsumption: number;
  }[];
  /** Representative days across the seasons. */
  days?: {
    label: string; generation: number[]; consumption: number[];
    gridImport: number[]; gridExport: number[]; soc: number[];
    peakGeneration: number; peakConsumption: number;
    totalImported: number; totalExported: number;
  }[];
  /** Import cost split by tariff band. */
  bands?: { band: string; kwh: number; cost: number; hours: number; effectiveRate: number }[];
  /** How hard the battery works across the year. */
  battery?: {
    capacity: number; charged: number; discharged: number; equivalentCycles: number;
    roundTripEfficiency: number; hoursFull: number; hoursEmpty: number; idleShare: number;
  } | null;
  /** Year-level ratios. */
  year?: {
    selfSufficiency: number; selfConsumption: number; specificYield: number;
    bestMonth: string; worstMonth: string; seasonalSwing: number;
  };
  /** Share of the annual bill falling in the dearest 10% of hours. */
  peakConcentration?: number;
  /** Export price and the cheapest price the plan lets you buy at, euro/kWh. */
  arbitrage?: { exportRate: number; cheapestImport: number; cheapestBand: string };
  /** Levers the reader can pull, and what each is worth. */
  levers?: { label: string; effect: string; value: number; note?: string }[];
  /** The comparison Home leads with: each plan, without and with the panels. */
  ladder?: { label: string; plan: string; value: number; solar: boolean; best?: boolean }[];
  /** How sure the figures are, and what is assumed. */
  accuracy?: { pct: number; withMeter: number | null; parts: { label: string; err: number; open: boolean; tip: string }[] };
  /** Every hour of the year on the plan reported, for the heat map and the average day. */
  hours?: { use: number[]; avg: number[]; dayCost: number[]; gen: number[] | null };
  switchSteps: { title: string; body: string }[];
  supplierUrl?: string;
  methodology: { term: string; value: string }[];
  tariffCount: number;
  verifiedDate: string | null;
}

const pctOf = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

/**
 * How to name the plan every figure is computed on. It is our recommendation
 * only when the reader did not override it.
 */
const planWord = (r: ReportData) => (r.choice ? 'your chosen plan' : 'the recommended plan');
const planLabel = (r: ReportData) => (r.choice ? 'YOUR CHOICE' : 'RECOMMENDED');

/* ── front matter ────────────────────────────────────────────────────────── */

const DATE = (r: ReportData) => r.generatedAt.toLocaleDateString('en-IE', { day: 'numeric', month: 'long', year: 'numeric' });
const W = (txt: string, size: number, style: 'normal' | 'bold' = 'normal', color: readonly [number, number, number] = PAPER) =>
  ({ face: 'helvetica' as const, style, size, color });

/** The brand mark: the dotted peak and the flat gold line under it. */
function mark(d: Doc, x: number, y: number, s: number) {
  box(d, x, y, s, s, NAVY_2, s * 0.22);
  d.stroke([143, 176, 184]).weight(0.35);
  const pts = 14;
  for (let i = 0; i < pts; i += 2) {
    const t0 = i / pts, t1 = (i + 1) / pts;
    const yy = (t: number) => y + s * (0.66 - 0.36 * Math.sin(Math.PI * t));
    d.doc.line(x + s * (0.12 + 0.76 * t0), yy(t0), x + s * (0.12 + 0.76 * t1), yy(t1));
  }
  d.stroke(GOLD).weight(0.9);
  d.doc.line(x + s * 0.12, y + s * 0.68, x + s * 0.88, y + s * 0.68);
}

function cover(d: Doc, r: ReportData) {
  d.bareePages.add(1);
  const M = 20;
  box(d, 0, 0, PAGE.width, PAGE.height, NAVY);
  mark(d, M, 20, 12);
  d.text('peakless', M + 16, 28.6, W('peakless', 15, 'bold'));
  d.text(DATE(r), PAGE.width - M, 28.6, { ...W('', 8.5), color: [170, 190, 196], align: 'right' });

  d.text('Your home', M, 62, W('', 30, 'bold'));
  d.text('energy report', M, 74, W('', 30, 'bold'));
  d.text(`${r.home.annualKwh.toLocaleString('en-IE')} kWh a year · ${r.home.heating} heating · ${r.home.region}`, M, 84, { ...W('', 10), color: [190, 208, 212] });

  const saving = r.ladder && r.ladder.length ? r.ladder[0]!.value - Math.min(...r.ladder.map((x) => x.value)) : r.savings.total;
  d.text(r.choice ? 'ON YOUR CHOSEN PLAN' : 'THE MOST YOU COULD SAVE', M, 112, { ...W('', 8, 'bold'), color: GOLD, tracking: 0.8 });
  d.text(eur(Math.max(0, saving)), M, 134, { ...W('', 52, 'bold'), color: saving > 1 ? [118, 222, 165] : PAPER });
  d.text(saving > 1 ? 'less a year' : 'a year, already on the best value', M, 143, { ...W('', 11), color: [190, 208, 212] });
  const how = r.ladder && r.ladder.some((x) => x.solar && x.best) && r.ladder.length > 3
    ? `By switching to ${r.ladder.find((x) => x.best)!.plan} and adding the planned panels.`
    : `By moving to ${r.best.name}.`;
  d.y = 153;
  d.paragraph(how, { ...W('', 10), color: PAPER, leading: 4.8 }, { x: M, width: PAGE.width - 2 * M });

  // Four figures, the app's tiles.
  const L = r.ladder || [];
  const now = L[0]?.value ?? r.current.annualCost;
  const kp: { k: string; v: string; sub?: string; tone?: readonly [number, number, number] }[] = [
    { k: 'YOU PAY NOW', v: eur(now), sub: 'a year, as billed' },
    { k: r.choice ? 'YOUR CHOICE' : 'BEST PLAN', v: eur(r.best.annualCost), sub: r.best.supplier, tone: [118, 222, 165] },
    r.solar ? { k: 'SOLAR PAYS BACK', v: r.solar.paybackYears ? `${r.solar.paybackYears.toFixed(1)} yrs` : '20+ yrs', sub: `${r.solar.kwp.toFixed(1)} kWp, after grant` }
      : { k: 'PLANS COMPARED', v: String(r.tariffCount), sub: 'every hour of the year' },
    { k: 'ACCURACY', v: r.accuracy ? `±${r.accuracy.pct}%` : '8,760 h', sub: r.accuracy ? 'yearly figures' : 'modelled' },
  ];
  const save = { left: d.left, y: d.y };
  d.y = 176;
  const gap = 3, w = (PAGE.width - 2 * M - 3 * gap) / 4, h = 26;
  kp.forEach((t, i) => {
    const x = M + i * (w + gap);
    box(d, x, d.y, w, h, NAVY_2, 3);
    d.text(t.k, x + 4, d.y + 6.5, { ...W('', 6.6, 'bold'), color: [170, 190, 196], maxWidth: w - 8 });
    d.text(t.v, x + 4, d.y + 15.5, { ...W('', 15, 'bold'), color: (t.tone as never) ?? PAPER, maxWidth: w - 8 });
    if (t.sub) d.text(t.sub, x + 4, d.y + 21.5, { ...W('', 6.6), color: [170, 190, 196], maxWidth: w - 8 });
  });
  void save;

  const rows: [string, string][] = [
    ['Prepared', DATE(r)],
    ['Usage', r.usageBasis],
    ['System', r.home.systemLabel],
    ['Plans compared', `${r.tariffCount}${r.verifiedDate ? ` · rates verified ${r.verifiedDate}` : ''}`],
  ];
  let y = 226;
  rows.forEach(([k, v]) => {
    d.text(k.toUpperCase(), M, y, { ...W('', 6.6, 'bold'), color: [140, 165, 172], tracking: 0.5 });
    d.text(v, M + 34, y, { ...W('', 8.4), color: PAPER, maxWidth: PAGE.width - 2 * M - 34 });
    y += 6.4;
  });
  d.text('Independent: no supplier pays to be ranked. Not financial advice.', M, 278, { ...W('', 7), color: [140, 165, 172] });
  d.newPage();
}

/** Page two: the whole answer at a glance, then the contents. */
function contents(d: Doc, r: ReportData) {
  d.bareePages.add(d.page);
  d.y = PAGE.marginTop + 2;
  d.text('At a glance', d.left, d.y, TYPE.chapter!);
  d.y += lines(1.6);

  if (r.ladder && r.ladder.length) {
    const L = r.ladder;
    finding(d, L.length > 3 ? 'What you would pay a year: your plan and the best, without and with the panels' : 'What you would pay a year, on your plan and the best one');
    hbars(d, L.map((x) => ({ label: `${x.label}${x.solar ? '  (panels)' : ''}`, sub: x.plan, value: x.value, text: eur(x.value),
      color: x.best ? GREEN : x.label.startsWith('Current') && !x.solar ? DAY : [141, 195, 166], bold: !!x.best })), { barH: 3 });
  }

  const pts: string[] = [];
  const L = r.ladder || [];
  if (L.length > 3) {
    pts.push(`Switch today to ${L[1]!.plan}: ${eur(L[0]!.value - L[1]!.value)} a year less, with nothing to buy.`);
    pts.push(`Add the planned panels: ${eur(L[1]!.value - L[3]!.value)} a year more off, on ${L[3]!.plan}.`);
  } else if (r.savings.total > 1) pts.push(`Switch to ${r.best.name}: ${eur(r.savings.total)} a year less than now.`);
  else pts.push(`You are already on the best value of ${r.tariffCount} plans for your home.`);
  if (r.choice) pts.push(`${r.best.name} is your own choice, ranked ${r.choice.rank ?? '-'}; it costs ${eur(r.choice.premium)} a year more than ${r.choice.cheapestName}.`);
  if (r.ev) pts.push(`The car: ${eur(r.ev.electricityIncrease)} a year to charge, ${eur(r.ev.netSaving)} less than petrol.`);
  if (r.accuracy) pts.push(`Figures within ±${r.accuracy.pct}%${r.accuracy.withMeter ? `; your smart-meter file would tighten that to ±${r.accuracy.withMeter}%` : ''}.`);
  finding(d, 'What to do');
  pts.forEach((p, i) => {
    d.ensure(lines(2));
    box(d, d.left, d.y - 3.2, 4.4, 4.4, GREEN, 2.2);
    d.text(String(i + 1), d.left + 2.2, d.y, { face: 'helvetica', style: 'bold', size: 7, color: PAPER, align: 'center' });
    d.paragraph(p, TYPE.body!, { x: d.left + 7, width: d.width - 7 });
    d.y += 1.2;
  });

  d.skip(1);
  d.text('Contents', d.left, d.y, TYPE.heading!);
  d.y += lines(1.4);
  d.contentsAnchor = { page: d.page, y: d.y };
  d.newPage();
}

/** Your year, hour by hour: the heat map and the average day. */
function chHours(d: Doc, r: ReportData) {
  if (!r.hours) return;
  const H = r.hours;
  d.newPage();
  chapter(d, 'Hours', 'Your year, hour by hour',
    'Every one of the 8,760 hours in the year, as the simulation ran them. Darker means more electricity used.');
  const M = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DIM = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const dname = (i: number) => { let m = 0; let x = i; while (x >= DIM[m]!) { x -= DIM[m]!; m += 1; } return `${x + 1} ${M[m]}`; };
  const top = H.avg.indexOf(Math.max(...H.avg));
  finding(d, `The busiest hours fall around ${String(top).padStart(2, '0')}:00, and winter is the heaviest season`);
  heatmap(d, H.use);

  const bands = r.best.bands || Array.from({ length: 24 }, () => 'day');
  const tot = H.avg.reduce((a, b) => a + b, 0) || 1;
  const share: Record<string, number> = {};
  H.avg.forEach((v, h) => { share[bands[h]!] = (share[bands[h]!] || 0) + v; });
  const cheap = ['ev', 'night'].reduce((a, b) => a + (share[b] || 0), 0);
  finding(d, `An average day on ${r.best.supplier}: ${Math.round((cheap / tot) * 100)}% of use falls in its cheap hours`,
    'Each bar is one hour, coloured by the rate that hour is billed at.');
  columns(d, H.avg, H.avg.map((_, h) => BAND_COLOR[bands[h]!] || DAY), { h: 32, labels: H.avg.map((_, h) => String(h).padStart(2, '0')), every: 3 });
  const present = [...new Set(bands)];
  let lx = d.left;
  present.forEach((b) => {
    box(d, lx, d.y - 2.4, 2.6, 2.6, BAND_COLOR[b] || DAY, 0.6);
    lx += 4 + d.text(`${BAND_NAME[b] || b}  ${Math.round(((share[b] || 0) / tot) * 100)}%`, lx + 4, d.y, { face: 'helvetica', style: 'normal', size: 7, color: INK_MID }) + 6;
  });
  d.y += 6;

  if (H.dayCost.length >= 365) {
    let hi = 0, lo = 0;
    H.dayCost.forEach((v, i) => { if (v > H.dayCost[hi]!) hi = i; if (v < H.dayCost[lo]!) lo = i; });
    finding(d, 'The dearest and the cheapest day of the year');
    tiles(d, [
      { k: 'DEAREST DAY', v: `€${H.dayCost[hi]!.toFixed(2)}`, sub: dname(hi), tone: PEAK },
      { k: 'CHEAPEST DAY', v: H.dayCost[lo]! < 0 ? `+€${(-H.dayCost[lo]!).toFixed(2)}` : `€${H.dayCost[lo]!.toFixed(2)}`, sub: `${dname(lo)}${H.dayCost[lo]! < 0 ? ', earned' : ''}`, tone: GREEN },
      { k: 'AVERAGE DAY', v: `€${(H.dayCost.reduce((a, b) => a + b, 0) / 365).toFixed(2)}`, sub: `${(tot).toFixed(1)} kWh used` },
    ]);
  }
}

/** How sure the figures are: one meter and its parts. */
function chAccuracy(d: Doc, r: ReportData) {
  if (!r.accuracy) return;
  const a = r.accuracy;
  finding(d, `Yearly figures are within ±${a.pct}% either way`,
    a.withMeter ? `The biggest unknown is your usage. Your ESB smart-meter file would bring it to ±${a.withMeter}%.` : 'Built on your real meter readings: only the weather and the system specs are left to vary.');
  meter(d, Math.max(0.08, Math.min(1, 1 - (a.pct - 2) * 0.06)));
  hbars(d, a.parts.slice().sort((x, y) => y.err - x.err).map((p) => ({
    label: p.label, sub: p.open ? `To tighten: ${p.tip}` : (/confirmed|meter/i.test(p.label) ? 'Measured or confirmed' : 'Always present'),
    value: p.err, text: `±${p.err}%`, color: p.open ? MADE : GREEN })), { barH: 2.6 });
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
    r.choice
      ? `Every one of the ${r.tariffCount} plans available was simulated against your consumption across all 8,760 hours of a year. You have chosen to go with ${r.best.name}, and the rest of this report is built on that plan.`
      : saved
        ? `Every one of the ${r.tariffCount} plans available was simulated against your consumption across all 8,760 hours of a year. The cheapest for your usage is ${r.best.name}.`
        : `Every one of the ${r.tariffCount} plans available was simulated against your consumption. None beats what you are on.`);

  if (r.choice) {
    callout(d, 'What your choice costs',
      r.choice.premium > 1
        ? `On price alone the ranking puts ${r.choice.cheapestName} first, at ${eur(r.choice.cheapestCost)} a year. ${r.best.name} ranks ${r.choice.rank} and costs ${eur(r.best.annualCost)} — ${eur(r.choice.premium)} a year more, or about ${eur(r.choice.premium / 12, 2)} a month. That is the price of the choice, and it is a legitimate one to make: contract length, exit fees, service record and green supply are all real considerations this model does not price. Everything that follows uses your plan, not the cheapest one.`
        : `${r.best.name} is not the top of the ranking, but on your usage it costs effectively the same as ${r.choice.cheapestName}. Everything that follows uses your plan.`);
  }

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
  d.text(planLabel(r), rx, d.y, { ...TYPE.subhead!, color: ACCENT });
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

  label(d, `Rates on ${planWord(r)}`);
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
      r.choice
        ? 'Consumption estimated from a bill carries real uncertainty. The comparison below holds across a wide band either side of the figure used here.'
        : 'Consumption estimated from a bill carries real uncertainty. The recommendation holds across a wide band either side of the figure used here.',
      TYPE.body!);
    d.skip(0.5);
    const cols: Column[] = [
      { head: 'Scenario', width: 0, cell: (row: never) => (row as { label: string }).label },
      { head: r.choice ? 'Your plan' : 'Recommended', width: 30, align: 'right', cell: (row: never) => eur((row as { best: number }).best) },
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

  houseScene(d, {
    generated: s.generated,
    selfConsumed: s.selfConsumed,
    exported: s.exported,
    gridImport: s.gridImport,
    panelCount: s.panelCount ?? 0,
    batteryKwh: s.batteryKwh ?? 0,
  }, {
    caption: `Your system and its four annual flows.${
      s.panelCount && s.panelCount > 8 ? ` The roof is drawn with eight panels; yours has ${s.panelCount}.` : ''
    } Every figure is from the same 8,760-hour simulation used throughout this report.`,
  });

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

  chAccuracy(d, r);
  heading(d, 'What the model assumes');
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


/* ── the year in detail ──────────────────────────────────────────────────── */

function chYear(d: Doc, r: ReportData) {
  if (!r.months?.length) return;
  const y = r.year;
  chapter(d, 'Performance', 'Your year, month by month',
    'A solar system in Ireland does not deliver evenly. These are the twelve months as the simulation produced them, hour by hour, on your own consumption.');

  monthlyEnergyChart(d, r.months, {
    caption: 'Generation against household consumption, kWh per month. Where the dark column falls short of the pale one, the shortfall came from the grid.',
  });

  if (y) {
    d.paragraph(
      `${y.bestMonth} is your strongest month and ${y.worstMonth} your weakest, a swing of about ${y.seasonalSwing.toFixed(1)}:1. That range is normal at this latitude and it is the reason a system sized for winter would be absurdly oversized for summer. Across the year the array returns ${Math.round(y.specificYield)} kWh for every kWp installed.`,
      TYPE.body!);
    d.skip(0.6);
  }

  const cols: Column[] = [
    { head: 'Month', width: 16, cell: (row: never) => (row as { month: string }).month },
    { head: 'Generated', width: 0, align: 'right', cell: (row: never) => Math.round((row as { generated: number }).generated).toLocaleString('en-IE') },
    { head: 'Used', width: 22, align: 'right', cell: (row: never) => Math.round((row as { consumed: number }).consumed).toLocaleString('en-IE') },
    { head: 'From solar', width: 24, align: 'right', cell: (row: never) => Math.round((row as { selfUsed: number }).selfUsed).toLocaleString('en-IE') },
    { head: 'Imported', width: 22, align: 'right', cell: (row: never) => Math.round((row as { imported: number }).imported).toLocaleString('en-IE') },
    { head: 'Exported', width: 22, align: 'right', cell: (row: never) => Math.round((row as { exported: number }).exported).toLocaleString('en-IE') },
    {
      head: 'Self-suff.', width: 22, align: 'right',
      cell: (row: never) => `${Math.round((row as { selfSufficiency: number }).selfSufficiency * 100)}%`,
      color: (row: never) => ((row as { selfSufficiency: number }).selfSufficiency > 0.5 ? ACCENT : INK),
    },
  ];
  table(d, r.months, cols, {
    caption: 'Energy balance by month, kWh',
    note: 'Self-sufficiency is the share of what the house used that did not have to be bought. It is the number that falls hardest in winter, and no battery size changes that — in December there is simply little to store.',
  });
}

function chDays(d: Doc, r: ReportData) {
  if (!r.days?.length) return;
  heading(d, 'Four days across the year', lines(30));
  d.paragraph(
    'Annual totals hide the thing that actually determines your bill: when the electricity arrives and when you need it. These are four real days from the simulation — the pale area is what the panels produced, the line is what the house drew.',
    TYPE.body!);
  d.skip(0.4);
  dayChartLegend(d, !!r.battery);
  d.skip(0.4);

  const half = (d.width - 8) / 2;
  for (let i = 0; i < r.days.length; i += 2) {
    const pair = r.days.slice(i, i + 2);
    d.ensure(lines(11));
    const top = d.y;
    let maxY = d.y;
    pair.forEach((p, j) => {
      d.y = top;
      dayChart(d, p, { width: half, x: d.left + j * (half + 8), showSoc: !!r.battery });
      maxY = Math.max(maxY, d.y);
    });
    d.y = maxY;
    // Per-chart summary line, aligned under each.
    pair.forEach((p, j) => {
      const x = d.left + j * (half + 8);
      d.text(`peak ${p.peakGeneration.toFixed(1)} kW  ·  imported ${p.totalImported.toFixed(1)} kWh  ·  exported ${p.totalExported.toFixed(1)} kWh`,
        x, d.y, { ...TYPE.micro!, maxWidth: half });
    });
    d.y += lines(2);
  }

  /**
   * A battery that is full for much of the year looks like a fault, and on
   * most tariffs it is one. But whether it costs anything depends entirely on
   * whether the plan pays more to export than it charges to import at the
   * cheapest hour — and on an EV tariff it frequently does. Asserting the
   * usual story without checking that would have been wrong here.
   */
  if (r.battery && r.battery.hoursFull > 2000) {
    const hrs = r.battery.hoursFull.toLocaleString('en-IE');
    const a = r.arbitrage;
    if (a && a.exportRate > a.cheapestImport) {
      const spread = (a.exportRate - a.cheapestImport) * 100;
      d.paragraph(
        `Your battery sits full for ${hrs} hours of the year, which usually signals a system that is not working. Here it is deliberate. This plan pays ${(a.exportRate * 100).toFixed(1)}c to export but only charges ${(a.cheapestImport * 100).toFixed(1)}c to buy during its ${a.cheapestBand} window, so selling the surplus and buying it back later earns ${spread.toFixed(1)}c on every unit. The battery is being used to move cheap electricity into expensive hours, not to store your own generation — and on these rates that is the more profitable of the two.`,
        TYPE.body!);
      d.skip(0.5);
      d.paragraph(
        `This depends on the export rate staying above the cheap-window rate. If that gap closes — and export rates are set by suppliers, not regulated — the arithmetic reverses and storing your own generation becomes the better use of the battery. The table in the next section prices that.`,
        TYPE.caption!);
    } else {
      d.paragraph(
        `Your battery sits full for ${hrs} hours of the year. A battery that is already full when the sun comes up cannot absorb the day\u2019s generation, so that surplus is exported${a ? ` at ${(a.exportRate * 100).toFixed(1)}c` : ''} instead of displacing electricity you would otherwise have bought${a ? ` at ${(a.cheapestImport * 100).toFixed(1)}c or more` : ''}. The table in the next section puts a figure on what changing that is worth.`,
        TYPE.body!);
    }
    d.skip(0.6);
  }
}

function chWhereMoneyGoes(d: Doc, r: ReportData) {
  if (!r.bands?.length) return;
  chapter(d, 'Analysis', 'Where the money actually goes',
    `Not every kilowatt-hour costs the same. This is your annual import cost split by the rate band it fell in, on ${planWord(r)}.`);

  const fixed = r.best.standing + 19.1;
  const tot = r.bands.reduce((a, b) => a + b.cost, 0) + fixed;
  const top = r.bands.slice().sort((x, y) => y.cost - x.cost)[0]!;
  finding(d, `${BAND_NAME[top.band] || top.band} electricity is the biggest part of the bill: ${Math.round((top.cost / tot) * 100)}%`,
    `Annual import cost by the rate band it fell in, plus the fixed charges, on ${r.best.supplier}.`);
  stack(d, [...r.bands.map((b) => ({
    label: BAND_NAME[b.band] || b.band, value: b.cost, color: BAND_COLOR[b.band] || DAY, text: eur(b.cost),
    sub: `${Math.round(b.kwh).toLocaleString('en-IE')} kWh at an effective ${(b.effectiveRate * 100).toFixed(1)}c`,
  })), { label: 'Fixed charges', value: fixed, color: FIXED, text: eur(fixed), sub: 'Standing charge and PSO levy' }]);

  if (r.months?.length) {
    const net = r.months.map((m) => m.cost - m.revenue);
    const hi = net.indexOf(Math.max(...net));
    finding(d, `${r.months[hi]!.month} costs the most${net.some((v) => v < 0) ? '; the green months the panels earn more than you buy' : ''}`,
      'Electricity each month, less export payments. Fixed charges come on top.');
    columns(d, net, net.map(() => PEAK), { h: 30, labels: r.months.map((m) => m.month.slice(0, 3)), neg: GREEN });
  }

  if (r.peakConcentration != null && r.peakConcentration > 0) {
    d.paragraph(
      `The dearest 10% of hours account for ${Math.round(r.peakConcentration * 100)}% of what you spend on electricity. ${r.peakConcentration > 0.25
        ? 'That concentration is what makes a time-of-use tariff worth having: moving even a little demand out of those hours has a disproportionate effect.'
        : 'Your demand is spread fairly evenly, which limits how much any time-of-use tariff can do for you — the gain comes mostly from the headline rate rather than from shifting load.'}`,
      TYPE.body!);
    d.skip(0.6);
  }

  if (r.battery) {
    const b = r.battery;
    heading(d, 'How hard the battery works');
    definitions(d, [
      { term: 'Energy cycled through the battery', value: kwh(b.discharged) },
      { term: 'Full equivalent cycles a year', value: b.equivalentCycles.toFixed(0), note: 'Most manufacturers warrant somewhere near 6,000 cycles over the life of the pack.' },
      { term: 'Round-trip efficiency achieved', value: `${Math.round(b.roundTripEfficiency * 100)}%` },
      { term: 'Hours sitting full', value: `${b.hoursFull.toLocaleString('en-IE')} of 8,760`, note: b.hoursFull > 1500 ? 'A battery that is often full has spare capacity you are not using — the constraint is generation or demand, not storage.' : undefined },
      { term: 'Hours sitting empty', value: `${b.hoursEmpty.toLocaleString('en-IE')} of 8,760`, note: b.hoursEmpty > 3000 ? 'A battery that is often empty is working at its limit; a larger one would displace more grid import.' : undefined },
    ]);
  }
}

function chLevers(d: Doc, r: ReportData) {
  if (!r.levers?.length) return;
  chapter(d, 'Variables', 'What would change these numbers',
    'Every figure in this report rests on assumptions. These are the ones that move the answer most, each re-simulated rather than estimated.');

  const best = r.levers.slice().sort((x, y) => y.value - x.value)[0]!;
  finding(d, best.value > 0 ? `${best.label}: worth ${eur(best.value)} a year` : 'None of these changes would leave you better off',
    'Each bar re-runs the full 8,760-hour year with one input changed. Green leaves you better off, orange worse; energy only, before the cost of any equipment.');
  diverging(d, r.levers.map((l) => ({ label: l.label, sub: l.note ? `${l.effect}. ${l.note}` : l.effect, value: l.value })));
  d.skip(0.6);

  d.paragraph(
    'One lever costs nothing and is not in the table because it depends on habit rather than hardware: running the immersion, dishwasher, washing machine or car charger while the panels are producing. Every unit used at the moment it is generated avoids buying that unit entirely, which is worth more than the export rate you would otherwise receive for it.',
    TYPE.body!);
  d.skip(0.6);
}

/* ── entry ───────────────────────────────────────────────────────────────── */

export function renderReport(pdf: PdfDoc, data: ReportData): void {
  const d = new Doc(pdf);
  const r: ReportData = { ...data, origin: data.origin || reportOrigin() };

  cover(d, r);
  contents(d, r);
  chUsage(d, r);
  chHours(d, r);
  chComparison(d, r);
  chWhereMoneyGoes(d, r);
  chSolar(d, r);
  chYear(d, r);
  chDays(d, r);
  chLevers(d, r);
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
