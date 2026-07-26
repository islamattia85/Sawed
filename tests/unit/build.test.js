import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

/**
 * Placeholder suite so `npm test` is meaningful from day one. Phase 2 extracts
 * the calculation engine into src/engine/ and fills this directory with real
 * unit tests for the money maths.
 */
describe('project layout', () => {
  it('index.html is a shell, not the application', () => {
    const html = readFileSync('index.html', 'utf8');
    expect(html.split('\n').length).toBeLessThan(120);
    expect(html).toContain('<script type="module" src="/src/main.js">');
  });

  it('runtime tariff data ships from public/', () => {
    expect(existsSync('public/tariffs.json')).toBe(true);
    const tariffs = JSON.parse(readFileSync('public/tariffs.json', 'utf8'));
    expect(Array.isArray(tariffs) ? tariffs.length : Object.keys(tariffs).length).toBeGreaterThan(0);
  });

  it('no duplicate top-level declarations in the entry module', () => {
    const src = readFileSync('src/main.js', 'utf8').split('\n');
    const seen = new Map();
    const dups = [];
    src.forEach((line, i) => {
      const m = /^(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(line);
      if (!m) return;
      if (seen.has(m[1])) dups.push(`${m[1]} (lines ${seen.get(m[1])}, ${i + 1})`);
      else seen.set(m[1], i + 1);
    });
    expect(dups).toEqual([]);
  });
});
