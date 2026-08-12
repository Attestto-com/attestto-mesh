import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    rules: {
      // Security-relevant rules
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',

      // TypeScript strictness
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-floating-promises': 'error',

      // General quality
      'no-console': 'warn',
      // `{ null: 'ignore' }` is deliberate. `x != null` is the idiom that
      // catches null AND undefined in one comparison, which is exactly what
      // `chat-store.ts`'s `row?.ack_by != null` needs: the optional chain can
      // produce undefined. Forcing `!== null` there would have made an
      // unacknowledged row read as acknowledged — the rule as configured was
      // asking for a behaviour change, not a style fix.
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
    },
    languageOptions: {
      parserOptions: {
        // `tsconfig.eslint.json` already includes `tests`, so the project
        // service resolves them through it. `allowDefaultProject` instead
        // routed them to the DEFAULT project, which caps at 8 files — with 12
        // test files that failed as `Parsing error: Too many files`, and the
        // error looked like a config limit rather than the misrouting it was.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  }
)
