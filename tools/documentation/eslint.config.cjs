const parser = require('@typescript-eslint/parser');
const tsdoc = require('eslint-plugin-tsdoc');
const path = require('node:path');

module.exports = [
  {
    basePath: path.resolve(__dirname, '../..'),
    files: ['src/**/*.ts'],
    languageOptions: {
      parser,
    },
    plugins: { tsdoc },
    rules: {
      'tsdoc/syntax': 'error',
    },
  },
];
