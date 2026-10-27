import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // `scripts/**` added for phase-4's calibration tooling (extract/replay) —
    // pure-logic unit tests only, no live audio/model.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.ts'],
    env: {
      // The vendor-path suites were written against Soniox (live speaker labels);
      // the `local` provider is the runtime default and has its own suites.
      STT_REALTIME_PROVIDER: 'soniox',
      STT_ASYNC_PROVIDER: 'soniox',
      // Never let a developer's paired identity file turn tests into standalone-production.
      PRIVOS_STANDALONE_IDENTITY_FILE: '/nonexistent/privos-standalone-identity.json',
    },
  },
});
