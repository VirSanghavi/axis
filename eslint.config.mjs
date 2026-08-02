// eslint.config.mjs
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  // Global ignores — a standalone object so it applies to every config entry.
  // (An `ignores` key alongside other keys only scopes that one entry.)
  {
    ignores: [
      "node_modules/",
      "dist/",
      "tests/",
      "frontend/",
      "sandbox/",
      "history/",
      "packages/**/venv/",
      "packages/**/dist/",
      "packages/**/*.egg-info/",
      "**/*.tsbuildinfo",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { 
          "argsIgnorePattern": "^_",
          "varsIgnorePattern": "^_",
          "caughtErrorsIgnorePattern": "^_"
        }
      ]
    }
  }
);
