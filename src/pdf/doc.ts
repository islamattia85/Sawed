/**
 * Document engine: a typeset page rather than a canvas.
 *
 * Callers advance a baseline, not a pixel cursor, so vertical rhythm is
 * structural instead of a matter of remembering the right offset. Page
 * furniture (running heads, folios) and navigation (PDF outline) are applied
 * by the document, not by the content.
 */

import {
  PAGE, TEXT_LEFT, TEXT_RIGHT, TEXT_WIDTH, TEXT_BOTTOM, BASELINE,
  TYPE, INK, INK_SOFT, RULE, RULE_SOFT as RULE_DOT, LW, type Rgb, type Spec,
} from './theme.js';

export interface PdfDoc {
  setFillColor(r: number, g: number, b: number): void;
  setDrawColor(r: number, g: number, b: number): void;
  setTextColor(r: number, g: number, b: number): void;
  setFontSize(n: number): void;
  setFont(family: string, style: string): void;
  setLineWidth(n: number): void;
  setCharSpace(n: number): void;
  rect(x: number, y: number, w: number, h: number, style?: string): void;
  roundedRect(x: number, y: number, w: number, h: number, rx: number, ry: number, style?: string): void;
  line(x1: number, y1: number, x2: number, y2: number): void;
  triangle(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, style?: string): void;
  text(txt: string | string[], x: number, y: number, opts?: Record<string, unknown>): void;
  getTextWidth(txt: string): number;
  addPage(): void;
  setPage(n: number): void;
  getNumberOfPages(): number;
  splitTextToSize(txt: string, maxWidth: number): string[];
  link(x: number, y: number, w: number, h: number, opts: Record<string, unknown>): void;
  setProperties(p: Record<string, string>): void;
  outline?: { add(parent: unknown, title: string, options: Record<string, unknown>): unknown };
}

const finite = (v: number, fb = 0) => (Number.isFinite(v) ? v : fb);

/**
 * jsPDF's built-in faces are WinAnsi-encoded. A code point outside that set is
 * not dropped — it renders as garbage with broken metrics. Map what a report
 * realistically contains and discard the rest.
 */
const MAP: Record<string, string> = {
  // U+2212 MINUS SIGN is NOT in CP1252 and corrupts the run it appears in.
  // The en and em dashes ARE, so they pass through untouched.
  '−': '-', '‐': '-', '‑': '-',
  ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ',
  '⁄': '/', '≥': '>=', '≤': '<=', '≈': '~',
  '×': 'x',
};
const CP1252_EXTRA = '‘’“”–—†‡•…‰€‹›ŒœŠšŸŽžƒ';

export function toWinAnsi(txt: string): string {
  let out = '';
  for (const ch of txt) {
    const m = MAP[ch];
    if (m !== undefined) { out += m; continue; }
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0xff || CP1252_EXTRA.includes(ch)) out += ch;
  }
  return out;
}

export interface TextRun extends Partial<Spec> {
  align?: 'left' | 'center' | 'right';
  maxWidth?: number;
}

export interface Chapter { title: string; page: number; }

export class Doc {
  readonly doc: PdfDoc;
  /** Current baseline, millimetres from page top. */
  y = PAGE.marginTop;
  /** Running head text for pages after the front matter. */
  runningTitle = '';
  /** Populated as chapters open; drives both the contents page and bookmarks. */
  readonly chapters: Chapter[] = [];
  /** Pages that must not receive furniture (cover, contents). */
  readonly bareePages = new Set<number>();
  /** Where the contents list is written back once page numbers are known. */
  contentsAnchor: { page: number; y: number } | null = null;

  constructor(doc: PdfDoc) { this.doc = doc; }

  get left() { return TEXT_LEFT; }
  get right() { return TEXT_RIGHT; }
  get width() { return TEXT_WIDTH; }
  get page() { return this.doc.getNumberOfPages(); }

  // ── style ────────────────────────────────────────────────────────────────
  private apply(s: TextRun) {
    this.doc.setFont(s.face ?? 'times', s.style ?? 'normal');
    this.doc.setFontSize(s.size ?? 9.8);
    const c = s.color ?? INK;
    this.doc.setTextColor(c[0], c[1], c[2]);
    this.doc.setCharSpace(s.tracking ?? 0);
  }

  fill(c: Rgb) { this.doc.setFillColor(c[0], c[1], c[2]); return this; }
  stroke(c: Rgb) { this.doc.setDrawColor(c[0], c[1], c[2]); return this; }
  weight(w: number) { this.doc.setLineWidth(w); return this; }

  measure(txt: string, s: TextRun = TYPE.body!): number {
    this.apply(s);
    const w = this.doc.getTextWidth(toWinAnsi(txt));
    this.doc.setCharSpace(0);
    return w;
  }

  /** Truncate with an ellipsis so a long value can never run past its column. */
  fit(txt: string, max: number, s: TextRun = TYPE.body!): string {
    if (this.measure(txt, s) <= max) return txt;
    let t = txt;
    while (t.length > 1 && this.measure(`${t}…`, s) > max) t = t.slice(0, -1);
    return `${t}…`;
  }

  /** Draw a single line at an absolute position. Returns its width. */
  text(txt: string, x: number, y: number, s: TextRun = TYPE.body!): number {
    const body = toWinAnsi(s.maxWidth ? this.fit(txt, s.maxWidth, s) : txt);
    this.apply(s);
    this.doc.text(body, finite(x), finite(y),
      s.align && s.align !== 'left' ? { align: s.align } : undefined);
    const w = this.doc.getTextWidth(body);
    this.doc.setCharSpace(0);
    return w;
  }

  /**
   * Wrapped text on the baseline grid, breaking pages as needed so a paragraph
   * can flow across a page boundary without the caller thinking about it.
   */
  paragraph(txt: string, s: TextRun = TYPE.body!, opts: { x?: number; width?: number; indent?: number } = {}) {
    const x = opts.x ?? this.left;
    const width = opts.width ?? (this.right - x);
    const leading = s.leading ?? BASELINE;
    this.apply(s);
    const rows = this.doc.splitTextToSize(toWinAnsi(txt), width);
    rows.forEach((row, i) => {
      this.ensure(leading);
      this.apply(s);
      this.doc.text(row, finite(x + (i === 0 ? (opts.indent ?? 0) : 0)), finite(this.y));
      this.y += leading;
    });
    this.doc.setCharSpace(0);
    return this;
  }

  // ── flow ─────────────────────────────────────────────────────────────────
  /** Advance whole baselines. */
  skip(n = 1) { this.y += n * BASELINE; return this; }

  /** Break if `need` mm will not fit below the current baseline. */
  ensure(need: number) {
    if (this.y + need <= TEXT_BOTTOM) return false;
    this.newPage();
    return true;
  }

  newPage() {
    this.doc.addPage();
    this.y = PAGE.marginTop;
    return this;
  }

  /** Snap the baseline down to the next grid position. */
  snap() {
    const off = (this.y - PAGE.marginTop) % BASELINE;
    if (off > 0.01) this.y += BASELINE - off;
    return this;
  }

  rule(color: Rgb = RULE, w: number = LW.rule, from = this.left, to = this.right) {
    this.stroke(color).weight(w);
    this.doc.line(finite(from), finite(this.y), finite(to), finite(this.y));
    return this;
  }

  /** Register a chapter for the contents page and the PDF outline. */
  openChapter(title: string) {
    this.chapters.push({ title, page: this.page });
    this.runningTitle = title;
  }

  /** Clickable region over already-drawn text. */
  link(x: number, y: number, w: number, h: number, url: string) {
    try { this.doc.link(finite(x), finite(y - h), finite(w), finite(h), { url }); } catch { /* optional */ }
  }

  // ── furniture ────────────────────────────────────────────────────────────
  /**
   * Applied after all content exists, so folios can say "of N" and running
   * heads can reflect the chapter a page actually belongs to.
   */
  finish(meta: { title: string; subject: string; origin: string }) {
    const total = this.doc.getNumberOfPages();

    /**
     * Running head. When a page carries the start of one or more chapters the
     * FIRST of them owns the head — otherwise a page that opens with "What you
     * use" was labelled with a later chapter that merely began further down.
     */
    const titleFor = (p: number) => {
      const startsHere = this.chapters.filter((ch) => ch.page === p);
      if (startsHere.length) return startsHere[0]!.title;
      let t = '';
      for (const ch of this.chapters) { if (ch.page < p) t = ch.title; }
      return t;
    };

    for (let p = 1; p <= total; p += 1) {
      if (this.bareePages.has(p)) continue;
      this.doc.setPage(p);

      const head = titleFor(p);
      if (head) {
        this.text(head, TEXT_LEFT, PAGE.headBaseline, { ...TYPE.micro!, color: INK_SOFT });
        this.text('Solar Optimiser', TEXT_RIGHT, PAGE.headBaseline,
          { ...TYPE.micro!, color: INK_SOFT, align: 'right' });
        this.stroke(RULE).weight(LW.hair);
        this.doc.line(TEXT_LEFT, PAGE.headBaseline + 2.4, TEXT_RIGHT, PAGE.headBaseline + 2.4);
      }

      this.text(String(p), TEXT_RIGHT, PAGE.folioBaseline,
        { ...TYPE.micro!, color: INK_SOFT, align: 'right' });
      const foot = [meta.origin, 'Independent — not financial advice'].filter(Boolean).join('  ·  ');
      this.text(foot, TEXT_LEFT, PAGE.folioBaseline, { ...TYPE.micro!, color: INK_SOFT });
    }

    // Contents can only be typeset once every chapter knows its page.
    if (this.contentsAnchor) {
      this.doc.setPage(this.contentsAnchor.page);
      let cy = this.contentsAnchor.y;
      for (const ch of this.chapters) {
        this.text(ch.title, TEXT_LEFT, cy, TYPE.body!);
        const numW = this.measure(String(ch.page), TYPE.data!);
        const titleW = this.measure(ch.title, TYPE.body!);
        // Dot leader between title and folio.
        this.stroke(RULE_DOT).weight(LW.hair);
        const from = TEXT_LEFT + titleW + 3;
        const to = TEXT_RIGHT - numW - 3;
        if (to > from) this.doc.line(from, cy - 0.9, to, cy - 0.9);
        this.text(String(ch.page), TEXT_RIGHT, cy, { ...TYPE.data!, align: 'right' });
        cy += BASELINE * 1.5;
      }
    }

    // Navigation and document properties — the things that make a PDF feel
    // like a file rather than a printout.
    try {
      for (const ch of this.chapters) {
        this.doc.outline?.add(null, toWinAnsi(ch.title), { pageNumber: ch.page });
      }
    } catch { /* outline unsupported */ }

    try {
      this.doc.setProperties({
        title: meta.title,
        subject: meta.subject,
        author: 'Solar Optimiser',
        creator: 'Solar Optimiser',
        keywords: 'electricity, tariff, solar, battery, Ireland, SEAI, payback',
      });
    } catch { /* optional */ }
  }
}
