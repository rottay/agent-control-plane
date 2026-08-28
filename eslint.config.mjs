// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Agent Control Plane lint policy.
 *
 * Type-aware rules run only over workspace package sources, which are the files
 * covered by a tsconfig project. Root-level tooling files (this config, the
 * vitest config, the architecture fence) are linted with syntactic rules
 * only, so the lint step never depends on a build having run first.
 *
 * P1B widens type-aware coverage from `.ts` to `.ts` and `.tsx`, so the UI is
 * linted under exactly the same strict rule set as every other package. The
 * only concession the UI gets is a browser global set, scoped to its own source
 * directory. No rule is relaxed anywhere to accommodate it.
 */
export default tseslint.config(
  {
    name: 'acp/ignores',
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      // Test-tree build output. A package whose mirrored `test/` tree emits a
      // runnable fixture writes it here rather than into the published
      // `dist/`, and generated JS is not written to the conventions these
      // rules assume of authored code — so linting it reports defects in a
      // compiler's output. Recurs for every package whose test tree emits.
      '**/dist-test/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      'pnpm-lock.yaml',
    ],
  },

  {
    name: 'acp/base',
    ...js.configs.recommended,
  },

  // Workspace package sources: full type-aware linting.
  {
    name: 'acp/packages-typed',
    files: ['packages/**/*.ts', 'packages/**/*.tsx'],
    extends: [
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true },
      ],
      // The control plane must never silently swallow provider failures.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      'no-console': 'error',
    },
  },

  // The UI runs in a browser and needs browser globals to be declared. This is
  // a declaration of the environment, not a relaxation: every strict rule above
  // still applies to these files, including no-console.
  {
    name: 'acp/ui-browser',
    files: ['packages/ui/src/**/*.ts', 'packages/ui/src/**/*.tsx'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },

  // Tests may assert on shapes that strict type-aware rules would reject.
  {
    name: 'acp/tests',
    files: ['packages/**/*.test.ts', 'packages/**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // Root tooling: syntactic linting only, no type information required.
  {
    name: 'acp/tooling',
    files: ['*.mjs', '*.ts', 'scripts/**/*.mjs'],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      // The architecture fence reports through stdout by design.
      'no-console': 'off',
    },
  },
);
