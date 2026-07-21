import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          root: import.meta.dirname,
          include: ['src/server/tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          root: import.meta.dirname,
          include: ['src/server/tests/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 180_000,
          hookTimeout: 180_000,
          fileParallelism: false,
          // Drops tenant partitions orphaned by previous runs. Without it the schema grows
          // without bound and eventually times out `db:types` — see the file header.
          globalSetup: ['src/server/tests/integration/helpers/global-setup.ts'],
        },
      },
    ],
  },
});
