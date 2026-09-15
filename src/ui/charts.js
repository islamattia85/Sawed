/**
 * The V6 data objects.
 *
 * V3 computes 8,760 hours × ten series per scenario and then renders almost all
 * of it as prose: the whole app carried twelve SVG elements. Nothing here
 * changes a single figure — these are pure encoders that take the numbers the
 * engine already produces and draw them, so the reader sees a shape instead of
 * a paragraph.
 *
 * Rules these obey, because the design tests enforce them:
 *   * colour comes from CSS custom properties, never a hex literal, so the
 *     objects follow the theme;
 *   * text drawn inside SVG stays at or above the 10px tick floor;
 *   * every function is pure and deterministic — same input, same markup — so
 *     it can be tested without a browser.
 *
 * Every object carries its exact figures in `data-*` attributes and a <title>,
 * so nothing is lost by drawing it: the number is always one tap away.
 */

/** Numbers that are safe to put in markup. */
const n = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Money to the euro, the way the app talks about money. */
export const eur = (v) => `€${Math.round(v || 0).toLocaleString('en-IE')}`;

/**
 * Where a year's money goes, as one stacked bar.
 *
 * Replaces the savings-breakdown paragraphs: the reader sees the standing
 * charge's real share, which band dominates, what export credit claws back, and
 * — when a rise has been announced — the slice it will add.
 *
 * @param {{segments: {label:string, value:number, token:string}[], width?:number, height?:number}} o
 */
export function moneyBar({ segments = [], width = 320, height = 46 } = {}) {
  const items = segments.filter((s) => s && Math.abs(s.value) > 0.005);
  const total = items.reduce((a, s) => a + Math.abs(s.value), 0);
  if (!total) return '';
  const r = 8;
  let x = 0;
  const parts = items.map((s) => {
    const w = (Math.abs(s.value) / total) * width;
    const seg = `<rect x="${n(x)}" y="0" width="${n(w)}" height="${height}"
      fill="var(${s.token})" data-label="${esc(s.label)}" data-value="${n(s.value)}"
      tabindex="0" role="img"><title>${esc(s.label)}: ${eur(s.value)}</title></rect>`;
    x += w;
    return seg;
  }).join('');
  return `<svg class="v6-moneybar" viewBox="0 0 ${width} ${height}" width="100%" height="${height}"
    preserveAspectRatio="none" role="group" aria-label="Annual cost breakdown">
    <defs><clipPath id="mb-clip"><rect x="0" y="0" width="${width}" height="${height}" rx="${r}"/></clipPath></defs>
    <g clip-path="url(#mb-clip)">${parts}</g>
  </svg>`;
}

/**
 * One day, hour by hour: what the home used, what the sun made, what came off
 * the grid — drawn against the tariff bands behind it.
 *
 * This is the object that makes a time-of-use plan legible. A reader can see
 * their evening peak land inside the expensive band without being told.
 *
 * @param {{hours: {cons:number, gen:number, imp:number, band:string}[], width?:number, height?:number}} o
 */
export function dayProfile({ hours = [], width = 320, height = 132 } = {}) {
  if (!hours.length) return '';
  const pad = 16;
  const plot = height - pad;
  const bw = width / hours.length;
  const peak = Math.max(0.001, ...hours.map((h) => Math.max(h.cons || 0, h.gen || 0)));
  const bandToken = {
    peak: '--band-peak', night: '--band-night', ev: '--band-ev',
    wfh: '--band-wfh', day: '--band-day',
  };

  const bands = hours.map((h, i) => `<rect x="${n(i * bw)}" y="0" width="${n(bw) + 0.5}"
    height="${plot}" fill="var(${bandToken[h.band] || '--band-day'})" opacity="0.5"/>`).join('');

  const bars = hours.map((h, i) => {
    const ch = ((h.cons || 0) / peak) * plot;
    const gh = ((h.gen || 0) / peak) * plot;
    return `<g data-hour="${i}" data-cons="${n(h.cons)}" data-gen="${n(h.gen)}"
      data-import="${n(h.imp)}" data-band="${esc(h.band)}" tabindex="0">
      <title>${String(i).padStart(2, '0')}:00 · used ${n(h.cons)} kWh · solar ${n(h.gen)} kWh · ${esc(h.band)}</title>
      <rect x="${n(i * bw + bw * 0.15)}" y="${n(plot - ch)}" width="${n(bw * 0.7)}" height="${n(ch)}"
        fill="var(--ink-soft)" rx="1"/>
      ${gh > 0.5 ? `<rect x="${n(i * bw + bw * 0.15)}" y="${n(plot - gh)}" width="${n(bw * 0.7)}"
        height="${n(gh)}" fill="var(--accent)" opacity="0.85" rx="1"/>` : ''}
    </g>`;
  }).join('');

  const ticks = [0, 6, 12, 18].map((h) =>
    `<text x="${n(h * bw + bw / 2)}" y="${height - 4}" font-size="10" text-anchor="middle"
      fill="var(--ink-dim)">${String(h).padStart(2, '0')}</text>`).join('');

  return `<svg class="v6-dayprofile" viewBox="0 0 ${width} ${height}" width="100%" height="${height}"
    role="group" aria-label="Hour by hour for one day">
    ${bands}${bars}${ticks}
  </svg>`;
}

/**
 * The whole year as one ribbon — a cell a day, darker where the day cost more.
 *
 * Seasonality stops being a sentence ("winter costs more") and becomes
 * something the reader can point at.
 *
 * @param {{days:number[], width?:number, height?:number}} o
 */
export function yearRibbon({ days = [], width = 320, height = 44 } = {}) {
  if (!days.length) return '';
  const cols = days.length;
  const cw = width / cols;
  const max = Math.max(0.001, ...days.map((d) => Math.abs(d || 0)));
  const cells = days.map((d, i) => {
    const o = Math.min(1, Math.abs(d || 0) / max);
    return `<rect x="${n(i * cw)}" y="0" width="${n(cw) + 0.4}" height="${height}"
      fill="var(--accent)" opacity="${n(0.08 + o * 0.92)}"
      data-day="${i}" data-value="${n(d)}"><title>Day ${i + 1}: ${eur(d)}</title></rect>`;
  }).join('');
  return `<svg class="v6-yearribbon" viewBox="0 0 ${width} ${height}" width="100%" height="${height}"
    preserveAspectRatio="none" role="group" aria-label="Cost across the year">${cells}</svg>`;
}

/**
 * Money over twenty years, crossing zero.
 *
 * The payback year stops being a number to trust and becomes the point where
 * the line crosses — with the depth of the dip (what is actually at risk) and
 * the final height (what it is worth) visible in the same glance.
 *
 * @param {{cumulative:number[], width?:number, height?:number}} o
 */
export function paybackCurve({ cumulative = [], width = 320, height = 120 } = {}) {
  if (cumulative.length < 2) return '';
  const pad = 14;
  const w = width - pad * 2;
  const h = height - pad * 2;
  const lo = Math.min(0, ...cumulative);
  const hi = Math.max(0, ...cumulative);
  const span = hi - lo || 1;
  const x = (i) => pad + (i / (cumulative.length - 1)) * w;
  const y = (v) => pad + (1 - (v - lo) / span) * h;

  const pts = cumulative.map((v, i) => `${n(x(i))},${n(y(v))}`).join(' ');
  const zeroY = n(y(0));
  // First year the running total turns positive — the payback point.
  let cross = -1;
  for (let i = 1; i < cumulative.length; i += 1) {
    if (cumulative[i - 1] < 0 && cumulative[i] >= 0) { cross = i; break; }
  }
  const marker = cross > 0
    ? `<circle cx="${n(x(cross))}" cy="${zeroY}" r="4" fill="var(--accent)"
        data-payback-year="${cross}"><title>Pays for itself in year ${cross}</title></circle>`
    : '';

  return `<svg class="v6-payback" viewBox="0 0 ${width} ${height}" width="100%" height="${height}"
    role="group" aria-label="Cumulative value over twenty years">
    <line x1="${pad}" y1="${zeroY}" x2="${width - pad}" y2="${zeroY}"
      stroke="var(--line)" stroke-width="1" stroke-dasharray="3 3"/>
    <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2"
      stroke-linejoin="round" stroke-linecap="round"/>
    ${marker}
    <text x="${pad}" y="${height - 2}" font-size="10" fill="var(--ink-dim)">year 0</text>
    <text x="${width - pad}" y="${height - 2}" font-size="10" text-anchor="end"
      fill="var(--ink-dim)">year ${cumulative.length - 1}</text>
  </svg>`;
}

/**
 * Where the kilowatt-hours actually went, by tariff band.
 *
 * @param {{slices:{label:string,value:number,token:string}[], size?:number}} o
 */
export function bandDonut({ slices = [], size = 128 } = {}) {
  const items = slices.filter((s) => s && s.value > 0);
  const total = items.reduce((a, s) => a + s.value, 0);
  if (!total) return '';
  const r = size / 2;
  const ir = r * 0.62;
  let a0 = -Math.PI / 2;
  const arcs = items.map((s) => {
    const frac = s.value / total;
    const a1 = a0 + frac * Math.PI * 2;
    const big = frac > 0.5 ? 1 : 0;
    const p = (ang, rad) => `${n(r + rad * Math.cos(ang))},${n(r + rad * Math.sin(ang))}`;
    const d = `M ${p(a0, r)} A ${r} ${r} 0 ${big} 1 ${p(a1, r)}`
      + ` L ${p(a1, ir)} A ${ir} ${ir} 0 ${big} 0 ${p(a0, ir)} Z`;
    a0 = a1;
    return `<path d="${d}" fill="var(${s.token})" data-label="${esc(s.label)}"
      data-value="${n(s.value)}" tabindex="0"><title>${esc(s.label)}: ${Math.round(frac * 100)}%</title></path>`;
  }).join('');
  return `<svg class="v6-donut" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"
    role="group" aria-label="Usage by tariff band">${arcs}</svg>`;
}
