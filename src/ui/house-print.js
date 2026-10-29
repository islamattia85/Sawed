// @ts-check
/**
 * The household picture for the PDF report: the app's own drawing, not a
 * second one (29 Oct 2026). The report used to draw a house of its own, flat
 * and nothing like the one on Profile.
 *
 * The picture is drawn by houseScene and styled by the app's own stylesheet,
 * then painted at print resolution on the dark card it sits on in the app. Its
 * words come back separately, so the report sets them as text in its copy of
 * the same typeface: an SVG painted as an image can't reach the page's fonts,
 * and words in a picture can't be searched or read aloud.
 */
import { houseScene } from './house.js';

/** What the stylesheet sets on the shapes, copied onto each one. */
const PAINT = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray',
  'stroke-linecap', 'stroke-linejoin', 'opacity', 'filter'];
/** The card round the picture, in the picture's units: its edge, and the line along its top. */
const PAD = 14, TOP = 26;

/** 'rgb(1, 2, 3)' as [1, 2, 3]. */
const rgb = (c) => (String(c).match(/\d+(\.\d+)?/g) || ['0', '0', '0']).slice(0, 3).map((v) => Math.round(+v));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

/**
 * @typedef {{ scene: Parameters<typeof houseScene>[0], title: string, badge: string }} Picture
 * @typedef {{ text: string, x: number, y: number, anchor: 'start'|'middle'|'end', size: number, weight: number, color: number[] }} Word
 */

/**
 * The picture as the app styles it, ready to paint: the card with the drawing
 * on it, and the words to set over it, in the picture's units (a CSS pixel on
 * Profile).
 *
 * @param {Picture} pic
 * @returns {{ svg: string, width: number, height: number, words: Word[] }}
 */
export function printMarkup(pic){
  const host = document.createElement('section');
  host.className = 'hs';
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:360px;padding:0;margin:0';
  host.innerHTML = `<div class="hs-top"><span>${esc(pic.title)} · a typical year</span><span class="hs-badge">${esc(pic.badge)}</span></div>`
    + houseScene(pic.scene);
  document.body.appendChild(host);
  try {
    const svg = /** @type {SVGSVGElement} */ (host.querySelector('svg'));
    const [, , w, h] = (svg.getAttribute('viewBox') || '0 0 360 322').split(/\s+/).map(Number);
    const W = w + 2 * PAD, H = h + 2 * PAD + TOP;
    const css = getComputedStyle(host);
    /** @type {Word[]} */
    const words = [];

    // The words, where the app puts them and as its stylesheet sets them.
    svg.querySelectorAll('text').forEach((t) => {
      const anchor = /** @type {Word['anchor']} */ (t.getAttribute('text-anchor') || 'start');
      let y = +(t.getAttribute('y') || 0);
      t.querySelectorAll('tspan').forEach((s) => {
        y += +(s.getAttribute('dy') || 0);
        const cs = getComputedStyle(s);
        words.push({ text: s.textContent || '', x: +(s.getAttribute('x') || 0) + PAD, y: y + PAD + TOP, anchor,
          size: parseFloat(cs.fontSize) || 12, weight: +cs.fontWeight || 400, color: rgb(cs.fill) });
      });
    });

    // The line along the top: what the picture is, and a badge.
    const [title, badge] = /** @type {HTMLElement[]} */ ([...host.querySelectorAll('.hs-top span')]);
    const tc = getComputedStyle(title), bc = getComputedStyle(badge);
    const badgeW = badge.getBoundingClientRect().width, badgeH = badge.getBoundingClientRect().height;
    const bx = PAD + w - 4 - badgeW, by = PAD + (TOP - badgeH) / 2 - 2, line = PAD + TOP / 2 + 2;
    words.unshift(
      { text: title.textContent || '', x: PAD + 4, y: line, anchor: 'start', size: parseFloat(tc.fontSize) || 12, weight: +tc.fontWeight || 400, color: rgb(tc.color) },
      { text: badge.textContent || '', x: bx + badgeW / 2, y: line, anchor: 'middle', size: parseFloat(bc.fontSize) || 12, weight: +bc.fontWeight || 700, color: rgb(bc.color) });

    // The drawing alone: no words, no tap targets, every shape carrying its own style.
    svg.querySelectorAll('.hs-hit, text, title').forEach((n) => n.remove());
    svg.querySelectorAll('*').forEach((n) => {
      if (n.closest('defs')) return;
      const cs = getComputedStyle(n);
      n.setAttribute('style', PAINT.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(';'));
      n.removeAttribute('class');
    });

    // The card behind it, as `.hs` paints it: the ink, warmed by gold at the
    // top right (its radial-gradient(90% 60% at 80% 0%, gold .12, transparent 60%)).
    const ink = css.backgroundColor, gold = css.getPropertyValue('--brand-gold').trim() || '#ffd166';
    const radius = parseFloat(css.borderTopLeftRadius) || 16;
    const at = (x, y) => `x="${x - PAD}" y="${y - PAD - TOP}"`;
    svg.insertAdjacentHTML('afterbegin', `<defs><radialGradient id="hs-card" cx=".8" cy="0" r=".9" gradientTransform="scale(1 .6667)">`
      + `<stop offset="0" stop-color="${gold}" stop-opacity=".12"/><stop offset=".6" stop-color="${gold}" stop-opacity="0"/></radialGradient></defs>`
      + `<g id="hs-card-back"><rect ${at(0, 0)} width="${W}" height="${H}" rx="${radius}" style="fill:${ink}"/>`
      + `<rect ${at(0, 0)} width="${W}" height="${H}" rx="${radius}" fill="url(#hs-card)"/>`
      + `<rect ${at(bx, by)} width="${badgeW}" height="${badgeH}" rx="${badgeH / 2}" style="fill:${bc.backgroundColor}"/></g>`);
    svg.setAttribute('viewBox', `${-PAD} ${-PAD - TOP} ${W} ${H}`);
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    for (const a of ['class', 'role', 'aria-label']) svg.removeAttribute(a);
    return { svg: new XMLSerializer().serializeToString(svg), width: W, height: H, words };
  } finally {
    host.remove();
  }
}

/**
 * The picture painted for the report: a JPEG of the card on white (the page
 * behind it), `scale` dots to the picture's unit, with the words to set over it.
 *
 * @param {Picture} pic
 */
export async function housePrint(pic, { scale = 4 } = {}){
  const m = printMarkup(pic);
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(m.svg);
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(m.width * scale);
  canvas.height = Math.round(m.height * scale);
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return { image: canvas.toDataURL('image/jpeg', 0.92), width: m.width, height: m.height, words: m.words };
}
