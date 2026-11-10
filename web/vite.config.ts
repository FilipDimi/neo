import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The app is built into web/dist, and the engine serves it from there with its token in the page.
// There is no separate development server: a second origin would need the token and a way past
// the engine's Origin check. `npm run watch:web` rebuilds on every save; reload the page.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
});
