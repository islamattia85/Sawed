/**
 * Layout primitives over jsPDF.
 *
 * The previous report positioned everything with bare millimetre offsets and
 * right-aligned text directly on a box's own border, so figures overflowed
 * their containers whenever a value grew a digit. Every helper here measures
 * text before placing it and insets content from box edges, which removes that
 * whole class of defect rather than patching instances of it.
 */

import { PAGE, C, LW, type Rgb } from './theme.js';

/** Minimal surface of jsPDF that this module uses. */
export interface PdfDoc {
  setFillColor(r: number, g: number, b: number): void;
  setDrawColor(r: number, g: number, b: number): void;
  setTextColor(r: number, g: number, b: number): void;
  setFontSize(n: number): void;
  setFont(family: string, style: string): void;
  setLineWidth(n: number): void;
  rect(x: number, y: number, w: number, h: number, style?: string): void;
  roundedRect(x: number, y: number, w: number, h: number, rx: number, ry: number, style?: string): void;
  line(x1: number, y1: number, x2: number, y2: number): void;
  text(txt: string, x: number, y: number, opts?: Record<string, unknown>): void;
  getTextWidth(txt: string): number;
  addPage(): void;
  setPage(n: number): void;
  getNumberOfPages(): number;
  splitTextToSize(txt: string, maxWidth: number): string[];
}

export type Align = 'left' | 'center' | 'right';

export interface TextOpts {
  size?: number;
  bold?: boolean;
  color?: Rgb;
  align?: Align;
  /** Hard limit; text is ellipsised rather than allowed to overflow. */
  maxWidth?: number;
}

/** Guards against NaN reaching jsPDF, which silently corrupts the page. */
const n = (v: number, fallback = 0): number => (Number.isFinite(v) ? v : fallback);

/**
 * jsPDF's built-in fonts are WinAnsi-encoded. A code point outside that set is
 * not dropped — it is rendered as garbage with broken metrics, which is how a
 * U+2212 MINUS SIGN turned "− €1,800" into '" € 1 , 8 0 0'. Map the characters
 * a report realistically contains onto their WinAnsi equivalents, and strip
 * anything else rather than let it corrupt a line.
 */
const WINANSI_MAP: Record<string, string> = {
  '\u2212': '-',   // minus sign
  '\u2013': '-',   // en dash
  '\u2010': '-',   // hyphen
  '\u2011': '-',   // non-breaking hyphen
  '\u00a0': ' ',   // no-break space
  '\u202f': ' ',   // narrow no-break space
  '\u2009': ' ',   // thin space
  '\u2044': '/',   // fraction slash
  '\u2265': '>=',
  '\u2264': '<=',
  '\u2248': '~',
};

export function toWinAnsi(txt: string): string {
  let out = '';
  for (const ch of txt) {
    const mapped = WINANSI_MAP[ch];
    if (mapped !== undefined) { out += mapped; continue; }
    const cp = ch.codePointAt(0) ?? 0;
    // Latin-1 plus the CP1252 punctuation block jsPDF supports.
    if (cp <= 0xff || '\u2018\u2019\u201c\u201d\u2013\u2014\u2020\u2021\u2022\u2026\u2030\u20ac\u2039\u203a\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u0192'.includes(ch)) {
      out += ch;
    }
  }
  return out;
}

export class Canvas {
  readonly doc: PdfDoc;
  /** Current vertical cursor, millimetres from page top. */
  y: number;

  constructor(doc: PdfDoc) {
    this.doc = doc;
    this.y = PAGE.margin;
  }

  get left() { return PAGE.margin; }
  get right() { return PAGE.width - PAGE.margin; }
  get width() { return PAGE.contentWidth; }

  // ── raw state ────────────────────────────────────────────────────────────
  fill(c: Rgb) { this.doc.setFillColor(c[0], c[1], c[2]); return this; }
  stroke(c: Rgb) { this.doc.setDrawColor(c[0], c[1], c[2]); return this; }
  lineWidth(w: number) { this.doc.setLineWidth(w); return this; }

  private applyText(o: TextOpts) {
    this.doc.setFontSize(o.size ?? 9);
    this.doc.setFont('helvetica', o.bold ? 'bold' : 'normal');
    const c = o.color ?? C.ink;
    this.doc.setTextColor(c[0], c[1], c[2]);
  }

  /** Width of `txt` under the given style, millimetres. */
  measure(txt: string, o: TextOpts = {}): number {
    this.applyText(o);
    return this.doc.getTextWidth(toWinAnsi(txt));
  }

  /**
   * Truncate to fit `maxWidth`, appending an ellipsis. Returning the original
   * string when it already fits means callers never need to branch.
   */
  fit(txt: string, maxWidth: number, o: TextOpts = {}): string {
    if (this.measure(txt, o) <= maxWidth) return txt;
    let s = txt;
    while (s.length > 1 && this.measure(`${s}…`, o) > maxWidth) s = s.slice(0, -1);
    return `${s}…`;
  }

  /** Draw text at an absolute position. Returns its measured width. */
  text(txt: string, x: number, y: number, o: TextOpts = {}): number {
    const body = toWinAnsi(o.maxWidth ? this.fit(txt, o.maxWidth, o) : txt);
    this.applyText(o);
    this.doc.text(body, n(x), n(y), o.align && o.align !== 'left' ? { align: o.align } : undefined);
    return this.measure(body, o);
  }

  /** Wrapped paragraph. Advances the cursor. Returns height consumed. */
  paragraph(
    txt: string,
    o: TextOpts & { x?: number; width?: number; leading?: number } = {},
  ): number {
    const x = o.x ?? this.left;
    const width = o.width ?? (this.right - x);
    const leading = o.leading ?? (o.size ?? 9) * 0.42;
    this.applyText(o);
    const lines = this.doc.splitTextToSize(toWinAnsi(txt), width);
    for (const line of lines) {
      this.doc.text(line, n(x), n(this.y));
      this.y += leading;
    }
    return lines.length * leading;
  }

  // ── boxes ────────────────────────────────────────────────────────────────
  /**
   * A filled panel with an optional border and left accent rule.
   * Content is placed via the returned inset frame, never against the border.
   */
  panel(opts: {
    x?: number; y?: number; w?: number; h: number;
    bg?: Rgb; border?: Rgb; accent?: Rgb; radius?: number; inset?: number;
  }) {
    const x = opts.x ?? this.left;
    const y = opts.y ?? this.y;
    const w = opts.w ?? this.width;
    const { h } = opts;
    const r = opts.radius ?? 1.6;
    const inset = opts.inset ?? 5;

    if (opts.bg) {
      this.fill(opts.bg);
      this.doc.roundedRect(n(x), n(y), n(w), n(h), r, r, 'F');
    }
    if (opts.border) {
      this.stroke(opts.border).lineWidth(LW.hairline);
      this.doc.roundedRect(n(x), n(y), n(w), n(h), r, r, 'S');
    }
    if (opts.accent) {
      this.fill(opts.accent);
      this.doc.rect(n(x), n(y + r), 1.4, n(h - r * 2), 'F');
    }
    return {
      x, y, w, h,
      /** Usable interior. Nothing should be drawn outside this. */
      inner: {
        x: x + inset + (opts.accent ? 1.4 : 0),
        y: y + inset,
        w: w - inset * 2 - (opts.accent ? 1.4 : 0),
        get right() { return this.x + this.w; },
      },
    };
  }

  rule(color: Rgb = C.rule, indent = 0) {
    this.stroke(color).lineWidth(LW.hairline);
    this.doc.line(n(this.left + indent), n(this.y), n(this.right - indent), n(this.y));
    return this;
  }

  // ── flow ─────────────────────────────────────────────────────────────────
  space(mm: number) { this.y += mm; return this; }

  /**
   * Ensure `needed` mm remain on this page, breaking first if not. Callers
   * declare the height of the block they are about to draw, so a block is
   * never split across a page boundary mid-way.
   */
  reserve(needed: number, onNewPage?: (c: Canvas) => void): boolean {
    if (this.y + needed <= PAGE.bottomLimit) return false;
    this.doc.addPage();
    this.y = PAGE.margin;
    onNewPage?.(this);
    return true;
  }
}
