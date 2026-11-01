import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';
export default tseslint.config(
  {
    ignores: ['vendor/**', 'test/fixtures/**', '.studio/**', 'dist/**', 'node_modules/**', '**/test-results/**', '**/.wrangler/**'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      curly: ['error', 'all'],
      'no-restricted-syntax': ['error', { selector: 'TSEnumDeclaration', message: 'Use a literal union.' }],
    },
  },
  {
    files: ['src/**/*.ts', 'src/**/*.tsx', 'scripts/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json', './tsconfig.worker.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
    },
  },
);
