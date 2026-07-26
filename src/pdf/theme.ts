/**
 * Design tokens for the PDF report.
 *
 * The report previously picked colours ad hoc at each call site, which is why
 * amber meant "exported to grid" on one page and "January" on another. Colour
 * here is defined by ROLE, not by hue, so a reader can learn the language once
 * and it holds across all pages.
 */

export type Rgb = readonly [number, number, number];

/** Page geometry, millimetres. A4 portrait. */
export const PAGE = {
  width: 210,
  height: 297,
  margin: 16,
  /** Content width between margins. */
  get contentWidth() { return this.width - this.margin * 2; },
  /** Y below which content must not extend before breaking to a new page. */
  get bottomLimit() { return this.height - 20; },
} as const;

/**
 * Semantic palette. Each entry states what it MEANS, so charts, tiles and
 * tables stay legible together.
 */
export const C = {
  /** Body text. */
  ink: [17, 26, 20] as Rgb,
  /** Secondary text: labels, captions. */
  inkSoft: [104, 120, 110] as Rgb,
  /** Tertiary text: footnotes, axis ticks. Still AA on white at 7pt+. */
  inkDim: [140, 154, 145] as Rgb,
  /** Page background accents and table zebra. */
  wash: [246, 249, 247] as Rgb,
  /** Hairline rules. */
  rule: [219, 228, 222] as Rgb,

  /** MONEY THE READER GAINS — savings, profit, the recommended plan. */
  gain: [0, 138, 62] as Rgb,
  gainSoft: [226, 246, 233] as Rgb,

  /** MONEY THE READER SPENDS — current cost, install cost, grid import. */
  cost: [186, 61, 46] as Rgb,
  costSoft: [253, 235, 232] as Rgb,

  /** ENERGY THE READER USES — consumption, load, self-consumption. */
  use: [21, 101, 174] as Rgb,
  useSoft: [227, 238, 249] as Rgb,

  /** ENERGY THE READER SELLS — export to grid. */
  sell: [176, 116, 20] as Rgb,
  sellSoft: [252, 243, 224] as Rgb,

  /** Structural: section header bands. */
  band: [16, 26, 20] as Rgb,
  paper: [255, 255, 255] as Rgb,
} as const;

/**
 * Type scale, points. Deliberately few sizes — the old report used a dozen
 * near-identical sizes, which reads as noise rather than hierarchy.
 */
export const T = {
  /** Cover figure. */
  display: 30,
  /** Page/section title. */
  title: 13,
  /** Prominent number inside a tile. */
  figure: 15,
  /** Body copy. */
  body: 9,
  /** Table cells and dense rows. */
  dense: 8.2,
  /** Labels above figures, table headers. */
  label: 6.6,
  /** Footnotes, axis ticks, disclaimer. */
  micro: 6.2,
} as const;

/** Vertical rhythm, millimetres. */
export const S = {
  /** Between a label and the figure it describes. */
  tight: 2,
  /** Between rows in a list. */
  row: 5.4,
  /** Between a block and the next. */
  block: 7,
  /** Before a new section header. */
  section: 10,
} as const;

/** Line weights, millimetres. */
export const LW = {
  hairline: 0.2,
  rule: 0.4,
  accent: 0.7,
  chart: 0.9,
} as const;

/**
 * Where the report was generated. Read from the live host so the footer can
 * never go stale the way a hardcoded domain did — the old report still cited a
 * replit.app URL long after the app moved.
 */
export function reportOrigin(): string {
  try {
    const h = globalThis.location?.hostname;
    if (h && h !== 'localhost' && !h.startsWith('127.')) return h.replace(/^www\./, '');
  } catch { /* non-browser context */ }
  // Empty rather than the brand name: the footer already says "Solar
  // Optimiser", and a fallback of the same string printed it twice.
  return '';
}
