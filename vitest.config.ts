import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // `scripts/**` added for phase-4's calibration tooling (extract/replay) —
    // pure-logic unit tests only, no live audio/model.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.ts'],
  },
});
