// ai.test.js — 已废弃：阿里百炼（bl CLI）集成单测
// ai.js 自 v2.8.0 起为已废弃占位模块（见 lib/ai.js 顶部注释），不再实现真实 bl 调用。
// 本文件仅校验「占位模块可正常加载并暴露历史导出形状」，避免遗漏引用直接崩溃；
// 真实 bl 行为测试已随功能移除而删除。
const test = require("node:test");
const assert = require("node:assert");

test("ai 占位模块可加载并暴露历史导出形状", () => {
  const ai = require("../lib/ai");
  for (const name of [
    "checkBlAvailable", "aiDescribe", "aiCoverSearch",
    "parseSingle", "buildPrompt", "INTRO_BLACKLIST",
    "isBadIntro", "isBadSize",
  ]) {
    assert.ok(name in ai, `缺少历史导出：${name}`);
  }
  // 占位实现均为安全 no-op
  assert.strictEqual(typeof ai.checkBlAvailable, "function");
  assert.strictEqual(typeof ai.aiDescribe, "function");
  assert.strictEqual(typeof ai.aiCoverSearch, "function");
  assert.strictEqual(typeof ai.parseSingle, "function");
  assert.strictEqual(typeof ai.buildPrompt, "function");
  assert.strictEqual(typeof ai.isBadIntro, "function");
  assert.strictEqual(typeof ai.isBadSize, "function");
});
