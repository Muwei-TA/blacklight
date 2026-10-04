module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
  },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'script',
  },
  extends: ['eslint:recommended'],
  rules: {
    'no-unused-vars': ['error', { argsIgnorePattern: '^_|^ctx$|^payload$' }],
    'no-console': 'off',
    'no-use-before-define': ['error', { functions: false }],
  },
  overrides: [
    {
      files: ['web/**/*.mjs'],
      env: { browser: true },
      parserOptions: { sourceType: 'module' },
    },
    {
      // 脚本与测试使用 ESM
      files: ['scripts/**/*.mjs', 'tests/**/*.mjs'],
      parserOptions: { sourceType: 'module' },
    },
    {
      files: ['tests/**/*.mjs'],
      env: { node: true },
    },
  ],
  ignorePatterns: ['node_modules/', 'cloudfunctions/*/shared/'],
};
