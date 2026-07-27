import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Inline `on*` attributes are evaluated in GLOBAL scope, so a function that
 * lives in module scope is simply not visible to them. Moving the app to ES
 * modules therefore silently broke every handler that wasn't re-exported onto
 * `window`, and a broken one fails as an uncaught ReferenceError: the click
 * does nothing and the interface says nothing.
 *
 * Nineteen handlers were fixed during the migration and the seven auth ones —
 * sign in, sign up, Google, sign out, password reset, profile save, cloud sync —
 * were missed, which left the entire authentication system inert for weeks.
 * The e2e suite could not catch it because those controls only appear on
 * screens the happy path never visits.
 *
 * This is the cheap, total check: parse the source, collect every function
 * called from an inline attribute, and require each one to be exported.
 */

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../src/main.js'), 'utf8');

/** Things that resolve without an export: language keywords and host objects. */
const AMBIENT = new Set([
  'if', 'for', 'while', 'switch', 'return', 'typeof', 'function', 'catch',
  'alert', 'confirm', 'prompt', 'parseInt', 'parseFloat', 'isNaN',
  'Number', 'String', 'Boolean', 'Math', 'JSON', 'Object', 'Array', 'Date',
  'setTimeout', 'setInterval', 'clearTimeout', 'requestAnimationFrame',
  'encodeURIComponent', 'decodeURIComponent', 'console', 'document', 'window',
  'event', 'fetch', 'Promise',
  // Member calls — `this.foo()`, `el.remove()` — resolve on their receiver.
  'getElementById', 'querySelector', 'querySelectorAll', 'preventDefault',
  'stopPropagation', 'remove', 'reload', 'replace', 'toggle', 'add', 'focus',
  'blur', 'click', 'contains', 'push', 'slice', 'split', 'join', 'trim',
]);

function calledFromInlineAttributes(src: string): Set<string> {
  const out = new Set<string>();
  const attrs = [
    /on(?:click|change|input|submit|keyup|keydown|focus|blur)="([^"]*)"/g,
    /on(?:click|change|input|submit|keyup|keydown|focus|blur)='([^']*)'/g,
  ];
  for (const re of attrs) {
    for (const m of src.matchAll(re)) {
      // A call preceded by `.` is a member call and resolves on its receiver.
      for (const c of (m[1] ?? '').matchAll(/(^|[^.\w$])([a-zA-Z_$][\w$]*)\s*\(/g)) {
        out.add(c[2]!);
      }
    }
  }
  return out;
}

const declared = (src: string) => new Set([
  ...[...src.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+([\w$]+)/g)].map((m) => m[1]!),
  ...[...src.matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?\(/g)].map((m) => m[1]!),
]);

const exported = (src: string) => new Set(
  [...src.matchAll(/window\.([\w$]+)\s*=/g)].map((m) => m[1]!));

describe('inline event handlers', () => {
  it('every function an inline attribute calls is exported to window', () => {
    const called = calledFromInlineAttributes(SRC);
    const isDeclared = declared(SRC);
    const isExported = exported(SRC);

    const broken = [...called]
      .filter((name) => !AMBIENT.has(name))
      .filter((name) => isDeclared.has(name))
      .filter((name) => !isExported.has(name))
      .sort();

    expect(broken,
      `these are called from inline on* attributes but never assigned to window, so every `
      + `click on them throws ReferenceError:\n  ${broken.join('\n  ')}`).toEqual([]);
  });

  it('finds a real number of handlers, so the parser cannot pass by matching nothing', () => {
    const called = [...calledFromInlineAttributes(SRC)].filter((n) => !AMBIENT.has(n));
    expect(called.length).toBeGreaterThan(60);
  });

  it('the auth handlers specifically are exported', () => {
    const isExported = exported(SRC);
    for (const fn of ['doGoogleSignIn', 'doSignIn', 'doSignUp', 'doSignOut',
      'doForgotPassword', 'doUpdateProfile', 'doSyncState']) {
      expect(isExported.has(fn), `${fn} is not on window — its button is dead`).toBe(true);
    }
  });
});
