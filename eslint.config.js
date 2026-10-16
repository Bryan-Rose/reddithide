import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'web-ext-artifacts/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-restricted-properties': [
        'error',
        { property: 'innerHTML', message: 'Render untrusted data as text (SPEC §12).' },
        { property: 'outerHTML', message: 'Render untrusted data as text (SPEC §12).' },
      ],
    },
  },
  {
    files: ['tests/**'],
    rules: { 'no-restricted-properties': 'off', '@typescript-eslint/no-explicit-any': 'off' },
  },
);
