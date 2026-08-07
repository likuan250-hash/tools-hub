// src/progress.js —— SSE 进度总线单测
const { test } = require('node:test');
const assert = require('node:assert');
const progress = require('../src/progress');

test('create/get/emit/remove：事件可送达且清理后不再送达', () => {
  const received = [];
  const ch = progress.create('u1');
  ch.on('event', (ev) => received.push(ev));
  progress.emit('u1', { type: 'log', message: 'x' });
  progress.emit('u1', { type: 'done', okCount: 1, total: 1 });
  assert.strictEqual(received.length, 2);
  assert.strictEqual(received[1].type, 'done');
  progress.remove('u1');
  progress.emit('u1', { type: 'log', message: 'y' });
  assert.strictEqual(received.length, 2, '清理后不应再收到事件');
});

test('emit：未知 client 静默忽略', () => {
  assert.doesNotThrow(() => progress.emit('not-exist', { type: 'log', message: 'x' }));
});
