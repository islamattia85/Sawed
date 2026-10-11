/**
 * The product's name and mark, in one place. Rename the app here.
 */
export const BRAND = {
  name: 'Peakless',
  tagline: 'Every Irish electricity plan, priced on your home',
  ink: '#16343d',
  gold: '#ffd166',
  mist: '#5a7880',
  /** The wordmark is set in two weights: the peak, then what's left of it. */
  word: ['peak', 'less'],
} as const;

/**
 * The company that runs Peakless: the GDPR "controller", and the particulars
 * its website must show (Companies Act 2014, s.151(4)). Shown on every legal
 * page and in the website's footer (src/legal.js). Fill in the number,
 * office and email once the company is formed; a blank shows as "[… to be
 * added]", never as nothing.
 */
export const CONTROLLER = {
  name: 'Peakless Energy Limited',
  form: 'private company limited by shares',
  number: '',        // CRO number, given on incorporation
  address: '',       // registered office in Ireland
  email: '',         // privacy contact, e.g. privacy@peakless.ie once the domain is ours
  updated: '11 October 2026',
} as const;

/** The wordmark as markup. Styled by .pk-word in v7.css. */
export const wordmarkHtml = (cls = '') =>
  `<span class="pk-word ${cls}" aria-label="${BRAND.name}"><b>${BRAND.word[0]}</b><span>${BRAND.word[1]}</span></span>`;

/** The mark: the evening peak (dotted) flattened into one gold line. 24×24 viewBox. */
export const MARK_PATHS =
  '<path d="M3 16 C7 16 8 7 12 7 C16 7 17 16 21 16" fill="none" stroke-dasharray="1.4 2.4"/>' +
  '<path d="M3 16 H21" stroke-width="2.4"/>';

/** App icon as an SVG string (square, rounded), for favicons and the manifest. */
export function iconSvg(size = 512): string {
  const r = Math.round(size * 0.22);
  const s = size / 24;
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${size} ${size}'>` +
    `<rect width='${size}' height='${size}' rx='${r}' fill='${BRAND.ink}'/>` +
    `<g transform='translate(${size * 0.1} ${size * 0.06}) scale(${s * 0.8})' stroke-linecap='round' fill='none'>` +
    `<path d='M3 16 C7 16 8 7 12 7 C16 7 17 16 21 16' stroke='${BRAND.mist}' stroke-width='1.3' stroke-dasharray='1.4 2.4'/>` +
    `<path d='M3 16 H21' stroke='${BRAND.gold}' stroke-width='2'/></g></svg>`;
}

export const iconDataUri = (size = 512) => 'data:image/svg+xml,' + encodeURIComponent(iconSvg(size));
