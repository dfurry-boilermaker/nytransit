import { defineConfig } from 'vite';

// Static single-page app. `base: './'` keeps asset paths relative so the
// built site works from any subpath (e.g. GitHub Pages project sites).
export default defineConfig({
  base: './',
  server: { port: 5173, open: true },
  build: { target: 'es2022', outDir: 'dist' },
});
