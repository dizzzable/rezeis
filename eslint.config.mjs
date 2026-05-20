import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Flat ESLint config for rezeis-admin.
 *
 * The project deliberately keeps the rule set small — TypeScript's compiler
 * already covers the heaviest checks (`tsc --noEmit`), and the runtime relies
 * on Nest's pipes + class-validator for I/O safety. ESLint exists primarily
 * to surface dead imports, accidental `console` calls, and unsafe `any`-only
 * patterns that the relaxed `tsconfig.json` would otherwise let through.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'web/**',
      'prisma/migrations/**',
      'coverage/**',
      'scripts/**',
      '**/*.tsbuildinfo',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The project uses optional chaining and runtime validators; full
      // strict-null + no-implicit-any is handled gradually.
      '@typescript-eslint/no-explicit-any': 'warn',
      // ESLint 10 flipped `no-useless-assignment` to error in
      // `js.configs.recommended`. Too many false positives on legit
      // patterns like `let foo = init; [foo, bar] = await Promise.all(...)`
      // — leave it off until upstream tightens the analysis.
      'no-useless-assignment': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-var-requires': 'off',
      // Nest decorators rely on parameter properties; make them ergonomic.
      '@typescript-eslint/no-empty-function': 'off',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-undef': 'off', // TypeScript already covers this.
    },
  },
  {
    files: ['test/**/*.ts', 'src/**/*.spec.ts', 'src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-console': 'off',
    },
  },
);
