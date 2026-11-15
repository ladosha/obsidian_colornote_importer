import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  // Build output and the bundled tests are not source.
  globalIgnores(["node_modules", "main.js", ".test-build", "esbuild.config.mjs"]),
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mjs", "scripts/*.mjs"],
        },
      },
    },
    rules: {
      // Off in the recommended config since 0.5.0; on here, for UI text.
      "obsidianmd/ui/sentence-case": [
        "warn",
        {
          brands: ["ColorNote", "Obsidian", "Android", "UTF-8"],
          acronyms: ["ID", "UTC", "KB", "MB"],
        },
      ],
    },
  },
  {
    // node:test's test() returns a promise that the runner itself awaits.
    files: ["test/**/*.ts"],
    rules: { "@typescript-eslint/no-floating-promises": "off" },
  },
]);
