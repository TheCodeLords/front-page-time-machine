import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      // Cloned Bright Data reference repos — not ours to lint.
      'vendor/**',
      'coverage/**',
      'scratch/**',
      'snapshots/**',
      'screenshots/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      // `ignoreRestSiblings` permits the omit-a-key destructure (`const { x: _x, ...rest } = obj`),
      // which is how the tests build an invalid record to assert the schema rejects it.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
);
