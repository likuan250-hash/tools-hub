// lib/aigc.js —— 拼装 AIGC YAML front-matter 字符串（每次投稿必注入简介末尾）
// 合规标识头，字段值默认空（UI 可编辑，待用户填真实合规值）。
// 拼到 desc 末尾后由 command.js 的 ps1MultiLine 转成 `n 多行。

/**
 * 拼装 AIGC YAML front-matter。
 * @param {Object} fields { label, contentProducer, produceId, reservedCode1, contentPropagator, propagateId, reservedCode2 }
 * @returns {string} 多行 YAML 字符串（含 --- 分隔）
 */
function buildFrontMatter(fields) {
  const f = fields || {};
  const label = (typeof f.label === 'number' || typeof f.label === 'string') ? f.label : 1;
  const lines = [
    '---',
    'Label: ' + label,
    'ContentProducer: ' + (f.contentProducer || ''),
    'ProduceID: ' + (f.produceId || ''),
    'ReservedCode1: ' + (f.reservedCode1 || ''),
    'ContentPropagator: ' + (f.contentPropagator || ''),
    'PropagateID: ' + (f.propagateId || ''),
    'ReservedCode2: ' + (f.reservedCode2 || ''),
    '---',
  ];
  return lines.join('\n');
}

/**
 * 把 AIGC 头拼到简介末尾。
 * @param {string} desc 基础简介（可能已多行）
 * @param {Object} fields AIGC 字段
 * @returns {string} 完整 desc（含 AIGC 头）
 */
function appendToDesc(desc, fields) {
  const base = (desc || '').replace(/\s+$/, '');
  const fm = buildFrontMatter(fields);
  return base + '\n' + fm;
}

module.exports = { buildFrontMatter, appendToDesc };
