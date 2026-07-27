import { defineConfig } from 'vite';

export default defineConfig({
  // Stamped into the bundle so runtime fetches of public/ assets — which Vite
  // does not hash — can be cache-busted per build.
  define: {
    __BUILD_ID__: JSON.stringify(
      process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) || String(Date.now())),
  },
  // public/ is copied verbatim to the build output. tariffs.json lives there
  // because the app fetches it at runtime and the scraper rewrites it daily.
  publicDir: 'public',
  build: {
    outDir: 'dist',
    // The app is a single entry; sourcemaps make production stack traces usable.
    sourcemap: true,
    target: 'es2020',
  },
  server: { port: 5173 },
});
