/**
 * Typeset blocks. These are document elements — a table with rules and a
 * caption, a figure with a number — rather than UI cards moved onto paper.
 */

import { Doc } from './doc.js';
import {
  TYPE, BASELINE, lines, LW, PAGE,
  INK, INK_MID, INK_SOFT, RULE, RULE_SOFT, TINT, PAPER,
  ACCENT, ACCENT_TINT, DEBIT, SERIES, SERIES_TINT, SERIES_ALT,
  type Rgb,
} from './theme.js';

export const eur = (v: number, dp = 0) => {
  const n = Math.round(v * 10 ** dp) / 10 ** dp;
  const body = Math.abs(n).toLocaleString('en-IE',
    { minimumFractionDigits: dp, maximumFractionDigits: dp });
  // The sign belongs outside the symbol: "-€87", never "€-87".
  return `${n < 0 ? '-' : ''}€${body}`;
};
export const kwh = (v: number) => `${Math.round(v).toLocaleString('en-IE')} kWh`;
export const signed = (v: number) => `${v < 0 ? '-' : '+'}${eur(Math.abs(v))}`;

/** Chapter opener: number, rule, title, and an optional standfirst. */
export function chapter(d: Doc, no: string, title: string, standfirst?: string) {
  d.ensure(lines(6));
  d.skip(1);
  d.openChapter(title);
  d.text(no.toUpperCase(), d.left, d.y, TYPE.chapterNo!);
  d.y += lines(1.2);
  d.text(title, d.left, d.y, TYPE.chapter!);
  d.y += lines(0.9);
  d.rule(INK, LW.heavy, d.left, d.left + 22);
  d.y += lines(1.2);
  if (standfirst) {
    d.paragraph(standfirst, TYPE.lead!);
    d.skip(0.6);
  }
}

/** Section heading within a chapter. */
export function heading(d: Doc, title: string, keepWith = lines(4)) {
  d.ensure(lines(2) + keepWith);
  d.skip(1);
  d.text(title, d.left, d.y, TYPE.heading!);
  d.y += lines(1.2);
}

/** Small tracked label above a block. */
export function label(d: Doc, text: string) {
  d.ensure(lines(2));
  d.text(text.toUpperCase(), d.left, d.y, TYPE.subhead!);
  d.y += lines(0.9);
}

/**
 * A figure lifted out of the running text: number, unit, and a one-line gloss.
 * Used where a reader should be able to find the answer without reading.
 */
export function pullFigure(
  d: Doc,
  value: string,
  gloss: string,
  opts: { color?: Rgb; caption?: string; x?: number; width?: number } = {},
) {
  const x = opts.x ?? d.left;
  const w = opts.width ?? d.width;
  d.text(value, x, d.y, { ...TYPE.figure!, color: opts.color ?? INK, maxWidth: w });
  d.y += lines(1.5);
  d.text(gloss, x, d.y, { ...TYPE.caption!, maxWidth: w });
  d.y += lines(1);
  if (opts.caption) {
    d.text(opts.caption, x, d.y, { ...TYPE.micro!, maxWidth: w });
    d.y += lines(0.9);
  }
}

export interface Column {
  head: string;
  /** Width in mm; one column may be 0 to absorb the remainder. */
  width: number;
  align?: 'left' | 'right';
  /** Renders the cell; return a string, or draw directly and return ''. */
  cell: (row: never, d: Doc, x: number, w: number) => string;
  color?: (row: never) => Rgb;
  bold?: (row: never) => boolean;
}

/**
 * Typeset table: rules above and below the head, a hairline under the last
 * row, no zebra striping. Repeats its head when it breaks across a page.
 */
export function table<T>(
  d: Doc,
  rows: T[],
  columns: Column[],
  opts: { caption?: string; note?: string; emphasise?: (row: T) => boolean } = {},
) {
  const flex = d.width - columns.reduce((a, c) => a + c.width, 0);
  const widths = columns.map((c) => (c.width === 0 ? flex : c.width));
  const xs: number[] = [];
  let acc = d.left;
  widths.forEach((w) => { xs.push(acc); acc += w; });
  const rowH = lines(1.15);

  const drawHead = () => {
    d.ensure(rowH * 2.5);
    d.rule(INK, LW.rule);
    d.y += lines(0.95);
    columns.forEach((c, i) => {
      const x = c.align === 'right' ? xs[i]! + widths[i]! : xs[i]!;
      d.text(c.head.toUpperCase(), x, d.y, { ...TYPE.tableHead!, align: c.align ?? 'left', maxWidth: widths[i] });
    });
    d.y += lines(0.55);
    d.rule(RULE, LW.hair);
    d.y += lines(0.95);
  };

  if (opts.caption) label(d, opts.caption);
  drawHead();

  rows.forEach((row) => {
    if (d.ensure(rowH + lines(1))) drawHead();
    const emph = opts.emphasise?.(row) ?? false;
    if (emph) {
      d.fill(ACCENT_TINT);
      d.doc.rect(d.left - 2, d.y - lines(0.78), d.width + 4, rowH, 'F');
    }
    columns.forEach((c, i) => {
      const x = c.align === 'right' ? xs[i]! + widths[i]! : xs[i]!;
      const spec = {
        ...(c.bold?.(row as never) || emph ? TYPE.dataBold! : TYPE.data!),
        color: c.color?.(row as never) ?? (emph ? ACCENT : INK),
        align: c.align ?? 'left',
        maxWidth: widths[i]! - 3,
      };
      const txt = c.cell(row as never, d, xs[i]!, widths[i]!);
      if (txt) d.text(txt, x, d.y, spec);
    });
    d.y += rowH;
  });

  d.y -= lines(0.3);
  d.rule(INK, LW.rule);
  d.y += lines(1);
  if (opts.note) {
    d.paragraph(opts.note, TYPE.caption!);
    d.skip(0.4);
  }
}

/** Inline proportional bar, drawn inside a table cell. */
export function cellBar(d: Doc, x: number, w: number, frac: number, color: Rgb) {
  const h = 1.5;
  const y = d.y - 1.6;
  d.fill(RULE_SOFT);
  d.doc.rect(x, y, w - 4, h, 'F');
  d.fill(color);
  d.doc.rect(x, y, Math.max(0.4, Math.min(1, frac) * (w - 4)), h, 'F');
}

/** Definition list — term on the left, value flush right, leader-free. */
export function definitions(d: Doc, items: { term: string; value: string; note?: string }[]) {
  items.forEach((it) => {
    d.ensure(lines(1.4));
    const vw = d.measure(it.value, TYPE.dataBold!);
    d.text(it.term, d.left, d.y, { ...TYPE.body!, maxWidth: d.width - vw - 6 });
    d.text(it.value, d.right, d.y, { ...TYPE.dataBold!, align: 'right' });
    d.y += lines(1);
    if (it.note) {
      d.text(it.note, d.left, d.y, TYPE.caption!);
      d.y += lines(0.9);
    }
  });
}

/** Boxed aside for caveats and context. */
export function callout(d: Doc, title: string, body: string, tone: Rgb = INK) {
  const inset = 5;
  const width = d.width - inset * 2;
  // Measure with the caption face active so the wrap matches what is drawn.
  d.measure('', TYPE.caption!);
  const rows = d.doc.splitTextToSize(body, width);
  const h = lines(1.6) + rows.length * (TYPE.caption!.leading ?? BASELINE) + lines(0.8);
  d.ensure(h + lines(1));
  const top = d.y - lines(0.9);
  d.fill(TINT);
  d.doc.rect(d.left, top, d.width, h, 'F');
  d.fill(tone);
  d.doc.rect(d.left, top, 1.1, h, 'F');
  d.y += lines(0.4);
  d.text(title.toUpperCase(), d.left + inset, d.y, { ...TYPE.subhead!, color: tone });
  d.y += lines(1);
  d.paragraph(body, TYPE.caption!, { x: d.left + inset, width });
  d.y = top + h + lines(1);
}

/** Column chart with a value axis, used for period consumption. */
export function columnChart(
  d: Doc,
  data: { label: string; value: number }[],
  opts: { height?: number; color?: Rgb; unit?: string; caption?: string } = {},
) {
  if (!data.length) return;
  const h = opts.height ?? lines(9);
  d.ensure(h + lines(4));
  const axisW = 13;
  const x0 = d.left + axisW;
  const plotW = d.width - axisW;
  const top = d.y;
  const base = top + h;
  const max = Math.max(1, ...data.map((r) => r.value));

  for (let i = 0; i <= 2; i += 1) {
    const gy = base - (i / 2) * h;
    d.stroke(i === 0 ? RULE : RULE_SOFT).weight(LW.hair);
    d.doc.line(x0, gy, d.right, gy);
    d.text(Math.round((max * i) / 2).toLocaleString('en-IE'), x0 - 2.5, gy + 1,
      { ...TYPE.micro!, align: 'right' });
  }

  const gap = 3.2;
  const bw = (plotW - gap * (data.length - 1)) / data.length;
  data.forEach((r, i) => {
    const x = x0 + i * (bw + gap);
    const bh = Math.max(0.6, (r.value / max) * h);
    d.fill(opts.color ?? SERIES);
    d.doc.rect(x, base - bh, bw, bh, 'F');
    d.text(Math.round(r.value).toLocaleString('en-IE'), x + bw / 2, base - bh - 1.6,
      { ...TYPE.micro!, color: INK_MID, align: 'center', maxWidth: bw });
    d.text(r.label, x + bw / 2, base + 3.4, { ...TYPE.micro!, align: 'center', maxWidth: bw });
  });

  d.y = base + lines(1.6);
  if (opts.caption) { d.text(opts.caption, d.left, d.y, TYPE.caption!); d.y += lines(1.8); }
}

/** Hour-of-day rate profile, comparing two plans across 24 hours. */
export function rateProfile(
  d: Doc,
  series: { name: string; color: Rgb; rates: number[] }[],
  opts: { height?: number; caption?: string } = {},
) {
  const h = opts.height ?? lines(8);
  d.ensure(h + lines(5));
  const axisW = 15;
  const x0 = d.left + axisW;
  const plotW = d.width - axisW;
  const top = d.y;
  const base = top + h;
  const max = Math.max(0.1, ...series.flatMap((s) => s.rates));

  for (let i = 0; i <= 2; i += 1) {
    const gy = base - (i / 2) * h;
    d.stroke(i === 0 ? RULE : RULE_SOFT).weight(LW.hair);
    d.doc.line(x0, gy, d.right, gy);
    d.text(`${((max * i) / 2 * 100).toFixed(0)}c`, x0 - 2.5, gy + 1, { ...TYPE.micro!, align: 'right' });
  }

  series.forEach((s) => {
    d.stroke(s.color).weight(LW.chart);
    for (let hr = 0; hr < 24; hr += 1) {
      const x1 = x0 + (hr / 24) * plotW;
      const x2 = x0 + ((hr + 1) / 24) * plotW;
      const y = base - ((s.rates[hr] ?? 0) / max) * h;
      d.doc.line(x1, y, x2, y);
      if (hr > 0) {
        const yPrev = base - ((s.rates[hr - 1] ?? 0) / max) * h;
        d.doc.line(x1, yPrev, x1, y);
      }
    }
  });

  for (let hr = 0; hr <= 24; hr += 6) {
    d.text(`${String(hr).padStart(2, '0')}:00`, x0 + (hr / 24) * plotW, base + 3.4,
      { ...TYPE.micro!, align: hr === 0 ? 'left' : hr === 24 ? 'right' : 'center' });
  }

  d.y = base + lines(1.6);
  let lx = d.left;
  series.forEach((s) => {
    d.stroke(s.color).weight(LW.chart);
    d.doc.line(lx, d.y - 1, lx + 5, d.y - 1);
    const w = d.text(s.name, lx + 6.5, d.y, { ...TYPE.micro!, color: INK_MID });
    lx += w + 13;
  });
  d.y += lines(1.2);
  if (opts.caption) { d.text(opts.caption, d.left, d.y, TYPE.caption!); d.y += lines(1); }
}

/** Cumulative cash-flow curve with break-even and a labelled battery dip. */
export function cashFlow(
  d: Doc,
  series: number[],
  opts: { height?: number; breakeven?: number | null; dip?: number; caption?: string } = {},
) {
  const h = opts.height ?? lines(11);
  d.ensure(h + lines(5));
  const axisW = 17;
  const x0 = d.left + axisW;
  const plotW = d.width - axisW;
  const top = d.y;
  const base = top + h;
  const min = Math.min(0, ...series);
  const max = Math.max(0, ...series);
  const span = Math.max(1, max - min);
  const yFor = (v: number) => base - ((v - min) / span) * h;
  const xFor = (i: number) => x0 + (i / Math.max(1, series.length - 1)) * plotW;
  const zero = yFor(0);

  d.fill(DEBIT); d.doc.setFillColor(250, 244, 243);
  d.doc.rect(x0, zero, plotW, Math.max(0, base - zero), 'F');
  d.fill(ACCENT_TINT);
  d.doc.rect(x0, top, plotW, Math.max(0, zero - top), 'F');

  for (const v of [max, 0, min]) {
    const gy = yFor(v);
    d.stroke(v === 0 ? INK_SOFT : RULE_SOFT).weight(v === 0 ? LW.rule : LW.hair);
    d.doc.line(x0, gy, d.right, gy);
    d.text(eur(v), x0 - 2.5, gy + 1, { ...TYPE.micro!, align: 'right' });
  }
  d.text('break even', x0 + 1.5, zero - 1.4, { ...TYPE.microBold! });

  d.stroke(ACCENT).weight(LW.chart);
  for (let i = 1; i < series.length; i += 1) {
    d.doc.line(xFor(i - 1), yFor(series[i - 1] ?? 0), xFor(i), yFor(series[i] ?? 0));
  }

  const last = series.length - 1;
  for (let yr = 0; yr <= last; yr += 5) {
    if (yr === last) continue;
    d.text(`Year ${yr}`, xFor(yr), base + 3.4, { ...TYPE.micro!, align: yr === 0 ? 'left' : 'center' });
  }
  d.text(`Year ${last}`, d.right, base + 3.4, { ...TYPE.micro!, align: 'right' });

  if (opts.dip && opts.dip < series.length) {
    const dx = xFor(opts.dip);
    const dy = yFor(series[opts.dip] ?? 0);
    d.stroke(INK_SOFT).weight(LW.hair);
    d.doc.line(dx, dy, dx, dy - 5.5);
    d.text('battery replaced', dx, dy - 6.8, { ...TYPE.micro!, color: INK_MID, align: 'center' });
  }

  d.y = base + lines(1.8);
  if (opts.caption) { d.paragraph(opts.caption, TYPE.caption!); }
}

/** Proportional split bar — where generated energy actually goes. */
export function splitBar(
  d: Doc,
  parts: { label: string; value: number; color: Rgb }[],
  opts: { caption?: string } = {},
) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  const h = 7;
  d.ensure(h + lines(4));
  let x = d.left;
  parts.forEach((p) => {
    const w = (p.value / total) * d.width;
    d.fill(p.color);
    d.doc.rect(x, d.y, w, h, 'F');
    if (w > 16) {
      d.text(`${Math.round((p.value / total) * 100)}%`, x + w / 2, d.y + 4.6,
        { ...TYPE.micro!, color: PAPER, align: 'center' });
    }
    x += w;
  });
  d.y += h + lines(1.1);
  let lx = d.left;
  parts.forEach((p) => {
    d.fill(p.color);
    d.doc.rect(lx, d.y - 2, 2.4, 2.4, 'F');
    const w = d.text(`${p.label} — ${kwh(p.value)}`, lx + 3.8, d.y, { ...TYPE.micro!, color: INK_MID });
    lx += w + 11;
  });
  d.y += lines(1.2);
  if (opts.caption) { d.text(opts.caption, d.left, d.y, TYPE.caption!); d.y += lines(1); }
}
