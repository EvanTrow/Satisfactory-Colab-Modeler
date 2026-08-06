// @ts-check
import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "**/coverage/**",
      "resources/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // apps/web: React + browser globals
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },
  // apps/api, apps/realtime, packages/*: Node globals
  {
    files: [
      "apps/api/**/*.ts",
      "apps/realtime/**/*.ts",
      "packages/**/*.ts",
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  // config files evaluated by Node directly
  {
    files: ["**/*.config.{js,ts}", "**/*.config.*.{js,ts}"],
    languageOptions: {
      globals: globals.node,
    },
  },
  eslintConfigPrettier,
);
