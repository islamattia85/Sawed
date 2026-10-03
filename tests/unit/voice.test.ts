// Guards the voice guide (docs/voice.md): phrases that make the app read as
// machine-written or salesy must not come back into user-facing text.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const SRC = ['src/main.js', 'src/ui/v7.js', 'src/ui/charts.js']
  .map((f) => readFileSync(f, 'utf8')).join('\n');

const BANNED = [
  /completely transparent/i, /in plain English/i, /seamless/i, /effortless/i,
  /stated plainly/i, /an easy decision/i, /Continue when you(?:'|’|\\')re ready/i,
  /leave savings on the table/i, /no € guessing/i, /tap for math/i,
  /Get my answer in 30 seconds/i, /independent second opinion/i,
];

describe('voice', () => {
  for (const re of BANNED) {
    it(`no "${re.source}"`, () => { expect(SRC).not.toMatch(re); });
  }
});
