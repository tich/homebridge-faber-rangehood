import { defineConfig } from 'eslint/config';
import eslint from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import tseslint from 'typescript-eslint';
import mustUseResult from './eslint-rules/must-use-result.js';

export default defineConfig(
  {
    ignores: ['dist/**', 'build-test/**'],
  },
  // Formatting (ESLint's own formatting rules are deprecated in favor of ESLint Stylistic's)
  stylistic.configs.customize({
    indent: 2,
    quotes: 'single',
    semi: true,
    commaDangle: 'always-multiline',
    braceStyle: '1tbs',
    arrowParens: true,
    quoteProps: 'consistent-as-needed',
  }),
  {
    rules: {
      // Stricter than the preset: no indented `case`s, no template literals without placeholders, no single-line blocks
      '@stylistic/indent': ['error', 2, { SwitchCase: 0 }],
      '@stylistic/quotes': ['error', 'single'],
      '@stylistic/brace-style': ['error', '1tbs'],
      // Not in the preset
      '@stylistic/linebreak-style': ['error', 'unix'],
      '@stylistic/max-len': ['warn', 160],
      // Comments at the end of lines may be aligned
      '@stylistic/no-multi-spaces': ['error', { ignoreEOLComments: true }],
      // A long declaration's value goes on the next line: `const MESSAGE =`, then the string
      '@stylistic/operator-linebreak': ['error', 'before', { overrides: { '=': 'after' } }],
      // A long signature's return type goes on its own line: `: Promise<...> {`
      '@stylistic/type-annotation-spacing': 'off',
      // Both `new X` and `new X()` are fine
      '@stylistic/new-parens': 'off',
    },
  },
  {
    rules: {
      'dot-notation': 'error',
      'eqeqeq': ['error', 'smart'],
      'curly': ['error', 'all'],
      'prefer-arrow-callback': 'warn',
      'no-use-before-define': 'off',
      '@typescript-eslint/no-use-before-define': ['error', { classes: false, enums: false }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    // Type-aware rules, to make sure errors are handled
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      local: { rules: { 'must-use-result': mustUseResult } },
    },
    rules: {
      'local/must-use-result': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
);
