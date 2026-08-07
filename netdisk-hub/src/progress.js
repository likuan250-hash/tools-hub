// src/progress.js —— 转存进度 SSE 总线（内存级，单进程内可用）
// 与 kdocs 一键执行同款模式：批量转存逐条推 step/log/done 事件，前端 EventSource 实时展示。
"use strict";

const { EventEmitter } = require("events");

const channels = new Map();

/** 注册客户端通道，返回 EventEmitter（前端 SSE 连接建立时调用）。 */
function create(clientId) {
  const ch = new EventEmitter();
  channels.set(clientId, ch);
  return ch;
}

/** 取通道（不存在返回 undefined，调用方自行忽略）。 */
function get(clientId) {
  return channels.get(clientId);
}

/** 向通道推送事件：{ type:'step'|'log'|'done', ... }。 */
function emit(clientId, ev) {
  const ch = channels.get(clientId);
  if (ch) ch.emit("event", ev);
}

/** 连接关闭时清理通道。 */
function remove(clientId) {
  channels.delete(clientId);
}

module.exports = { create, get, emit, remove };
