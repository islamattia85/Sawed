import { defineConfig } from 'vite';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

// The tests run on vite preview: serve them the production headers from
// vercel.json, so a Content-Security-Policy that breaks the app fails a test
// rather than the live site.
const prodHeaders = Object.fromEntries(JSON.parse(readFileSync(new URL('./vercel.json', import.meta.url), 'utf8'))
  .headers.flatMap((h) => h.headers).filter((h) => h.key !== 'Strict-Transport-Security').map((h) => [h.key, h.value]));

const { version } = createRequire(import.meta.url)('./package.json');

export default defineConfig({
  // Stamped into the bundle so runtime fetches of public/ assets — which Vite
  // does not hash — can be cache-busted per build.
  define: {
    __BUILD_ID__: JSON.stringify(
      process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) || String(Date.now())),
    // The major line this bundle belongs to. Two lines are now maintained
    // simultaneously — see VERSIONS.md — and a screenshot or a bug report has
    // to say which one it came from. The build id alone cannot: it is a commit
    // hash, and nobody reading a report can tell which branch it was on.
    __APP_VERSION__: JSON.stringify(version),
  },
  // public/ is copied verbatim to the build output. tariffs.json lives there
  // because the app fetches it at runtime and the scraper rewrites it daily.
  // Function names survive minification. Without this the strategy trace — and
  // any production stack — reads "Object.assign <- ha <- Ra", which names
  // nothing and cannot be acted on. Costs a little bundle size; buys the
  // ability to diagnose a fault on someone else's phone.
  esbuild: { keepNames: true },
  publicDir: 'public',
  build: {
    outDir: 'dist',
    // The app is a single entry; sourcemaps make production stack traces usable.
    sourcemap: true,
    target: 'es2020',
  },
  server: { port: 5173 },
  preview: { headers: prodHeaders },
});
