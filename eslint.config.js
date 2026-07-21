import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Root lint configuration for the TypeScript backend tree only.
 * The SPA keeps its own config at src/ui/eslint.config.js (`npm run lint:ui`).
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'src/ui/**',
      'e2e_tests/**',
      'docs/**',
      'supabase/**',
      // Transient fixtures written by tests (e.g. the lint-gate test in
      // src/server/tests/integration/lint-no-any.test.ts) must never be visible to a repo-wide
      // `eslint .`: a concurrent vitest run would otherwise make an unrelated lint invocation
      // fail. ESLint does not honour .gitignore, so the exclusion has to live here (F-001-6).
      // The lint-gate test lints its fixture by explicit path with --no-ignore, so the
      // `no-explicit-any` gate is still proven against this very config.
      // Scoped to match .gitignore's `src/server/**/*.tmp.ts` exactly. A repo-wide `**/*.tmp.ts`
      // was BROADER than .gitignore, so a committable `.tmp.ts` anywhere else (e.g. api/) would be
      // invisible to lint while still being tracked — demonstrated with a lint-invisible `any` in
      // api/mask-probe.evaluator.tmp.ts (finding F-010-2).
      'src/server/**/*.tmp.ts',
    ],
  },
  {
    files: ['api/**/*.ts', 'src/server/**/*.ts', 'scripts/**/*.{ts,mjs}', 'vitest.config.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      // AC-010: environment variables are read only through the typed config module.
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message:
            'Read environment variables through src/server/lib/config (getConfig()) instead of process.env.',
        },
      ],
    },
  },
  {
    // The typed config module is the single sanctioned reader of the process environment.
    files: ['src/server/lib/config/index.ts'],
    rules: {
      'no-restricted-properties': 'off',
    },
  },
);
