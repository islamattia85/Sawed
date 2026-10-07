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
/** Euros, rounded. A negative amount (money coming in) reads −€230, never €-230. */
export const eur = (v) => { const n = Math.round(v || 0); return `${n < 0 ? '−' : ''}€${Math.abs(n).toLocaleString('en-IE')}`; };

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
    role="group" aria-label="Usage by time of day">${arcs}</svg>`;
}

/* ------------------------------------------------------------------
   V7 objects. Same rules as above: pure, token colours, exact figures
   carried in data-* and <title>.
   ------------------------------------------------------------------ */

/**
 * The answer as a ladder: what the home pays today, what it would pay on the
 * best plan with nothing else changed, and what it pays with the solar and
 * battery added.
 *
 * This exists because a single "you could save" figure merged two different
 * decisions. Switching supplier is free and takes ten minutes; solar is a
 * five-figure purchase. A reader has to see how much of the saving is which
 * before they can act on either.
 *
 * @param {{rungs:{label:string,value:number,token:string,note?:string}[], width?:number}} o
 */
export function savingsLadder({ rungs = [] } = {}) {
  const items = rungs.filter((r) => r && Number.isFinite(r.value));
  if (!items.length) return '';
  const max = Math.max(1, ...items.map((r) => Math.max(0, r.value)));
  // Plain rows, not SVG text: a full plan name has to be able to wrap.
  const rows = items.map((r, i) => {
    const w = Math.max(1, (Math.max(0, r.value) / max) * 100);
    return `<div class="lad-row" data-rung="${i}" data-label="${esc(r.label)}" data-value="${n(r.value)}" title="${esc(r.label)}: ${eur(r.value)}/yr">
      <span class="lad-k">${esc(r.label)}</span><b class="lad-v">${eur(r.value)}</b>
      <i class="lad-t"><i style="width:${n(w)}%;background:var(${r.token})"></i></i></div>`;
  }).join('');
  return `<div class="v7-ladder" role="group" aria-label="Your yearly bill, step by step">${rows}</div>`;
}

/**
 * A plan's 24 hours as one strip, each hour coloured by its rate band.
 * The shape of a tariff, readable before any rate is.
 *
 * @param {{bands:string[], rates?:Record<string,number>, width?:number, height?:number}} o
 */
export function rateStrip({ bands = [], rates = {}, width = 320, height = 20 } = {}) {
  if (!bands.length) return '';
  const cw = width / bands.length;
  const tok = { day: '--bandink-day', night: '--bandink-night', peak: '--bandink-peak', ev: '--bandink-ev', wfh: '--bandink-wfh' };
  const cells = bands.map((b, h) => `<rect x="${n(h * cw)}" y="0" width="${n(cw) + 0.3}" height="${height}"
    fill="var(${tok[b] || '--bandink-day'})" data-hour="${h}" data-band="${esc(b)}"><title>${String(h).padStart(2, '0')}:00 · ${esc(b)}${
      Number.isFinite(rates[b]) ? ` · ${n(rates[b] * 100)}c/kWh` : ''}</title></rect>`).join('');
  return `<svg class="v7-ratestrip" viewBox="0 0 ${width} ${height}" width="100%" height="${height}"
    preserveAspectRatio="none" role="img" aria-label="Rate band by hour">
    <defs><clipPath id="rs-clip"><rect width="${width}" height="${height}" rx="4"/></clipPath></defs>
    <g clip-path="url(#rs-clip)">${cells}</g></svg>`;
}

/**
 * A score out of 100 as a ring. The number sits in the middle, so the ring
 * adds the one thing the number cannot: how far there is still to go.
 *
 * @param {{value:number, size?:number, token?:string}} o
 */
export function scoreRing({ value = 0, size = 88, token = '--accent' } = {}) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  const r = size / 2 - 6;
  const c = 2 * Math.PI * r;
  const dash = (v / 100) * c;
  return `<svg class="v7-ring" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"
    role="img" aria-label="Score ${Math.round(v)} of 100" data-value="${Math.round(v)}">
    <circle cx="${size / 2}" cy="${size / 2}" r="${n(r)}" fill="none" stroke="var(--track-soft)" stroke-width="8"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${n(r)}" fill="none" stroke="var(${token})" stroke-width="8"
      stroke-linecap="round" stroke-dasharray="${n(dash)} ${n(c)}"
      transform="rotate(-90 ${size / 2} ${size / 2})"/>
    <text x="50%" y="50%" dy="0.35em" text-anchor="middle" font-size="${size < 64 ? 13 : 25}" font-weight="700"
      fill="var(--ink)">${Math.round(v)}</text>
  </svg>`;
}

/**
 * Twelve months, two series side by side — what the panels make against what
 * the home uses. Winter's gap is the whole case for a battery or a night rate.
 *
 * @param {{a:number[], b:number[], tokenA?:string, tokenB?:string, width?:number, height?:number}} o
 */
export function monthBars({ a = [], b = [], tokenA = '--accent', tokenB = '--ink-dim', width = 320, height = 110 } = {}) {
  const months = Math.max(a.length, b.length);
  if (!months) return '';
  const pad = 14;
  const plot = height - pad;
  const max = Math.max(0.001, ...a, ...b);
  const slot = width / months;
  const bw = slot * 0.34;
  const L = 'JFMAMJJASOND';
  const bars = Array.from({ length: months }, (_, i) => {
    const ha = ((a[i] || 0) / max) * plot;
    const hb = ((b[i] || 0) / max) * plot;
    const x = i * slot + slot / 2;
    return `<g data-month="${i}" data-a="${n(a[i])}" data-b="${n(b[i])}">
      <title>Month ${i + 1}: ${Math.round(a[i] || 0)} / ${Math.round(b[i] || 0)} kWh</title>
      <rect x="${n(x - bw - 1)}" y="${n(plot - ha)}" width="${n(bw)}" height="${n(ha)}" rx="2" fill="var(${tokenA})"/>
      <rect x="${n(x + 1)}" y="${n(plot - hb)}" width="${n(bw)}" height="${n(hb)}" rx="2" fill="var(${tokenB})"/>
      <text x="${n(x)}" y="${height - 2}" font-size="10" text-anchor="middle" fill="var(--ink-dim)">${L[i] || ''}</text>
    </g>`;
  }).join('');
  return `<svg class="v7-months" viewBox="0 0 ${width} ${height}" width="100%" height="${height}"
    role="group" aria-label="Month by month">${bars}</svg>`;
}
