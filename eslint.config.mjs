import { defineConfig, globalIgnores } from "eslint/config";
import eslint from "@eslint/js";
import next from "@next/eslint-plugin-next";
import jsxA11y from "eslint-plugin-jsx-a11y";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

const frontendFiles = ["app/**/*.{js,jsx,ts,tsx}"];
const typescriptFiles = ["**/*.{ts,tsx,mts,cts}"];
const scopedTypeScript = tseslint.configs.recommended.map((config) => ({
  ...config,
  files: config.files || typescriptFiles,
}));

const eslintConfig = defineConfig([
  globalIgnores([
    ".next/**",
    ".open-next/**",
    ".vinext/**",
    ".wrangler/**",
    ".tmp-*.mjs",
    "coverage/**",
    "dist/**",
    "out/**",
    "build/**",
    "desktop/node_modules/**",
    "local-agent/data/**",
    "local-agent/config.local.json",
    "local-agent/yuanbao-cookie",
    "local-agent/zhitai-edge-all-in-one.user.js",
    "local-agent/zhitai-kuaidian-bridge.user.js",
    "next-env.d.ts",
  ]),
  eslint.configs.recommended,
  ...scopedTypeScript,
  { ...react.configs.flat.recommended, files: frontendFiles },
  { ...react.configs.flat["jsx-runtime"], files: frontendFiles },
  { ...reactHooks.configs.flat["recommended-latest"], files: frontendFiles },
  { ...jsxA11y.flatConfigs.recommended, files: frontendFiles },
  { ...next.configs["core-web-vitals"], files: frontendFiles },
  {
    files: frontendFiles,
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    settings: {
      react: {
        version: "detect",
      },
    },
    rules: {
      // 现有大型工作台仍在分拆；把 UI 迁移债务保留为可见 warning，避免掩盖后端/脚本错误。
      "@typescript-eslint/no-unused-vars": "warn",
      "no-extra-boolean-cast": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "jsx-a11y/click-events-have-key-events": "warn",
      "jsx-a11y/media-has-caption": "warn",
      "jsx-a11y/no-noninteractive-element-interactions": "warn",
      "jsx-a11y/no-static-element-interactions": "warn",
    },
  },
  {
    files: ["**/*.d.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  // 后端 Node 模块与测试：独立 Node globals + 服务端规则（不套用前端 React/JSX 与 TS 专属规则）
  {
    files: [
      "desktop/**/*.js",
      "local-agent/**/*.mjs",
      "tests/**/*.mjs",
      "scripts/**/*.mjs",
      "integrations/**/*.mjs",
    ],
    ignores: ["local-agent/*.user.js"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // 服务端 .mjs 常见：顶层 await / 未使用参数（预留回调位）等
      "@typescript-eslint/no-unused-vars": "off",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/no-require-imports": "off",
      "no-empty": "off",
      "no-control-regex": "off",
      "no-unsafe-finally": "off",
      "no-prototype-builtins": "off",
    },
  },
  // 仓库原创油猴脚本必须 lint；已移出版本控制的上游 fork/整合产物在全局忽略中。
  {
    files: [
      "local-agent/zhitai-kuaidian-companion.user.js",
      "local-agent/zhitai-filehelper-bridge.user.js",
      "local-agent/zhitai-alert-silencer.user.js",
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
        GM_setValue: "readonly",
        GM_getValue: "readonly",
        GM_xmlhttpRequest: "readonly",
        GM_registerMenuCommand: "readonly",
        GM_setClipboard: "readonly",
        GM_addStyle: "readonly",
        layer: "readonly",
        layui: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-redeclare": "error",
      "no-control-regex": "off",
      "no-empty": "off",
    },
  },
]);

export default eslintConfig;
