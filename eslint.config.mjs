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
      // Ratchet: no new `any` anywhere in the backend. The files below are
      // exempt only while their in-flight refactors land (NerveCenter split,
      // tool-drift work, persistence rewrite) — shrink this list to zero,
      // never grow it.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { 
          "argsIgnorePattern": "^_",
          "varsIgnorePattern": "^_",
          "caughtErrorsIgnorePattern": "^_"
        }
      ]
    }
  },
  {
    files: [
      "src/local/nerve-center.ts",
      "src/local/mcp-server.ts",
      "src/local/atomic-file.ts",
      "src/local/job-board.ts",
      "src/local/coordination-types.ts",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  }
);
