import { defineConfig, globalIgnores } from "eslint/config";
import typescriptEslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default defineConfig([
  { ignores: ["dist/**", ".next/**", "node_modules/**", ".test-data/**", "coverage/**"] },
  ...typescriptEslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Incompatible with NestJS DI: constructor parameter types are needed
      // at runtime for reflect-metadata, so they must stay value imports.
      "@typescript-eslint/consistent-type-imports": "off",
      "no-console": ["error"],
    },
  },
  prettier,
]);
