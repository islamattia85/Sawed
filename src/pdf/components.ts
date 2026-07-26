/**
 * Report components. Each one owns its own height so the caller can reserve
 * space before drawing and never split a block across a page break.
 */

import { Canvas, type Align } from './layout.js';
import { C, T, S, LW, PAGE, type Rgb } from './theme.js';

const money = (v: number) => `€${Math.round(v).toLocaleString('en-IE')}`;

/** Section header: a rule, a kicker and a title. Quieter than a filled band. */
export function sectionHeader(
  c: Canvas, title: string, kicker?: string, accent: Rgb = C.gain, keepWith = 26,
) {
  // Reserve the header AND enough of what follows that the two never separate.
  c.reserve(20 + keepWith);
  c.space(S.section - 4);
  c.stroke(accent).lineWidth(LW.accent);
  c.doc.line(c.left, c.y, c.left + 14, c.y);
  c.y += 4.5;
  if (kicker) {
    c.text(kicker.toUpperCase(), c.left, c.y, { size: T.label, bold: true, color: accent });
    c.y += 4.2;
  }
  c.text(title, c.left, c.y, { size: T.title, bold: true, color: C.ink });
  c.y += 5;
}

/** A label / value row with a leader rule, used for dense figure lists. */
export function figureRow(
  c: Canvas,
  label: string,
  value: string,
  opts: { valueColor?: Rgb; bold?: boolean; note?: string } = {},
) {
  const vOpts = { size: T.dense, bold: opts.bold ?? true, color: opts.valueColor ?? C.ink };
  const vw = c.measure(value, vOpts);
  c.text(label, c.left, c.y, { size: T.dense, color: C.inkSoft, maxWidth: c.width - vw - 8 });
  c.text(value, c.right, c.y, { ...vOpts, align: 'right' });
  if (opts.note) {
    c.y += 3.4;
    c.text(opts.note, c.left, c.y, { size: T.micro, color: C.inkDim });
  }
  c.y += S.row;
}

export interface Tile {
  label: string;
  value: string;
  note?: string;
  color: Rgb;
  bg: Rgb;
}

/** Row of equal-width stat tiles. Text is fitted, so a long value cannot overflow. */
export function tileRow(c: Canvas, tiles: Tile[], height = 24) {
  if (!tiles.length) return;
  c.reserve(height + 4);
  const gap = 3;
  const w = (c.width - gap * (tiles.length - 1)) / tiles.length;
  tiles.forEach((t, i) => {
    const x = c.left + i * (w + gap);
    const box = c.panel({ x, y: c.y, w, h: height, bg: t.bg, border: t.color, inset: 3.5 });
    c.fill(t.color);
    c.doc.rect(x + 1.6, c.y, w - 3.2, 1.6, 'F');
    const inner = box.inner;
    c.text(t.label.toUpperCase(), inner.x, inner.y + 3.4,
      { size: T.label, bold: true, color: t.color, maxWidth: inner.w });
    c.text(t.value, inner.x, inner.y + 11,
      { size: T.figure, bold: true, color: t.color, maxWidth: inner.w });
    if (t.note) {
      c.text(t.note, inner.x, inner.y + 15.6,
        { size: T.micro, color: C.inkSoft, maxWidth: inner.w });
    }
  });
  c.y += height + 4;
}

export interface RankRow {
  rank: number;
  name: string;
  cost: number;
  /** 0-1 share of the bar track. */
  share: number;
  highlight?: boolean;
}

/**
 * Ranked plan table with an inline bar. The bar encodes SAVING vs the worst
 * plan, and is drawn in the "gain" role so it reads consistently with the rest
 * of the report — the old version used an unexplained blue here.
 */
export function rankTable(c: Canvas, rows: RankRow[], caption: string) {
  const rowH = 6.4;
  const barX = c.left + 96;
  const barW = 44;
  const costX = c.right;

  c.text('RANK  ·  PLAN', c.left, c.y, { size: T.label, bold: true, color: C.inkSoft });
  c.text(caption.toUpperCase(), barX, c.y, { size: T.label, bold: true, color: C.inkSoft });
  c.text('ANNUAL COST', costX, c.y, { size: T.label, bold: true, color: C.inkSoft, align: 'right' });
  c.y += 2.4;
  c.rule();
  c.y += 3.6;

  rows.forEach((r, i) => {
    if (c.reserve(rowH + 2)) { c.y += 2; }
    const top = c.y - 4.2;
    if (r.highlight) {
      c.fill(C.gainSoft);
      c.doc.roundedRect(c.left - 2, top, c.width + 4, rowH, 1, 1, 'F');
    } else if (i % 2 === 1) {
      c.fill(C.wash);
      c.doc.rect(c.left - 2, top, c.width + 4, rowH, 'F');
    }

    const label = `${String(r.rank).padStart(2, ' ')}.  ${r.name}`;
    c.text(label, c.left, c.y, {
      size: T.dense,
      bold: !!r.highlight,
      color: r.highlight ? C.gain : C.ink,
      maxWidth: barX - c.left - 4,
    });

    // bar track + fill
    c.fill(C.rule);
    c.doc.roundedRect(barX, c.y - 2.6, barW, 2.6, 0.6, 0.6, 'F');
    const fillW = Math.max(0.6, Math.min(1, r.share) * barW);
    c.fill(r.highlight ? C.gain : [124, 168, 140]);
    c.doc.roundedRect(barX, c.y - 2.6, fillW, 2.6, 0.6, 0.6, 'F');

    c.text(money(r.cost), costX, c.y, {
      size: T.dense, bold: !!r.highlight,
      color: r.highlight ? C.gain : C.ink, align: 'right',
    });
    c.y += rowH;
  });
}

export interface BarDatum { label: string; value: number; color?: Rgb; }

/** Vertical bar chart with a value axis and labelled bars. */
export function barChart(
  c: Canvas,
  data: BarDatum[],
  opts: { height?: number; unit?: string; color?: Rgb } = {},
) {
  const h = opts.height ?? 42;
  c.reserve(h + 16);
  const max = Math.max(1, ...data.map((d) => d.value));
  const axisW = 14;
  const plotX = c.left + axisW;
  const plotW = c.width - axisW;
  const top = c.y;
  const base = top + h;

  // gridlines + value axis
  for (let i = 0; i <= 2; i += 1) {
    const frac = i / 2;
    const gy = base - frac * h;
    c.stroke(C.rule).lineWidth(LW.hairline);
    c.doc.line(plotX, gy, c.right, gy);
    c.text(Math.round(max * frac).toLocaleString('en-IE'), plotX - 2, gy + 1,
      { size: T.micro, color: C.inkDim, align: 'right' });
  }

  const gap = 3;
  const bw = (plotW - gap * (data.length - 1)) / data.length;
  data.forEach((d, i) => {
    const x = plotX + i * (bw + gap);
    const bh = Math.max(0.8, (d.value / max) * h);
    c.fill(d.color ?? opts.color ?? C.use);
    c.doc.roundedRect(x, base - bh, bw, bh, 0.8, 0.8, 'F');
    c.text(Math.round(d.value).toLocaleString('en-IE'), x + bw / 2, base - bh - 1.8,
      { size: T.micro, bold: true, color: C.ink, align: 'center', maxWidth: bw });
    c.text(d.label, x + bw / 2, base + 4, { size: T.micro, color: C.inkSoft, align: 'center', maxWidth: bw });
  });

  if (opts.unit) {
    c.text(opts.unit, c.right, base + 8, { size: T.micro, color: C.inkDim, align: 'right' });
    c.y = base + 13;
  } else {
    c.y = base + 9;
  }
}

/**
 * Cumulative cash-flow curve with a break-even axis, year ticks and a labelled
 * battery-replacement dip. The old chart drew the curve with no value axis at
 * all, so the reader could not tell what any point was worth.
 */
export function cashFlowChart(
  c: Canvas,
  series: number[],
  opts: { height?: number; breakevenYear?: number | null; dipYear?: number } = {},
) {
  const h = opts.height ?? 52;
  c.reserve(h + 20);
  const axisW = 18;
  const plotX = c.left + axisW;
  const plotW = c.width - axisW;
  const top = c.y;
  const base = top + h;

  const min = Math.min(0, ...series);
  const max = Math.max(0, ...series);
  const span = Math.max(1, max - min);
  const yFor = (v: number) => base - ((v - min) / span) * h;
  const xFor = (i: number) => plotX + (i / Math.max(1, series.length - 1)) * plotW;
  const zeroY = yFor(0);

  // negative region wash — "still paying back"
  c.fill(C.costSoft);
  c.doc.rect(plotX, zeroY, plotW, Math.max(0, base - zeroY), 'F');
  c.fill(C.gainSoft);
  c.doc.rect(plotX, top, plotW, Math.max(0, zeroY - top), 'F');

  // value axis
  for (const v of [max, 0, min]) {
    const gy = yFor(v);
    c.stroke(v === 0 ? C.inkSoft : C.rule).lineWidth(LW.hairline);
    c.doc.line(plotX, gy, c.right, gy);
    c.text(money(v), plotX - 2, gy + 1, { size: T.micro, color: C.inkDim, align: 'right' });
  }
  c.text('break-even', plotX + 1.5, zeroY - 1.4, { size: T.micro, bold: true, color: C.inkSoft });

  // curve
  c.stroke(C.gain).lineWidth(LW.chart);
  for (let i = 1; i < series.length; i += 1) {
    c.doc.line(xFor(i - 1), yFor(series[i - 1] ?? 0), xFor(i), yFor(series[i] ?? 0));
  }

  // Year ticks. The final year is only drawn separately when the 5-year grid
  // does not already land on it, otherwise the two labels overprint.
  const last = series.length - 1;
  for (let yr = 0; yr < series.length; yr += 5) {
    if (yr === last) continue;
    c.text(`Y${yr}`, xFor(yr), base + 4, { size: T.micro, color: C.inkDim, align: 'center' });
  }
  c.text(`Y${last}`, c.right, base + 4, { size: T.micro, color: C.inkDim, align: 'right' });

  // annotate the battery replacement dip, which otherwise looks like an error
  if (opts.dipYear && opts.dipYear < series.length) {
    const dx = xFor(opts.dipYear);
    const dy = yFor(series[opts.dipYear] ?? 0);
    c.stroke(C.inkDim).lineWidth(LW.hairline);
    c.doc.line(dx, dy, dx, dy - 6);
    c.text('battery replaced', dx, dy - 7.4, { size: T.micro, color: C.inkSoft, align: 'center' });
  }

  c.y = base + 8;
  if (opts.breakevenYear) {
    c.text(`Breaks even in year ${opts.breakevenYear}.`, c.left, c.y,
      { size: T.micro, color: C.inkSoft });
  }
  c.y += 4;
}

/** Legend strip so a chart's colours are never unexplained. */
export function legend(c: Canvas, items: { color: Rgb; label: string }[]) {
  let x = c.left;
  items.forEach((it) => {
    c.fill(it.color);
    c.doc.roundedRect(x, c.y - 2, 2.6, 2.6, 0.5, 0.5, 'F');
    const w = c.text(it.label, x + 4, c.y, { size: T.micro, color: C.inkSoft });
    x += w + 10;
  });
  c.y += 5;
}

/** Numbered step, used by the switching guide. */
export function step(c: Canvas, index: number, title: string, body: string) {
  c.reserve(16);
  const size = 5.4;
  c.fill(C.gain);
  c.doc.roundedRect(c.left, c.y - 3.8, size, size, 1.2, 1.2, 'F');
  c.text(String(index), c.left + size / 2, c.y, {
    size: T.micro, bold: true, color: C.paper, align: 'center',
  });
  const tx = c.left + size + 3.5;
  c.text(title, tx, c.y, { size: T.body, bold: true, color: C.ink, maxWidth: c.width - size - 4 });
  c.y += 4;
  c.paragraph(body, {
    x: tx, width: c.width - size - 4, size: T.dense, color: C.inkSoft, leading: 3.7,
  });
  c.y += 2.4;
}

export { money };
