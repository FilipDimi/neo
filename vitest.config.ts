import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The screen shows local time, and the recorded company day the screen's tests replay was a Monday morning in New York.
// The tests run in that zone wherever the machine is, or they would pass only there.
process.env.TZ = 'America/New_York';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'engine', include: ['test/**/*.spec.ts'] } },
      { plugins: [react()], test: { name: 'web', include: ['web/**/*.spec.{ts,tsx}'], environment: 'jsdom', setupFiles: ['web/src/setup.ts'] } },
    ],
  },
});
