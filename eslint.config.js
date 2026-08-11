import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      ".playwright-mcp/**",
      "assets/**",
      "packages/client/public/**",
      "packages/*/test/**",
      "playwright-report/**",
      "test-results/**",
      "**/*.blend*",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["packages/client/src/**/*.ts"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["packages/server/**/*.ts", "packages/*/test/**/*.ts", "tools/**/*.mjs", "playwright.config.ts", "e2e/**/*.ts"],
    languageOptions: { globals: globals.node },
  },
  {
    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "no-constant-condition": "off",
      "no-loss-of-precision": "off",
      "no-useless-assignment": "off",
    },
  },
);
