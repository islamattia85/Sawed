import { defineConfig } from 'vite';

export default defineConfig({
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
