const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { ConversationHistoryStore } = require('../lib/conversation-history');

function makeTempStore(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kutai-conversation-test-'));
  return {
    dir,
    filePath: path.join(dir, 'conversation-history.json'),
    store: new ConversationHistoryStore({ ttlMs: 30 * 60 * 1000, maxMessages: 4, ...options, filePath: path.join(dir, 'conversation-history.json') }),
  };
}

test('会话上下文按会话保存，并在重建后可继续读取', () => {
  const { dir, filePath, store } = makeTempStore();
  try {
    store.remember('group-a', { id: '1', sender: '客户', content: '130H分隔抽（600柜）无门，定制什么尺寸', time: new Date().toISOString() }, '选择600柜连门定制。');
    store.remember('group-b', { id: '2', sender: '客户', content: '另一群的问题', time: new Date().toISOString() });

    const restored = new ConversationHistoryStore({ filePath, ttlMs: 30 * 60 * 1000, maxMessages: 4 });
    assert.equal(restored.get('group-a').length, 2);
    assert.equal(restored.get('group-b').length, 1);
    assert.match(restored.get('group-a')[1].content, /600柜连门定制/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('会话上下文只淘汰过期消息，不清空仍活跃的其他会话', () => {
  const { dir, store } = makeTempStore({ ttlMs: 1000 });
  try {
    store.remember('expired', { id: 'old', sender: '客户', content: '旧消息', time: new Date(Date.now() - 2000).toISOString() });
    store.remember('active', { id: 'new', sender: '客户', content: '新消息', time: new Date().toISOString() });
    store.prune();

    assert.equal(store.get('expired').length, 0);
    assert.equal(store.get('active').length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
