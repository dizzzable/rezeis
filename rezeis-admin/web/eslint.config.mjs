import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const jsxA11y = require('eslint-plugin-jsx-a11y');
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
 *  - Enforce basic accessibility checks for admin UI components.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '**/*.tsbuildinfo',
      'src/components/reactbits/**',
      'scripts/**',
      // Vendored landing kit — copied verbatim from reiwa by
      // scripts/sync-landing-kit.mjs and byte-frozen by its manifest test.
      // It is authored (and linted) in reiwa; linting it here would only
      // pressure someone into editing a file that must not be edited, and
      // reiwa's ruleset differs (e.g. it has eslint-plugin-react, we do not).
      'src/features/landing-builder/live/**',
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
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: {
      'jsx-a11y': jsxA11y,
    },
    rules: {
      // jsxA11y.flatConfigs.recommended,.rules,
      // Downgrade to warn during gradual adoption; promote to error
      // once the initial audit pass is complete.
      'jsx-a11y/alt-text': 'warn',
      'jsx-a11y/anchor-has-content': 'warn',
      'jsx-a11y/anchor-is-valid': 'warn',
      'jsx-a11y/aria-props': 'warn',
      'jsx-a11y/aria-proptypes': 'warn',
      'jsx-a11y/aria-unsupported-elements': 'warn',
      'jsx-a11y/heading-has-content': 'warn',
      'jsx-a11y/img-redundant-alt': 'warn',
      'jsx-a11y/no-access-key': 'warn',
      'jsx-a11y/no-distracting-elements': 'warn',
      'jsx-a11y/no-redundant-roles': 'warn',
      'jsx-a11y/no-autofocus': 'warn',
      'jsx-a11y/role-has-required-aria-props': 'warn',
      'jsx-a11y/role-supports-aria-props': 'warn',
      'jsx-a11y/scope': 'warn',
      // These are too noisy for Radix/shadcn primitive wrappers.
      // The primitives themselves handle the ARIA roles.
      'jsx-a11y/click-events-have-key-events': 'off',
      'jsx-a11y/no-static-element-interactions': 'off',
      'jsx-a11y/no-noninteractive-element-interactions': 'off',
      'jsx-a11y/no-noninteractive-tabindex': 'off',
    },
  },
)
