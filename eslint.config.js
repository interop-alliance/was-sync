import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import prettierConfig from 'eslint-config-prettier'
import { defineConfig, globalIgnores } from 'eslint/config'

// The testing fixtures never reach production code: FakeWasServer accepts every
// write and serves a plausible changes feed, so an app importing it would show
// a healthy sync status over a replica writing nothing to WAS. Tests are the
// only importers, of the subpath and of the module behind it. (Flat-config rule
// entries replace rather than merge, so every src no-restricted-imports block
// restates these patterns.)
const noTestingFixtures = [
  {
    group: ['@interop/was-sync/testing', './testing.js', '../testing.js'],
    message:
      'The was-sync testing fixtures are test-only: FakeWasServer accepts ' +
      'every write while appearing to sync.'
  }
]

export default defineConfig([
  globalIgnores(['dist', '**/*.min.js']),
  {
    files: ['**/*.ts'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      prettierConfig // must be last in extends
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        project: ['./tsconfig.dev.json']
      }
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_'
        }
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      curly: ['error', 'all'],
      'no-var': 'error',
      'prefer-const': 'error'
    }
  },
  // The testing fixtures are a published subpath, so the restriction is on the
  // library source rather than on the package boundary alone.
  {
    files: ['src/**/*.ts'],
    ignores: ['src/testing.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: noTestingFixtures }]
    }
  }
])
