// lib/cookies.js —— 加载/校验 cookies.json，拼装 Cookie 头字符串与 csrf
// 校验：必须含 SESSDATA + bili_jct，否则视为无效（上报用户补）。
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const secret = require('./crypto');

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
  // 新版：AES-256-GCM 加密 blob（由 auth.saveCookies 写入）→ 解密后归一化。
  // 旧版/手动放置：明文 JSON（对象或数组）直接兼容，下次写入自动升级为加密。
  if (secret.isEncrypted(parsed)) {
    try {
      const dec = secret.decryptObj(parsed);
      if (Array.isArray(dec)) {
        const out = {};
        for (const c of dec) {
          if (c && c.name) out[c.name] = c.value;
        }
        return out;
      }
      if (dec && typeof dec === 'object') return dec;
      throw new Error('cookies 解密结果格式无法识别');
    } catch (e) {
      throw new Error('cookies.json 解密失败（主密钥不匹配或数据被篡改）: ' + e.message);
    }
  }
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
 * 加密落盘（AES-256-GCM）。保存后磁盘上不再出现明文 SESSDATA/bili_jct。
 * @param {string} p 目标文件路径
 * @param {Object} cookiesObj 扁平 cookies 对象
 * @returns {string} p
 */
function save(p, cookiesObj) {
  if (!p) throw new Error('cookies 路径为空');
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(secret.encryptObj(cookiesObj)), 'utf8');
  return p;
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

module.exports = { load, save, validate, toHeader, getCsrf, checkFile };
