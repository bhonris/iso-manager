import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { coverage: { include: ['src/**/*.js'], thresholds: { lines: 95 } } },
});
