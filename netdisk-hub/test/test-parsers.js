// netdisk-hub parser tests
// Usage: node test/test-parsers.js
'use strict';

const baidu = require("../src/baidu");
const quark = require("../src/quark");

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed++; }
  else { failed++; console.error("  FAIL:", label); }
}

console.log("\n[baidu] parseSurl:");
assert(baidu.parseSurl("https://pan.baidu.com/s/abc123") === "abc123", "simple surl");
assert(baidu.parseSurl("https://pan.baidu.com/s/abc123?pwd=8888") === "abc123", "surl with pwd");
assert(baidu.parseSurl("?surl=abc123") === "abc123", "query param surl");
assert(baidu.parseSurl("") === "", "empty string");

console.log("\n[quark] parseLink:");
var q = quark.parseLink("https://pan.quark.cn/s/def456?pwd=abc");
assert(q.pwdId === "def456", "pwdId from full url");
assert(q.passcode === "abc", "passcode from url");

q = quark.parseLink("https://pan.quark.cn/s/def456");
assert(q.pwdId === "def456", "pwdId without pwd");
assert(q.passcode === "", "passcode empty");

console.log("\n[xunlei] parseSurl:");
const xunlei = require("../src/xunlei");
assert(typeof xunlei.parseSurl === "function", "xunlei.parseSurl exists");

console.log("\n===================");
console.log("Passed:", passed, "/ Failed:", failed, "/ Total:", passed + failed);
if (failed > 0) process.exit(1);
