const fs = require('fs');
const path = require('path');
const { renderReviewQueueMarkdown } = require('./lib/review-queue');
const { runDws } = require('./lib/dws-client');

const root = __dirname;
const QUEUE_FILE = path.join(root, '待回复队列.json');
const QUEUE_MD_FILE = path.join(root, '待回复队列.md');
const STATE_FILE = path.join(root, 'auto-reply-state.json');

function usage() {
  console.log([
    '用法:',
    '  node pending-replies.js list [--all]',
    '  node pending-replies.js show <id>',
    '  node pending-replies.js send <id> --text "审核后的回复"',
    '  node pending-replies.js send <id> --use-suggestion',
    '  node pending-replies.js skip <id> --reason "跳过原因"',
  ].join('\n'));
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

function readQueue() {
  const queue = readJson(QUEUE_FILE, { version: 1, updatedAt: '', items: [] });
  if (!Array.isArray(queue.items)) queue.items = [];
  return queue;
}

function normalizeText(text, maxLen = 500) {
  return String(text || '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function renderQueue(queue) {
  return renderReviewQueueMarkdown(queue, { limit: 80, command: 'node pending-replies.js' });
}

function writeQueue(queue) {
  queue.updatedAt = new Date().toLocaleString('zh-CN', { hour12: false });
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf-8');
  fs.writeFileSync(QUEUE_MD_FILE, renderQueue(queue), 'utf-8');
}

function findItem(queue, id) {
  return queue.items.find(item => item.id === id);
}

function getArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return '';
  return process.argv[idx + 1] || '';
}

function isDwsSuccess(result) {
  return !!(
    result?.success ||
    result?.errorCode === 0 ||
    result?.code === 0 ||
    result?.result?.openTaskId ||
    result?.result?.messageId ||
    result?.result?.processQueryKey
  );
}

function markState(item, status) {
  if (!item.messageKey) return;
  const state = readJson(STATE_FILE, { repliedMsgs: {}, groupConfig: {} });
  if (!state.repliedMsgs) state.repliedMsgs = {};
  if (status === 'sent') {
    state.repliedMsgs[item.messageKey] = { status: 'replied', timestamp: Date.now() };
  } else if (status === 'skipped') {
    state.repliedMsgs[item.messageKey] = {
      status: 'queued',
      pendingId: item.id,
      skippedAt: Date.now(),
      skipReason: item.skipReason || '',
    };
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

function sendItem(item, text) {
  if (item.targetType === 'direct') {
    const args = ['chat', 'message', 'send', '--title', '回复', '--text', text];
    if (item.senderUserId) {
      args.splice(3, 0, '--user', item.senderUserId);
    } else if (item.senderOpenDingTalkId) {
      args.splice(3, 0, '--open-dingtalk-id', item.senderOpenDingTalkId);
    } else {
      throw new Error('私聊发送失败：队列里缺少 senderUserId / senderOpenDingTalkId');
    }
    return runDws(args, { cwd: root });
  }

  if (!item.conversationId) {
    throw new Error('群聊发送失败：队列里缺少 conversationId');
  }
  return runDws(['chat', 'message', 'send', '--group', item.conversationId, '--title', '回复', '--text', text], { cwd: root });
}

function listItems(queue, all) {
  const items = queue.items
    .filter(item => all || item.status === 'pending')
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  for (const item of items) {
    console.log(`${item.id} | ${item.status} | ${item.source} | ${item.title} | ${item.sender} | ${normalizeText(item.content, 80)}`);
  }
  if (!items.length) console.log('没有待回复记录。');
}

function showItem(item) {
  console.log(JSON.stringify(item, null, 2));
}

function main() {
  const command = process.argv[2] || 'list';
  const queue = readQueue();

  if (command === 'list') {
    listItems(queue, process.argv.includes('--all'));
    return;
  }

  const id = process.argv[3];
  if (!id) {
    usage();
    process.exitCode = 1;
    return;
  }

  const item = findItem(queue, id);
  if (!item) {
    throw new Error(`未找到队列记录：${id}`);
  }

  if (command === 'show') {
    showItem(item);
    return;
  }

  if (command === 'skip') {
    item.status = 'skipped';
    item.skipReason = getArg('--reason') || 'Codex审核后跳过';
    item.skippedAt = new Date().toISOString();
    markState(item, 'skipped');
    writeQueue(queue);
    console.log(`已跳过：${id}`);
    return;
  }

  if (command === 'send') {
    if (item.status !== 'pending') {
      throw new Error(`记录状态不是 pending，当前状态：${item.status}`);
    }
    const text = process.argv.includes('--use-suggestion') ? item.deepseekSuggestion : getArg('--text');
    if (!text || !text.trim()) {
      throw new Error('缺少回复内容，请用 --text "..." 或 --use-suggestion');
    }
    const result = sendItem(item, text.trim());
    if (!isDwsSuccess(result)) {
      throw new Error(`发送失败：${JSON.stringify(result).slice(0, 1000)}`);
    }
    item.status = 'sent';
    item.finalReply = text.trim();
    item.sentAt = new Date().toISOString();
    item.sendResult = result;
    markState(item, 'sent');
    writeQueue(queue);
    console.log(`发送成功：${id}`);
    return;
  }

  usage();
  process.exitCode = 1;
}

main();
