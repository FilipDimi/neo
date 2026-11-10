import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The app is built into web/dist, which the engine serves. In development Vite serves it and
// passes API calls to the engine; the engine's own page is where the token comes from.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { port: 5173, proxy: { '/api': { target: 'http://127.0.0.1:4317', ws: true } } },
});
