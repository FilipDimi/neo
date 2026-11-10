import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'engine', include: ['test/**/*.spec.ts'] } },
      { plugins: [react()], test: { name: 'web', include: ['web/**/*.spec.{ts,tsx}'], environment: 'jsdom', setupFiles: ['web/src/setup.ts'] } },
    ],
  },
});
