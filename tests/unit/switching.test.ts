import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SWITCH_WORTH, worthSwitching } from '../../src/switching';

/**
 * One rule for a switch worth making (30 Oct 2026): the answer, Home, the
 * report sheet, the share card and the report each had their own line
 * (€10, €20, "more than €1"), so a €17 saving was a switch on one screen and
 * not on the next.
 */
describe('a switch worth making', () => {
  it('is €20 a year or more', () => {
    expect(SWITCH_WORTH).toBe(20);
    expect(worthSwitching(19.99)).toBe(false);
    expect(worthSwitching(20)).toBe(true);
    expect(worthSwitching(0)).toBe(false);
  });

  it('is the one rule on every screen that says whether to switch', () => {
    for (const f of ['src/main.js', 'src/ui/v7.js', 'src/pdf/report.ts']) {
      const src = readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
      expect(src, f).toMatch(/import \{ worthSwitching \} from '\.\.?\/(\.\.\/)?switching'/);
    }
    const v7 = readFileSync(new URL('../../src/ui/v7.js', import.meta.url), 'utf8');
    // The old lines: "stay" under €20 on Home and €10 for gas and electricity together.
    expect(v7).not.toMatch(/saving < 20|dSave <= 10|nowSave >= 20/);
  });
});
