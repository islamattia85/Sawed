/**
 * Report visuals: the app's own pictures, drawn as vector shapes.
 *
 * Every chart here reads one series and says one thing; the title above it
 * states what it found. Colours are the app's: cheap hours blue, the day a
 * neutral grey, peak orange, solar gold, kept green.
 */

import type { Doc } from './doc.js';
import { TYPE, lines, INK, INK_MID, INK_SOFT, RULE, RULE_SOFT, PAPER, type Rgb } from './theme.js';

export const NAVY: Rgb = [22, 52, 61];
export const NAVY_2: Rgb = [33, 70, 81];
export const GOLD: Rgb = [255, 209, 102];
export const GREEN: Rgb = [18, 122, 76];
export const GREEN_TINT: Rgb = [228, 242, 234];
export const NIGHT: Rgb = [37, 106, 191];
export const DAY: Rgb = [126, 136, 144];
export const PEAK: Rgb = [217, 89, 38];
export const EVBAND: Rgb = [18, 122, 76];
export const WFH: Rgb = [201, 138, 27];
export const MADE: Rgb = [201, 133, 0];
export const KEPT: Rgb = [25, 158, 112];
export const FIXED: Rgb = [171, 178, 169];
export const CARD: Rgb = [247, 246, 241];

export const BAND_COLOR: Record<string, Rgb> = { night: NIGHT, day: DAY, peak: PEAK, ev: EVBAND, wfh: WFH };
export const BAND_NAME: Record<string, string> = { night: 'Night', day: 'Day', peak: 'Peak', ev: 'EV window', wfh: 'Work from home' };

const f = (v: number) => (Number.isFinite(v) ? v : 0);

export function box(d: Doc, x: number, y: number, w: number, h: number, c: Rgb, r = 0) {
  if (w <= 0.01 || h <= 0.01) return;
  d.fill(c);
  if (r > 0) d.doc.roundedRect(f(x), f(y), f(w), f(h), Math.min(r, w / 2, h / 2), Math.min(r, w / 2, h / 2), 'F');
  else d.doc.rect(f(x), f(y), f(w), f(h), 'F');
}

/** A finding as a heading: what the chart below shows, in words. */
export function finding(d: Doc, title: string, sub?: string) {
  d.ensure(lines(sub ? 4 : 3) + 30);
  d.skip(0.6);
  d.text(title, d.left, d.y, { face: 'helvetica', style: 'bold', size: 11, color: INK, maxWidth: d.width });
  d.y += lines(1.1);
  if (sub) { d.paragraph(sub, { ...TYPE.caption!, face: 'helvetica', style: 'normal', size: 8, color: INK_MID }); }
  d.y += lines(0.3);
}

/** A row of figure tiles. */
export function tiles(d: Doc, items: { k: string; v: string; sub?: string; tone?: Rgb; bg?: Rgb }[], opts: { h?: number; dark?: boolean } = {}) {
  if (!items.length) return;
  const h = opts.h ?? 22;
  d.ensure(h + 4);
  const gap = 3;
  const w = (d.width - gap * (items.length - 1)) / items.length;
  const top = d.y;
  items.forEach((it, i) => {
    const x = d.left + i * (w + gap);
    box(d, x, top, w, h, it.bg ?? (opts.dark ? NAVY_2 : CARD), 2.5);
    d.text(it.k, x + 3.5, top + 5.6, { face: 'helvetica', style: 'bold', size: 6.6, color: opts.dark ? [190, 208, 212] : INK_MID, maxWidth: w - 7 });
    d.text(it.v, x + 3.5, top + 13.4, { face: 'helvetica', style: 'bold', size: 14, color: it.tone ?? (opts.dark ? PAPER : INK), maxWidth: w - 7 });
    if (it.sub) d.text(it.sub, x + 3.5, top + 18.6, { face: 'helvetica', style: 'normal', size: 6.4, color: opts.dark ? [170, 190, 196] : INK_SOFT, maxWidth: w - 7 });
  });
  d.y = top + h + 4;
}

/** Horizontal bars: a label and value above each bar, one scale. */
export function hbars(d: Doc, rows: { label: string; sub?: string; value: number; color: Rgb; text: string; bold?: boolean }[], opts: { max?: number; barH?: number } = {}) {
  if (!rows.length) return;
  const max = Math.max(1e-6, opts.max ?? Math.max(...rows.map((r) => Math.abs(r.value))));
  const bh = opts.barH ?? 3.2;
  rows.forEach((r) => {
    const rowH = (r.sub ? 4 : 0) + 5 + bh + 2.6;
    d.ensure(rowH);
    const vw = d.measure(r.text, { face: 'helvetica', style: 'bold', size: 9 });
    d.text(r.label, d.left, d.y, { face: 'helvetica', style: 'bold', size: 8.4, color: INK, maxWidth: d.width - vw - 6 });
    d.text(r.text, d.right, d.y, { face: 'helvetica', style: 'bold', size: 9, color: r.bold ? GREEN : INK, align: 'right' });
    if (r.sub) { d.y += 3.6; d.text(r.sub, d.left, d.y, { face: 'helvetica', style: 'normal', size: 6.8, color: INK_SOFT, maxWidth: d.width - vw - 6 }); }
    d.y += 1.8;
    box(d, d.left, d.y, d.width, bh, RULE_SOFT, bh / 2);
    box(d, d.left, d.y, Math.max(bh, (Math.abs(r.value) / max) * d.width), bh, r.color, bh / 2);
    d.y += bh + 5;
  });
}

/** One bar split into parts, with a legend underneath. */
export function stack(d: Doc, parts: { label: string; sub?: string; value: number; color: Rgb; text: string }[]) {
  const ps = parts.filter((p) => p.value > 0.0001);
  if (!ps.length) return;
  const tot = ps.reduce((a, p) => a + p.value, 0);
  d.ensure(14 + ps.length * 7);
  let x = d.left;
  const h = 7;
  ps.forEach((p) => {
    const w = (p.value / tot) * d.width;
    box(d, x, d.y, Math.max(0.6, w - 0.8), h, p.color, 1.2);
    x += w;
  });
  d.y += h + 6;
  ps.forEach((p) => {
    d.ensure(8);
    box(d, d.left, d.y - 2.6, 2.8, 2.8, p.color, 0.6);
    d.text(p.label, d.left + 5, d.y, { face: 'helvetica', style: 'bold', size: 8.2, color: INK, maxWidth: d.width - 50 });
    d.text(p.text, d.right, d.y, { face: 'helvetica', style: 'bold', size: 8.4, color: INK, align: 'right' });
    d.text(`${Math.round((p.value / tot) * 100)}%`, d.right - 26, d.y, { face: 'helvetica', style: 'normal', size: 7.6, color: INK_SOFT, align: 'right' });
    if (p.sub) { d.y += 3.4; d.text(p.sub, d.left + 5, d.y, { face: 'helvetica', style: 'normal', size: 6.6, color: INK_SOFT, maxWidth: d.width - 50 }); }
    d.y += 5.2;
  });
}

/** Columns from a baseline, each coloured by its own band. */
export function columns(d: Doc, vals: number[], colors: Rgb[], opts: { h?: number; labels?: string[]; every?: number; neg?: Rgb } = {}) {
  if (!vals.length) return;
  const h = opts.h ?? 34;
  d.ensure(h + 8);
  const top = d.y;
  const max = Math.max(1e-6, ...vals.map((v) => Math.abs(v)));
  const hasNeg = vals.some((v) => v < 0);
  const zero = hasNeg ? top + h * (Math.max(...vals, 0) / (Math.max(...vals, 0) - Math.min(...vals, 0) || 1)) : top + h;
  const scale = hasNeg ? h / ((Math.max(...vals, 0) - Math.min(...vals, 0)) || 1) : h / max;
  const slot = d.width / vals.length;
  const bw = Math.max(0.4, slot * 0.72);
  vals.forEach((v, i) => {
    const x = d.left + i * slot + (slot - bw) / 2;
    const bh = Math.abs(v) * scale;
    const c = v < 0 && opts.neg ? opts.neg : colors[i % colors.length]!;
    if (v >= 0) box(d, x, zero - bh, bw, bh, c, Math.min(0.8, bw / 3));
    else box(d, x, zero, bw, bh, c, Math.min(0.8, bw / 3));
  });
  d.stroke(RULE).weight(0.2);
  d.doc.line(d.left, zero, d.right, zero);
  d.y = top + h + 4;
  if (opts.labels) {
    const every = opts.every ?? 1;
    opts.labels.forEach((l, i) => {
      if (i % every) return;
      d.text(l, d.left + i * slot + slot / 2, d.y, { face: 'helvetica', style: 'normal', size: 6.4, color: INK_SOFT, align: 'center' });
    });
    d.y += 4;
  }
}

/**
 * The year as a picture: a column per day, a row per hour, darker where the
 * home used more. Winter evenings and the overnight water heating show up as
 * shapes rather than as numbers.
 */
export function heatmap(d: Doc, use: number[], opts: { h?: number } = {}) {
  const days = Math.floor(use.length / 24);
  if (days < 7) return;
  const h = opts.h ?? 48;
  const lw = 9;
  d.ensure(h + 14);
  const top = d.y;
  const x0 = d.left + lw;
  const W = d.width - lw;
  const cw = W / days;
  const ch = h / 24;
  const sorted = use.slice().sort((a, b) => a - b);
  const hi = sorted[Math.floor(sorted.length * 0.98)] || 1;
  const lo: Rgb = [240, 244, 247];
  const mid: Rgb = [92, 150, 200];
  const top3: Rgb = NAVY;
  const col = (v: number): Rgb => {
    // Rank, not size: a few big overnight hours would otherwise wash out the rest of the year.
    let lo2 = 0, hi2 = sorted.length - 1;
    while (lo2 < hi2) { const m = (lo2 + hi2) >> 1; if (sorted[m]! < v) lo2 = m + 1; else hi2 = m; }
    const t = lo2 / sorted.length;
    const [a, b, u] = t < 0.5 ? [lo, mid, t * 2] : [mid, top3, (t - 0.5) * 2];
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u].map(Math.round) as unknown as Rgb;
  };
  for (let dd = 0; dd < days; dd += 1) {
    for (let hh = 0; hh < 24; hh += 1) {
      d.fill(col(use[dd * 24 + hh] || 0));
      d.doc.rect(x0 + dd * cw, top + hh * ch, cw + 0.05, ch + 0.05, 'F');
    }
  }
  [0, 6, 12, 18].forEach((hh) => d.text(`${String(hh).padStart(2, '0')}:00`, d.left, top + hh * ch + 2.2, { face: 'helvetica', style: 'normal', size: 5.8, color: INK_SOFT }));
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DIM = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let acc = 0;
  M.forEach((m, i) => { d.text(m, x0 + (acc + DIM[i]! / 2) * cw, top + h + 4, { face: 'helvetica', style: 'normal', size: 6, color: INK_SOFT, align: 'center' }); acc += DIM[i]!; });
  // scale key
  const ky = top + h + 8.5;
  for (let i = 0; i < 20; i += 1) { d.fill(col(sorted[Math.min(sorted.length - 1, Math.floor((i / 19) * (sorted.length - 1)))]!)); d.doc.rect(d.right - 40 + i * 2, ky - 2.2, 2.05, 2.4, 'F'); }
  d.text('less', d.right - 41.5, ky, { face: 'helvetica', style: 'normal', size: 5.8, color: INK_SOFT, align: 'right' });
  d.text('more used', d.right - 40, ky + 3.6, { face: 'helvetica', style: 'normal', size: 5.8, color: INK_SOFT });
  d.y = ky + 7;
}

/** A meter: how sure a figure is. */
export function meter(d: Doc, frac: number, color: Rgb = GREEN) {
  d.ensure(8);
  box(d, d.left, d.y, d.width, 3, RULE_SOFT, 1.5);
  box(d, d.left, d.y, Math.max(3, Math.min(1, frac) * d.width), 3, color, 1.5);
  d.y += 7;
}

/** Bars either side of zero: what each change would be worth. */
export function diverging(d: Doc, rows: { label: string; sub?: string; value: number }[]) {
  if (!rows.length) return;
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  const mid = d.left + d.width * 0.62;
  const half = d.width * 0.36;
  rows.forEach((r) => {
    d.ensure(11);
    d.text(r.label, d.left, d.y, { face: 'helvetica', style: 'bold', size: 8, color: INK, maxWidth: mid - d.left - 30 });
    if (r.sub) d.text(r.sub, d.left, d.y + 3.4, { face: 'helvetica', style: 'normal', size: 6.4, color: INK_SOFT, maxWidth: mid - d.left - 30 });
    const w = (Math.abs(r.value) / max) * (half - 18);
    const c = r.value >= 0 ? GREEN : PEAK;
    if (r.value >= 0) box(d, mid, d.y - 2.6, Math.max(0.8, w), 3.4, c, 1);
    else box(d, mid - Math.max(0.8, w), d.y - 2.6, Math.max(0.8, w), 3.4, c, 1);
    const t = `${r.value >= 0 ? '+' : '-'}€${Math.abs(Math.round(r.value)).toLocaleString('en-IE')}`;
    d.text(t, d.right, d.y, { face: 'helvetica', style: 'bold', size: 8.4, color: c, align: 'right' });
    d.y += r.sub ? 9 : 7;
  });
  d.stroke(RULE).weight(0.2);
}

export { INK, INK_MID, INK_SOFT, RULE, PAPER };
