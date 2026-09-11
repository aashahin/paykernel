// ESLint flat config (ESLint 9+/10) for the PayKernel monorepo.
// Goal: runnable baseline without forcing mass source rewrites.
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "resources/**",
      "scripts/**",
      "**/*.mjs",
      "**/*.cjs",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["apps/payment-lab/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", ignoreRestSiblings: true }],
    },
  },
  {
    files: [
      "packages/*/src/**/*.ts",
      "internal/*/src/**/*.ts",
      "examples/*/src/**/*.ts",
    ],
    languageOptions: {
      parserOptions: {
        // Lightweight parse (no project service) — keeps lint fast and avoids
        // requiring a full type-aware program for every package.
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    linterOptions: {
      // Pre-existing eslint-disable comments may target type-aware rules we do not enable.
      reportUnusedDisableDirectives: "off",
    },
    rules: {
      // Baseline: keep recommended structure without forcing mass source rewrites.
      // Tighten these gradually after Phase 1 layout stabilizes.
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/no-namespace": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "prefer-const": "off",
      "no-case-declarations": "off",
      "no-useless-assignment": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-useless-escape": "off",
    },
  },
);
