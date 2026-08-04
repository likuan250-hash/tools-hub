// lib/cookies.js —— 加载/校验 cookies.json，拼装 Cookie 头字符串与 csrf
// 校验：必须含 SESSDATA + bili_jct，否则视为无效（上报用户补）。
const fs = require('fs');
const logger = require('./logger');

/**
 * 读取 cookies.json（支持两种形态）：
 *   1) 对象：{ "SESSDATA": "...", "bili_jct": "...", ... }（本工具默认形态）
 *   2) 数组：[{ "name": "...", "value": "..." }]（浏览器导出 cookie 形态）
 * 统一归一化为 { name: value } 的扁平对象。
 * @param {string} p 文件路径
 * @returns {Object} 扁平 cookies 对象
 */
function load(p) {
  if (!p) throw new Error('cookies 路径为空');
  if (!fs.existsSync(p)) throw new Error('cookies.json 不存在: ' + p);
  const raw = fs.readFileSync(p, 'utf8');
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    const out = {};
    for (const c of parsed) {
      if (c && c.name) out[c.name] = c.value;
    }
    return out;
  }
  if (parsed && typeof parsed === 'object') return parsed;
  throw new Error('cookies.json 格式无法识别');
}

/**
 * 校验 cookies：必须同时含 SESSDATA 与 bili_jct。
 * @param {Object} cf 扁平 cookies 对象
 * @returns {boolean}
 */
function validate(cf) {
  if (!cf || typeof cf !== 'object') return false;
  return !!cf.SESSDATA && !!cf.bili_jct;
}

/**
 * 拼装 Cookie 请求头字符串（含全部 cookie 键）。
 * @param {Object} cf
 * @returns {string}
 */
function toHeader(cf) {
  if (!cf || typeof cf !== 'object') return '';
  return Object.keys(cf)
    .filter((k) => cf[k] != null && cf[k] !== '')
    .map((k) => k + '=' + String(cf[k]))
    .join('; ');
}

/**
 * 取 csrf token（bili_jct）。缺失返回空串（上层应据此拦截）。
 * @param {Object} cf
 * @returns {string}
 */
function getCsrf(cf) {
  return (cf && cf.bili_jct) || '';
}

/**
 * 便捷校验：加载 + validate，返回 { ok, hasSESSDATA, hasBiliJct, error }。
 * 不抛异常，便于接口直接返回。
 */
function checkFile(p) {
  try {
    const cf = load(p);
    return {
      ok: validate(cf),
      hasSESSDATA: !!cf.SESSDATA,
      hasBiliJct: !!cf.bili_jct,
      error: null,
    };
  } catch (e) {
    logger.warn('[cookies] 校验失败:', e.message);
    return { ok: false, hasSESSDATA: false, hasBiliJct: false, error: e.message };
  }
}

module.exports = { load, validate, toHeader, getCsrf, checkFile };
