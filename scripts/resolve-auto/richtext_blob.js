#!/usr/bin/env node
// 修改 Resolve DRT 里 Rich 文本的 FieldsBlob：
//   输入：EffectFiltersBA 的 hex 文件 + 旧文本 + 新文本
//   输出：改好的 hex 文件（退出码 0=已替换，2=没找到旧文本，1=出错）
//
// 结构：u32 固定值2 + u32 payloadLen + 0x81 + zstd(payload)
// payload 是 protobuf 风格的消息树；最深一层是“文本 run 列表”：
//   [u32 runTotal][u32 textLen][UTF-16LE text][6B 样式尾]...，其中 runTotal = textLen + 10
// 替换文本时同步更新 run 自身长度、容器首 u32、以及所有祖先 protobuf 长度。
const fs = require("fs");
const zlib = require("zlib");

const [, , inFile, outFile, oldArg, newArg] = process.argv;
if (!inFile || !outFile || oldArg == null || newArg == null) {
  console.error("usage: richtext_blob.js <in.hex> <out.hex> <oldText> <newText>");
  process.exit(1);
}

function readVarint(buf, i) {
  let shift = 0;
  let val = 0;
  while (i < buf.length) {
    const b = buf[i++];
    val |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return [val >>> 0, i];
    shift += 7;
    if (shift > 49) throw new Error("varint too long");
  }
  throw new Error("unexpected eof");
}

function writeVarint(n) {
  const out = [];
  let v = n >>> 0;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return Buffer.from(out);
}

function parseMessage(buf) {
  const fields = [];
  let i = 0;
  while (i < buf.length) {
    const [tag, j] = readVarint(buf, i);
    const field = tag >>> 3;
    const wire = tag & 7;
    if (!field) throw new Error("field 0");
    i = j;
    if (wire === 0) {
      const [val, k] = readVarint(buf, i);
      fields.push({ field, wire, value: val });
      i = k;
    } else if (wire === 2) {
      const [len, k] = readVarint(buf, i);
      if (k + len > buf.length) throw new Error("length overflow");
      fields.push({ field, wire, value: buf.subarray(k, k + len) });
      i = k + len;
    } else if (wire === 1) {
      if (i + 8 > buf.length) throw new Error("short fixed64");
      fields.push({ field, wire, value: buf.subarray(i, i + 8) });
      i += 8;
    } else if (wire === 5) {
      if (i + 4 > buf.length) throw new Error("short fixed32");
      fields.push({ field, wire, value: buf.subarray(i, i + 4) });
      i += 4;
    } else {
      throw new Error("unsupported wire " + wire);
    }
  }
  return fields;
}

function serialize(fields) {
  const parts = [];
  for (const f of fields) {
    parts.push(writeVarint((f.field << 3) | f.wire));
    if (f.wire === 0) parts.push(writeVarint(f.value));
    else if (f.wire === 2) {
      parts.push(writeVarint(f.value.length));
      parts.push(f.value);
    } else {
      parts.push(f.value);
    }
  }
  return Buffer.concat(parts);
}

function patchRawContainer(buf, oldBuf, newBuf) {
  for (let i = 0; i + 12 <= buf.length; i++) {
    const total = buf.readUInt32LE(i);
    const textLen = buf.readUInt32LE(i + 4);
    if (total !== textLen + 10 || textLen < 6) continue;
    const textStart = i + 8;
    const textEnd = textStart + textLen - 4;
    if (textEnd > buf.length) continue;
    const text = buf.subarray(textStart, textEnd);
    if (!text.equals(oldBuf)) continue;
    const footer = buf.subarray(textEnd, i + total);
    if (footer.length !== 6) continue;
    const newTextLen = newBuf.length + 4;
    const newTotal = newTextLen + 10;
    const run = Buffer.alloc(newTotal);
    run.writeUInt32LE(newTotal, 0);
    run.writeUInt32LE(newTextLen, 4);
    newBuf.copy(run, 8);
    footer.copy(run, 8 + newBuf.length);
    const out = Buffer.concat([buf.subarray(0, i), run, buf.subarray(i + total)]);
    if (buf.length >= 4 && buf.readUInt32LE(0) === buf.length) out.writeUInt32LE(out.length, 0);
    return { changed: true, buf: out };
  }
  return { changed: false, buf };
}

function patchMessage(buf, oldBuf, newBuf, depth) {
  if (depth > 12 || !buf.includes(oldBuf)) return { changed: false, buf };
  let fields;
  try {
    fields = parseMessage(buf);
  } catch (e) {
    return patchRawContainer(buf, oldBuf, newBuf);
  }
  let changed = false;
  for (const f of fields) {
    if (f.wire !== 2 || !f.value.includes(oldBuf)) continue;
    let sub = patchMessage(f.value, oldBuf, newBuf, depth + 1);
    if (!sub.changed) sub = patchRawContainer(f.value, oldBuf, newBuf);
    if (sub.changed) {
      f.value = sub.buf;
      changed = true;
    }
  }
  return changed ? { changed: true, buf: serialize(fields) } : { changed: false, buf };
}

try {
  const hex = fs.readFileSync(inFile, "utf8").replace(/\s+/g, "");
  const blob = Buffer.from(hex, "hex");
  if (blob.length < 13 || blob.readUInt32BE(0) !== 2) throw new Error("unexpected blob header");
  const payloadLen = blob.readUInt32BE(4);
  if (payloadLen !== blob.length - 8) throw new Error("payload length mismatch");
  if (blob[8] !== 0x81) throw new Error("unexpected compression flag");
  const payload = zlib.zstdDecompressSync(blob.subarray(9));
  const oldBuf = Buffer.from(oldArg, "utf16le");
  const newBuf = Buffer.from(newArg, "utf16le");
  const r = patchMessage(payload, oldBuf, newBuf, 0);
  if (!r.changed) {
    console.error("text not found");
    process.exit(2);
  }
  if (r.buf.includes(oldBuf)) throw new Error("old text still present");
  const frame = zlib.zstdCompressSync(r.buf);
  const out = Buffer.alloc(9 + frame.length);
  out.writeUInt32BE(2, 0);
  out.writeUInt32BE(1 + frame.length, 4);
  out[8] = 0x81;
  frame.copy(out, 9);
  fs.writeFileSync(outFile, out.toString("hex"));
  process.exit(0);
} catch (e) {
  console.error(String(e && e.message ? e.message : e));
  process.exit(1);
}
