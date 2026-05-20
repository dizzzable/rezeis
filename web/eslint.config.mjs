import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import globals from 'globals'

/**
 * Flat ESLint config for the rezeis-admin web SPA.
 *
 * Goals:
 *  - Catch the classic "I forgot to call `useTranslation()` inside a
 *    nested component" by enforcing rules-of-hooks.
 *  - Surface unused vars (with `_`-prefix opt-out for tests + handlers).
 *  - Keep the ruleset light — TypeScript covers the heavy stuff.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '**/*.tsbuildinfo',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      // Use react-hooks's recommended baseline but downgrade the new
      // React-Compiler rules from `error` to `warn`. They surface real
      // bugs (`refs`-during-render, `set-state-in-effect`, etc.) but
      // existing code paths haven't been audited yet, so blocking the
      // lint run on first contact would create noise without a clear
      // owner. Critical rules (`rules-of-hooks`, `exhaustive-deps`)
      // stay as errors so the original guard rails still hold.
      ...reactHooks.configs.recommended.rules,
      'react-hooks/static-components': 'warn',
      'react-hooks/use-memo': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/globals': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/error-boundaries': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/set-state-in-render': 'warn',
      'react-hooks/config': 'warn',
      'react-hooks/gating': 'warn',
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      // ESLint 10 flipped `no-useless-assignment` to error in
      // `js.configs.recommended`. The rule reports many real-world
      // patterns as false positives (e.g. `let foo = []; [foo, bar] =
      // await Promise.all(...)`). Re-enable later as a `warn` once the
      // upstream rule is more conservative.
      'no-useless-assignment': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
  {
    files: ['src/**/*.test.{ts,tsx}', 'src/**/*.spec.{ts,tsx}', 'src/test/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
)
