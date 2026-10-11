// @ts-check
/**
 * The household picture on Profile: the house, its panels, battery, car, heat
 * pump and the grid, as a small model seen from above at an angle (11 Oct
 * 2026). The shapes are laid out in metres and projected, so edges line up and
 * each face is shaded by the way it faces. The picture before was drawn by
 * hand, line by line, and looked it.
 *
 * The figures beside each part come from the caller; this file only draws.
 */

const C30 = Math.cos(Math.PI / 6);
/** Light from above, a little to the front left. */
const LIGHT = unit([0.34, 0.56, 0.76]);

function unit(v){ const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; }
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const rgb = (c) => { const n = parseInt(c.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
/** a to b by t. */
function mix(a, b, t){
  const A = rgb(a), B = rgb(b);
  return '#' + A.map((x, i) => Math.round(x + (B[i] - x) * t).toString(16).padStart(2, '0')).join('');
}
/** The colour of a face of material m ([in shade, in light]) facing n. */
const tone = (m, n) => mix(m[0], m[1], Math.min(1, Math.max(0, (dot(n, LIGHT) - 0.2) / 0.6)));

const M = {
  ground: ['#0c252c', '#2c5862'],
  path: ['#16343b', '#3b6670'],
  wall: ['#8d8a82', '#f3efe6'],
  roof: ['#141f24', '#3a4c55'],
  panel: ['#0f2038', '#2d5b92'],
  door: ['#14323a', '#2d5864'],
  box: ['#7f9196', '#eef3f4'],
  car: ['#173f3f', '#5fae98'],
  glass: ['#0d1c22', '#294652'],
  tyre: ['#081418', '#14272d'],
};

/**
 * The picture.
 *
 * @param {{ solar: boolean, planned: boolean, panels: number, battery: boolean, ev: boolean, heatPump: boolean,
 *   flows: { sun: boolean, buy: boolean, sell: boolean, battery: boolean, ev: boolean },
 *   labels: { solar?: string[], grid: string[], battery?: string[], home: string[], ev?: string[] },
 *   taps: { system: string, home: string, grid: string, ev: string } }} d
 *   Each label is [heading, figure, line under it]; each tap the click handler.
 */
export function houseScene(d){
  const W = 14.6, D = 9.6;
  const s = 15.6, ox = 16 + D * C30 * s, oy = 104;
  /** Where a point in metres lands on the picture. */
  const P = (x, y, z) => [ox + (x - y) * C30 * s, oy + (x + y) * 0.5 * s - z * s];
  const pts = (list) => list.map((q) => P(q[0], q[1], q[2]).map((v) => v.toFixed(1)).join(',')).join(' ');
  const poly = (list, fill, extra = '') => `<polygon points="${pts(list)}" fill="${fill}" stroke="${fill}" stroke-width=".5" stroke-linejoin="round"${extra}/>`;
  /** A flat shape lying on a face whose way out is n. */
  const on = (list, m, n, extra) => poly(list, typeof m === 'string' ? m : tone(m, n), extra);

  /**
   * A solid: the outline `prof`, anticlockwise in (y, z) when it runs along x
   * or in (x, z) when it runs along y, from a to b. Only the faces that can be
   * seen are drawn, nearest last. `mats` can give an edge of the outline its
   * own material (the car's windscreen).
   */
  function solid(prof, along, a, b, m, mats = {}){
    const at = along === 'x' ? (p, w) => [w, p[0], p[1]] : (p, w) => [p[0], w, p[1]];
    const faces = [];
    const cap = (w, sign) => faces.push({ list: prof.map((p) => at(p, w)), n: along === 'x' ? [sign, 0, 0] : [0, sign, 0], m });
    cap(a, -1); cap(b, 1);
    prof.forEach((p, i) => {
      const q = prof[(i + 1) % prof.length], du = q[0] - p[0], dv = q[1] - p[1];
      faces.push({ list: [at(p, a), at(q, a), at(q, b), at(p, b)], n: unit(along === 'x' ? [0, dv, -du] : [dv, 0, -du]), m: mats[i] || m });
    });
    const mid = (l) => l.reduce((t, q) => t + q[0] + q[1] + q[2], 0) / l.length;
    return faces.filter((f) => f.n[0] + f.n[1] + f.n[2] > 1e-6).sort((f, g) => mid(f.list) - mid(g.list))
      .map((f) => poly(f.list, tone(f.m, f.n))).join('');
  }
  const box = (x0, x1, y0, y1, z0, z1, m) => solid([[y0, z0], [y1, z0], [y1, z1], [y0, z1]], 'x', x0, x1, m);
  /** A circle of radius r about c, in the plane of u and v. */
  const ring = (c, u, v, r, k = 28) => Array.from({ length: k }, (_, i) => {
    const t = (i / k) * Math.PI * 2;
    return [c[0] + r * (Math.cos(t) * u[0] + Math.sin(t) * v[0]), c[1] + r * (Math.cos(t) * u[1] + Math.sin(t) * v[1]), c[2] + r * (Math.cos(t) * u[2] + Math.sin(t) * v[2])];
  });
  const line = (a, b) => { const p = P(a[0], a[1], a[2]), q = P(b[0], b[1], b[2]); return `M${p[0].toFixed(1)} ${p[1].toFixed(1)}L${q[0].toFixed(1)} ${q[1].toFixed(1)}`; };
  /** A wire hanging from a to b. */
  const wire = (a, b, sag) => { const p = P(a[0], a[1], a[2]), q = P(b[0], b[1], b[2]);
    return `M${p[0].toFixed(1)} ${p[1].toFixed(1)}Q${((p[0] + q[0]) / 2).toFixed(1)} ${((p[1] + q[1]) / 2 + sag).toFixed(1)} ${q[0].toFixed(1)} ${q[1].toFixed(1)}`; };
  const route = (list) => list.map((q, i) => { const p = P(q[0], q[1], q[2]); return `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`; }).join('');
  /** The box the points take up on the picture, for a tap target. */
  const extent = (list, pad = 4) => { const ps = list.map((q) => P(q[0], q[1], q[2])); const xs = ps.map((p) => p[0]), ys = ps.map((p) => p[1]);
    return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) - Math.min(...xs) + 2 * pad, Math.max(...ys) - Math.min(...ys) + 2 * pad]; };
  const corners = (x0, x1, y0, y1, z0, z1) => [[x0, y0, z0], [x1, y0, z0], [x0, y1, z0], [x1, y1, z0], [x0, y0, z1], [x1, y0, z1], [x0, y1, z1], [x1, y1, z1]];

  // The house: a bungalow with its long wall to the front left and its gable to the front right.
  const hx0 = 3.0, hx1 = 9.2, hy0 = 1.4, hy1 = 6.2, eave = 3.0, ridge = 5.0, ry = (hy0 + hy1) / 2, k = (ridge - eave) / (ry - hy0);
  const roofZ = (y) => ridge + 0.22 - k * Math.abs(y - ry);

  const out = [];
  // Ground.
  out.push(box(0, W, 0, D, -0.5, 0, M.ground));
  out.push(on([[5.55, hy1, 0], [6.55, hy1, 0], [6.55, D, 0], [5.55, D, 0]], M.path, [0, 0, 1]));
  out.push(on([[hx1, 5.0, 0], [W, 5.0, 0], [W, 8.0, 0], [hx1, 8.0, 0]], M.path, [0, 0, 1]));

  // Shadows where things meet the ground.
  const shade = (x0, x1, y0, y1, g = 0.3) => `<polygon class="hs-shadow" points="${pts([[x0 - g, y0 - g, 0], [x1 + g, y0 - g, 0], [x1 + g, y1 + g, 0], [x0 - g, y1 + g, 0]])}"/>`;

  // The grid: a pylon on the left with two wires to the house.
  const px = 1.3, py = 7.9, top = 6.0, arm = 5.0, lb = 0.6, lt = 0.13;
  const legs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const at = (z) => { const w = lb + (lt - lb) * (z / top); return legs.map(([a, b]) => [px + a * w, py + b * w, z]); };
  const lv = [0, 1.5, 2.8, 4.0, arm, top];
  let lattice = '';
  legs.forEach((_, i) => { lattice += line(at(0)[i], [px + legs[i][0] * lt, py + legs[i][1] * lt, top]); });
  lv.forEach((z, j) => { const r = at(z); r.forEach((q, i) => { lattice += line(q, r[(i + 1) % 4]); });
    if (j) { const r0 = at(lv[j - 1]); [[0, 1], [3, 0]].forEach(([i, i2]) => { lattice += line(r0[i], r[i2]) + line(r0[i2], r[i]); }); } });
  const tipA = [px, py - 1.5, arm], tipB = [px, py + 1.5, arm];
  lattice += line(tipA, tipB) + line([px, py, top], [px, py, top + 0.7]) + line([px, py - 0.25, top], tipA) + line([px, py + 0.25, top], tipB);
  const pylon = `<path class="hs-pylon" d="${lattice}"/>`;
  const pylonFeet = shade(px - lb, px + lb, py - lb, py + lb, 0.15);
  const dropA = [hx0 + 0.3, hy1, eave - 0.25], dropB = [hx0 + 0.75, hy1, eave - 0.25];

  // The house, its roof and what is on them.
  const body = solid([[hy0, 0], [hy1, 0], [hy1, eave], [ry, ridge], [hy0, eave]], 'x', hx0, hx1, M.wall);
  const front = [0, 1, 0], side = [1, 0, 0], roofN = unit([0, k, 1]);
  const win = (x0, x1, z0, z1) => {
    const f = 0.09, y = hy1 + 0.01;
    return on([[x0 - f, y, z0 - f], [x1 + f, y, z0 - f], [x1 + f, y, z1 + f], [x0 - f, y, z1 + f]], M.door, front)
      + on([[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]], 'url(#hs-glow)', front)
      + `<path class="hs-mull" d="${line([(x0 + x1) / 2, y, z0], [(x0 + x1) / 2, y, z1])}${line([x0, y, (z0 + z1) / 2 + 0.1], [x1, y, (z0 + z1) / 2 + 0.1])}"/>`;
  };
  const sideWin = (y0, y1, z0, z1) => {
    const f = 0.09, x = hx1 + 0.01;
    return on([[x, y0 - f, z0 - f], [x, y1 + f, z0 - f], [x, y1 + f, z1 + f], [x, y0 - f, z1 + f]], M.door, side)
      + on([[x, y0, z0], [x, y1, z0], [x, y1, z1], [x, y0, z1]], 'url(#hs-glow)', side, ' opacity=".8"')
      + `<path class="hs-mull" d="${line([x, (y0 + y1) / 2, z0], [x, (y0 + y1) / 2, z1])}"/>`;
  };
  const walls = body
    + win(3.55, 4.85, 1.3, 2.3) + win(7.35, 8.65, 1.3, 2.3)
    + on([[5.6, hy1 + 0.01, 0], [6.5, hy1 + 0.01, 0], [6.5, hy1 + 0.01, 2.15], [5.6, hy1 + 0.01, 2.15]], M.door, front)
    + `<circle cx="${P(6.38, hy1, 1.05)[0].toFixed(1)}" cy="${P(6.38, hy1, 1.05)[1].toFixed(1)}" r="1.1" fill="#ffd166"/>`
    + sideWin(3.3, 4.5, 1.3, 2.3);
  const roof = solid([[hy0 - 0.45, eave - 0.375], [ry, ridge], [hy1 + 0.45, eave - 0.375], [hy1 + 0.45, eave - 0.155], [ry, ridge + 0.22], [hy0 - 0.45, eave - 0.155]],
    'x', hx0 - 0.4, hx1 + 0.4, M.roof);

  let panels = '';
  const n = d.solar ? Math.min(18, Math.max(1, Math.round(d.panels) || 1)) : 0;
  if (n){
    const rows = Math.min(3, Math.ceil(n / 6)), cols = Math.ceil(n / rows), gap = 0.1;
    const xa = hx0 + 0.25, xb = hx1 - 0.25, ya = ry + 0.3, yb = hy1 + 0.2;
    const cw = (xb - xa - gap * (cols - 1)) / cols, ch = (yb - ya - gap * (rows - 1)) / rows;
    const lift = (x, y) => [x, y, roofZ(y) + 0.04];
    for (let i = 0; i < n; i++){
      const r = Math.floor(i / cols), c = i % cols;
      const x0 = xa + c * (cw + gap), x1 = x0 + cw, y0 = ya + r * (ch + gap), y1 = y0 + ch;
      const q = [lift(x0, y0), lift(x1, y0), lift(x1, y1), lift(x0, y1)];
      panels += on(q, M.panel, roofN, d.planned ? ' class="hs-panel is-planned"' : ' class="hs-panel"');
      const ln = [1, 2].map((j) => line(lift(x0 + (cw * j) / 3, y0), lift(x0 + (cw * j) / 3, y1))).join('') + line(lift(x0, (y0 + y1) / 2), lift(x1, (y0 + y1) / 2));
      panels += `<path class="hs-cells" d="${ln}"/>`;
    }
  }

  // Heat pump under the left window.
  const hp = d.heatPump ? box(3.5, 4.75, hy1 + 0.15, hy1 + 0.6, 0, 0.88, M.box)
    + on(ring([4.12, hy1 + 0.61, 0.44], [1, 0, 0], [0, 0, 1], 0.3), '#1d3940', front)
    + `<path class="hs-fan" d="${line([3.9, hy1 + 0.62, 0.44], [4.34, hy1 + 0.62, 0.44])}${line([4.12, hy1 + 0.62, 0.22], [4.12, hy1 + 0.62, 0.66])}"/>` : '';

  // Battery beside the gable, with how full it is in gold.
  const bx0 = hx1 + 0.75, bx1 = bx0 + 0.5, by0 = 1.75, by1 = 2.95, bz = 1.95;
  const battery = d.battery ? box(bx0, bx1, by0, by1, 0, bz, M.box)
    + on([[bx1 + 0.01, by0 + 0.22, 0.25], [bx1 + 0.01, by1 - 0.22, 0.25], [bx1 + 0.01, by1 - 0.22, bz - 0.3], [bx1 + 0.01, by0 + 0.22, bz - 0.3]], '#2b3f45', side)
    + on([[bx1 + 0.02, by0 + 0.3, 0.33], [bx1 + 0.02, by1 - 0.3, 0.33], [bx1 + 0.02, by1 - 0.3, 1.2], [bx1 + 0.02, by0 + 0.3, 1.2]], '#ffd166', side, ' class="hs-level"') : '';

  // The car on the drive, with its charger on the gable.
  const cx0 = 10.4, cy0 = 5.75, cy1 = 7.5;
  const carProf = [[0, 0.3], [3.85, 0.3], [3.9, 0.62], [3.65, 0.8], [2.65, 0.88], [2.0, 1.34], [0.9, 1.34], [0.28, 0.92], [0, 0.8]].map(([u, v]) => [cx0 + u, v]);
  const wheel = (u) => on(ring([cx0 + u, cy1 + 0.01, 0.33], [1, 0, 0], [0, 0, 1], 0.33), M.tyre, front) + on(ring([cx0 + u, cy1 + 0.02, 0.33], [1, 0, 0], [0, 0, 1], 0.15), '#7f9196', front);
  const car = d.ev ? solid(carProf, 'y', cy0, cy1, M.car, { 4: M.glass, 6: M.glass })
    + on([[cx0 + 2.5, cy1 + 0.01, 0.94], [cx0 + 1.95, cy1 + 0.01, 1.26], [cx0 + 0.95, cy1 + 0.01, 1.26], [cx0 + 0.45, cy1 + 0.01, 0.94]], M.glass, front)
    + wheel(0.85) + wheel(3.05) : '';
  const charger = d.ev ? box(hx1, hx1 + 0.16, 5.3, 5.72, 0.85, 1.5, M.box) : '';

  // Energy moving: sun to the panels, the grid both ways, the house to the battery and the car.
  const sun = [188, 30];
  const flows = [];
  if (d.solar && d.flows.sun){ const p = P((hx0 + hx1) / 2, ry + 1.2, roofZ(ry + 1.2)); flows.push(`<path class="hs-flow hs-flow-sun" d="M${sun[0] - 3} ${sun[1] + 16}L${p[0].toFixed(1)} ${p[1].toFixed(1)}"/>`); }
  if (d.flows.buy) flows.push(`<path class="hs-flow hs-flow-in" d="${wire(tipA, dropA, 10)}"/>`);
  if (d.flows.sell) flows.push(`<path class="hs-flow hs-flow-out" d="${wire(dropB, tipB, 12)}"/>`);
  const wires = `<path class="hs-wire" d="${wire(tipA, dropA, 10)}${d.flows.sell ? wire(tipB, dropB, 12) : ''}"/>`;
  if (d.battery && d.flows.battery) flows.push(`<path class="hs-flow hs-flow-batt" d="${route([[hx1, 2.35, 0.9], [bx0, 2.35, 0.9]])}"/>`);
  if (d.ev && d.flows.ev) flows.push(`<path class="hs-flow hs-flow-ev" d="${route([[hx1 + 0.16, 5.51, 0.95], [hx1 + 0.5, 5.51, 0.15], [cx0 + 0.3, 5.51, 0.15], [cx0 + 0.3, cy0, 0.55]])}"/>`);

  // Back to front. The pylon stands left of the house, in front of nothing.
  out.push(shade(hx0, hx1, hy0, hy1, 0.35), d.battery ? shade(bx0, bx1, by0, by1, 0.18) : '', d.heatPump ? shade(3.5, 4.75, hy1 + 0.15, hy1 + 0.6, 0.15) : '',
    d.ev ? shade(cx0 + 0.1, cx0 + 3.8, cy0 + 0.05, cy1 - 0.05, 0.12) : '', pylonFeet);
  out.push(walls, roof, panels, battery, hp, charger, car, wires, pylon, flows.join(''));

  // The words: heading, figure, line under it.
  const label = (x, y, anchor, l, cls = '') => l ? `<text class="hs-label ${cls}" x="${x}" y="${y}" text-anchor="${anchor}">`
    + `<tspan class="hs-k" x="${x}">${l[0]}</tspan><tspan class="hs-val" x="${x}" dy="19">${l[1]}</tspan>`
    + (l[2] ? `<tspan class="hs-sub" x="${x}" dy="17">${l[2]}</tspan>` : '') + `</text>` : '';
  const words = [
    label(14, 22, 'start', d.labels.grid),
    d.solar ? label(346, 22, 'end', d.labels.solar) : '',
    label(14, 278, 'start', d.labels.home),
    d.battery ? label(348, 98, 'end', d.labels.battery) : '',
    d.ev ? label(346, 278, 'end', d.labels.ev) : '',
  ].join('');

  const act = (go, name) => `onclick="${go}" role="button" tabindex="0" aria-label="${name}"><title>${name}</title>`;
  const hit = (go, name, r) => `<rect class="hs-hit" x="${r[0].toFixed(0)}" y="${r[1].toFixed(0)}" width="${r[2].toFixed(0)}" height="${r[3].toFixed(0)}" rx="10" ${act(go, name)}</rect>`;
  /** The outline round some points, for a tap target the shape of what it opens. */
  const outline = (go, name, list) => {
    const ps = list.map((q) => P(q[0], q[1], q[2])).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const turn = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const half = (arr) => arr.reduce((h, p) => { while (h.length > 1 && turn(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop(); h.push(p); return h; }, []);
    const lo = half(ps), up = half(ps.slice().reverse());
    const hull = lo.slice(0, -1).concat(up.slice(0, -1));
    return `<polygon class="hs-hit" points="${hull.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ')}" ${act(go, name)}</polygon>`;
  };
  const roofPts = [[hx0 - 0.4, hy0 - 0.45, eave - 0.375], [hx1 + 0.4, hy0 - 0.45, eave - 0.375], [hx0 - 0.4, ry, ridge + 0.22], [hx1 + 0.4, ry, ridge + 0.22],
    [hx0 - 0.4, hy1 + 0.45, eave - 0.375], [hx1 + 0.4, hy1 + 0.45, eave - 0.375]];
  const taps = [
    outline(d.taps.home, 'My home', [...corners(hx0, hx1, hy0, hy1, 0, eave), [hx1, ry, ridge]]),
    outline(d.taps.system, 'My system', roofPts),
    d.heatPump ? hit(d.taps.home, 'Heat pump', extent(corners(3.5, 4.75, hy1 + 0.15, hy1 + 0.6, 0, 0.88), 3)) : '',
    hit(d.taps.grid, 'Your plan and the grid', extent([...at(0), [px, py, top + 0.7], tipA, tipB])),
    d.battery ? hit(d.taps.system, 'Battery', extent(corners(bx0, bx1, by0, by1, 0, bz))) : '',
    d.ev ? hit(d.taps.ev, 'Your EV', extent(carProf.flatMap(([x, z]) => [[x, cy0, z], [x, cy1, z]]))) : '',
  ].join('');

  return `<svg class="hs-svg" viewBox="0 0 360 322" role="group" aria-label="Tap a part of the house to change it">
    <defs>
      <linearGradient id="hs-glow" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe6a3"/><stop offset="1" stop-color="#f2b84b"/></linearGradient>
      <filter id="hs-soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2.4"/></filter>
      <radialGradient id="hs-halo"><stop offset="0" stop-color="#ffd166" stop-opacity=".45"/><stop offset="1" stop-color="#ffd166" stop-opacity="0"/></radialGradient>
    </defs>
    ${d.solar ? `<circle cx="${sun[0]}" cy="${sun[1]}" r="34" fill="url(#hs-halo)"/><circle class="hs-sun" cx="${sun[0]}" cy="${sun[1]}" r="12"/>` : ''}
    ${out.join('')}
    ${words}
    ${taps}
  </svg>`;
}
