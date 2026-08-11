import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/coverage/**', '**/dist/**', '**/node_modules/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@openagentcore/coding',
                '@openagentcore/runtime',
                '@openagentcore/ui',
                '@openagentcore/cli',
                '@openagentcore/*/*',
              ],
              message: 'Kernel must not import another workspace package.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
);
