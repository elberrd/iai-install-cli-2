import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-console': 'off', // é uma CLI — console é a interface
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
    },
  },
  {
    // live1/, live2/ and harness/ are gitignored sibling checkouts (the
    // templates and the agent scaffold) with their own toolchains — never
    // lint them here. estudo/ is scratch material.
    ignores: ['node_modules/**', 'live1/**', 'live2/**', 'harness/**', 'estudo/**'],
  },
];
