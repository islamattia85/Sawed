/**
 * Typographic and colour system for the report.
 *
 * The brief is a document, not a dashboard printed to paper. That means a
 * serif text face on a baseline grid, sans reserved for data and labels,
 * restrained colour, and generous margins — the conventions a reader already
 * associates with something worth keeping.
 */

export type Rgb = readonly [number, number, number];

/**
 * Page geometry, millimetres. Margins are asymmetric: the outer edge is wider
 * than the inner so a printed double-page spread reads correctly, and the head
 * carries a running title above the text block.
 */
export const PAGE = {
  width: 210,
  height: 297,
  marginTop: 26,
  marginBottom: 24,
  marginInner: 22,
  marginOuter: 22,
  /** Baseline of the running head. */
  headBaseline: 16,
  /** Baseline of the folio. */
  folioBaseline: 283,
};

export const TEXT_LEFT = PAGE.marginInner;
export const TEXT_RIGHT = PAGE.width - PAGE.marginOuter;
export const TEXT_WIDTH = TEXT_RIGHT - TEXT_LEFT;
/** Last baseline that may be occupied before a page must break. */
export const TEXT_BOTTOM = PAGE.height - PAGE.marginBottom;

/**
 * Vertical rhythm. Every advance is a multiple of this, so text on facing
 * pages aligns and the document never looks loosely set.
 */
export const BASELINE = 4.6;
export const lines = (n: number) => n * BASELINE;

/**
 * Type specimens. `face` picks the built-in font; Times is a genuine text
 * serif and costs nothing to embed, Helvetica carries figures and labels
 * where a reader wants to compare digits rather than read prose.
 */
export interface Spec {
  face: 'times' | 'helvetica';
  style: 'normal' | 'bold' | 'italic';
  size: number;
  /** Leading in millimetres for wrapped text. */
  leading: number;
  color?: Rgb;
  /** Letterspacing, points. Used sparingly, for small caps-ish labels. */
  tracking?: number;
}

export const INK: Rgb = [26, 26, 24];
export const INK_MID: Rgb = [92, 96, 92];
export const INK_SOFT: Rgb = [132, 136, 132];
export const INK_FAINT: Rgb = [176, 180, 176];
export const RULE: Rgb = [206, 208, 204];
export const RULE_SOFT: Rgb = [230, 231, 228];
export const PAPER: Rgb = [255, 255, 255];
export const TINT: Rgb = [246, 246, 243];

/** One accent, used only for the recommendation and money gained. */
export const ACCENT: Rgb = [0, 104, 56];
export const ACCENT_TINT: Rgb = [232, 242, 236];
/** Money leaving the reader. Muted, so it never shouts over the accent. */
export const DEBIT: Rgb = [150, 46, 34];
export const DEBIT_TINT: Rgb = [250, 238, 236];
/** Neutral data series, for charts that are not about money. */
export const SERIES: Rgb = [58, 82, 112];
export const SERIES_TINT: Rgb = [234, 239, 245];
export const SERIES_ALT: Rgb = [148, 118, 42];
export const SERIES_ALT_TINT: Rgb = [249, 243, 228];

export const TYPE: Record<string, Spec> = {
  /** Cover title. */
  coverTitle: { face: 'times', style: 'bold', size: 30, leading: lines(2.4) },
  coverSub: { face: 'times', style: 'italic', size: 12.5, leading: lines(1.4), color: INK_MID },
  /** The single headline figure. */
  coverFigure: { face: 'helvetica', style: 'bold', size: 42, leading: lines(3) },

  /** Part/chapter opener. */
  chapterNo: { face: 'helvetica', style: 'bold', size: 7.5, leading: lines(1), tracking: 0.9, color: ACCENT },
  chapter: { face: 'times', style: 'bold', size: 17, leading: lines(1.8) },
  /** Section within a chapter. */
  heading: { face: 'times', style: 'bold', size: 11, leading: lines(1.3) },
  /** Sub-heading / table caption. */
  subhead: { face: 'helvetica', style: 'bold', size: 7.4, leading: lines(1), tracking: 0.6, color: INK_MID },

  /** Running body text. */
  body: { face: 'times', style: 'normal', size: 9.8, leading: lines(1) },
  /** Opening paragraph of a chapter, set slightly larger. */
  lead: { face: 'times', style: 'normal', size: 11, leading: lines(1.2), color: INK },
  /** Marginal note and figure caption. */
  caption: { face: 'times', style: 'italic', size: 8.2, leading: lines(0.85), color: INK_MID },

  /** Table and figure data. */
  data: { face: 'helvetica', style: 'normal', size: 8.4, leading: lines(1) },
  dataBold: { face: 'helvetica', style: 'bold', size: 8.4, leading: lines(1) },
  /** Column heads. */
  tableHead: { face: 'helvetica', style: 'bold', size: 6.8, leading: lines(1), tracking: 0.5, color: INK_MID },
  /** Figures pulled out of the text. */
  figure: { face: 'helvetica', style: 'bold', size: 16, leading: lines(1.6) },
  figureSmall: { face: 'helvetica', style: 'bold', size: 11, leading: lines(1.2) },
  /** Axis ticks, footnotes, folios. */
  micro: { face: 'helvetica', style: 'normal', size: 6.4, leading: lines(0.8), color: INK_SOFT },
  microBold: { face: 'helvetica', style: 'bold', size: 6.4, leading: lines(0.8), color: INK_MID },
};

export const LW = {
  hair: 0.15,
  rule: 0.3,
  heavy: 0.7,
  chart: 0.8,
} as const;

/** Where the report was generated; empty when it cannot be determined. */
export function reportOrigin(): string {
  try {
    const h = globalThis.location?.hostname;
    if (h && h !== 'localhost' && !h.startsWith('127.')) return h.replace(/^www\./, '');
  } catch { /* non-browser */ }
  return '';
}
