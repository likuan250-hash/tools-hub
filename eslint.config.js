// eslint.config.js — 扁平配置（CommonJS）
// 设计原则：宽松优先、只拦真正会出错的写法，风格类一律 warn。
// 配合 lint-staged 只校验"暂存的新改动文件"，不会因历史代码报错卡住提交。
const globals = require("globals");

module.exports = [
  {
    files: ["**/*.js"],
    ignores: [
      "node_modules/**",
      "dist/**",
      "**/node_modules/**",
      "kdocs-tool/public/**",
      "netdisk-hub/public/**",
      "renderer/style.inline.css",
      "renderer/index.inline.html",
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        ...globals.browser,
        // 运行时由 Electron preload 注入到渲染进程的安全桥
        electronAPI: "readonly",
      },
    },
    rules: {
      // 真正会出错的，设为 error（会拦提交）
      "no-undef": "error",
      "no-dupe-keys": "error",
      // 风格/整洁类，仅 warn（不拦提交，但给提示）
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "prefer-const": "warn",
      eqeqeq: ["warn", "smart"],
      "no-console": "off",
    },
  },
];
