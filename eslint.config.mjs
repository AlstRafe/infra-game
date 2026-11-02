// ESLint for CoreLab's scripts (npm run lint). Prettier owns the layout (npm run format); these rules catch mistakes.
import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    rules: {
      // An unused catch binding, or an argument kept for a shared signature such as (argv, ctx), is fine.
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
      "no-useless-assignment": "warn",
      "no-useless-escape": "warn",
      "preserve-caught-error": "warn",
      // Japanese text has full-width spaces.
      "no-irregular-whitespace": ["error", { skipStrings: true, skipTemplates: true, skipRegExps: true }],
      // el.textContent = el.textContent and the like go through a setter on purpose.
      "no-self-assign": ["error", { props: false }],
      // A terminal simulator (and its tests) match escape sequences on purpose.
      "no-control-regex": "off",
    },
  },
  {
    files: ["js/**/*.js"],
    languageOptions: {
      sourceType: "script",
      // IG: the namespace every script adds to. Buffer: what js/core and js/cmd use when run in Node (tests/).
      globals: { ...globals.browser, IG: "readonly", Buffer: "readonly" },
    },
    rules: {
      // (s.match(re) || [, ""])[1]: the hole stands for the whole match.
      "no-sparse-arrays": "off",
    },
  },
  {
    files: ["tests/**/*.js"],
    languageOptions: { sourceType: "commonjs", globals: globals.node },
    rules: {
      // Expected terminal output is matched with its columns as they look.
      "no-regex-spaces": "off",
    },
  },
];
