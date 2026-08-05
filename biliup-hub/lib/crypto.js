// lib/crypto.js —— 凭证落盘加密（AES-256-GCM），与 netdisk-hub/src/store.js 同方案。
//
// 背景：cookies.json（SESSDATA/bili_jct）与 login_info.json（access_token/refresh_token）
// 此前明文落盘；本模块把两者改为加密存储，主密钥存于 userData/.masterkey（打包后）
// 或仓库根 .masterkey（开发态），与 netdisk 同一约定——密钥+密文同时泄露才会暴露凭证。
//
// 兼容性：读取端同时支持「新版加密 blob」与「旧版明文」两种形态，
// 手动放置 cookies.json（浏览器导出）的流程不受影响；下次写入自动升级为加密。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.BILIUP_DATA_DIR
  ? path.resolve(process.env.BILIUP_DATA_DIR)
  : path.join(__dirname, '..', 'data');

// 与 netdisk 相同约定：DATA_DIR 上溯两级 = userData（打包）/ 仓库根（开发）。
// BILIUP_KEY_FILE 允许外部（含测试）指定主密钥落盘路径。
const KEY_FILE = process.env.BILIUP_KEY_FILE
  ? path.resolve(process.env.BILIUP_KEY_FILE)
  : path.resolve(DATA_DIR, '..', '..', '.masterkey');

let _key = null;
function getKey() {
  if (_key) return _key;
  try {
    if (fs.existsSync(KEY_FILE)) {
      _key = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
    } else {
      _key = crypto.randomBytes(32);
      fs.writeFileSync(KEY_FILE, _key.toString('hex'), { mode: 0o600 });
      try { fs.chmodSync(KEY_FILE, 0o600); } catch (_) { /* Windows 忽略 */ }
    }
  } catch (e) {
    // 极端兜底：进程内随机密钥（重启后无法解密旧数据），仅防崩溃
    _key = crypto.randomBytes(32);
  }
  return _key;
}

/** 加密任意可 JSON 序列化对象，返回 { v:1, k:iv, t:tag, d:data }。 */
function encryptObj(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { v: 1, k: iv.toString('hex'), t: tag.toString('hex'), d: enc.toString('hex') };
}

/** 解密 encryptObj 产物；密钥不匹配/数据被篡改会抛错（由调用方决定失败语义）。 */
function decryptObj(blob) {
  const iv = Buffer.from(blob.k, 'hex');
  const tag = Buffer.from(blob.t, 'hex');
  const dec = Buffer.from(blob.d, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  const json = Buffer.concat([decipher.update(dec), decipher.final()]).toString('utf8');
  return JSON.parse(json);
}

/** 判断对象是否为本模块产出的加密 blob。 */
function isEncrypted(x) {
  return !!x && x.v === 1
    && typeof x.k === 'string'
    && typeof x.t === 'string'
    && typeof x.d === 'string';
}

module.exports = { getKey, encryptObj, decryptObj, isEncrypted, KEY_FILE };
