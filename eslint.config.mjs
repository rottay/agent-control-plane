// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Agent Control Plane lint policy.
 *
 * Type-aware rules run only over workspace package sources, which are the files
 * covered by a tsconfig project. Root-level tooling files (this config, the
 * vitest workspace, the architecture fence) are linted with syntactic rules
 * only, so the lint step never depends on a build having run first.
 */
export default tseslint.config(
  {
    name: 'acp/ignores',
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
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
    files: ['packages/**/*.ts'],
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

  // Tests may assert on shapes that strict type-aware rules would reject.
  {
    name: 'acp/tests',
    files: ['packages/**/*.test.ts'],
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
