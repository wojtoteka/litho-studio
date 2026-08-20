/**
 * Lint configuration.
 *
 * Two rules carry real weight here rather than being style preferences:
 *
 *  - `no-console` — the product requirement is that no stray logging ships.
 *    `src/lib/logger.ts` is the single sanctioned exception, because it is what
 *    forwards diagnostics into the rotating log file.
 *  - `no-restricted-globals`/`no-restricted-imports` — the renderer must not
 *    reach for Node APIs; if it ever type-checks against them, something has
 *    gone wrong with `contextIsolation`.
 */
module.exports = {
  root: true,
  env: { es2022: true, browser: true, node: true },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint', 'react', 'react-hooks'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
    'prettier',
  ],
  settings: { react: { version: 'detect' } },
  ignorePatterns: [
    'dist/',
    'release/',
    'node_modules/',
    'coverage/',
    'resources/icons/',
    'tests/e2e/fixtures/',
  ],
  rules: {
    'no-console': 'error',
    eqeqeq: ['error', 'always', { null: 'ignore' }],
    'prefer-const': 'error',
    'no-var': 'error',
    'object-shorthand': 'error',

    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/consistent-type-imports': [
      'error',
      { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
    ],

    // The new JSX transform makes both of these obsolete.
    'react/react-in-jsx-scope': 'off',
    'react/prop-types': 'off',
    'react/jsx-uses-react': 'off',
  },
  overrides: [
    {
      // The one place allowed to touch `console`.
      files: ['src/lib/logger.ts'],
      rules: { 'no-console': 'off' },
    },
    {
      files: ['scripts/**/*.mjs'],
      rules: {
        'no-console': 'off',
        '@typescript-eslint/no-var-requires': 'off',
      },
    },
    {
      files: ['tests/**/*.ts'],
      rules: {
        '@typescript-eslint/no-non-null-assertion': 'off',
        '@typescript-eslint/no-explicit-any': 'off',
      },
    },
  ],
};
