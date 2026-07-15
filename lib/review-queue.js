'use strict';

function normalizeQueueText(text, maxLen = 500) {
  return String(text || '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function renderReviewQueueMarkdown(queue, { limit = 80, command = 'node pending-replies.js' } = {}) {
  const items = [...(queue.items || [])].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const pending = items.filter(item => item.status === 'pending');
  const lines = [
    '# 钉钉待回复队列',
    '',
    '> 系统只负责扫描、提取候选和保存上下文；发送前必须审核。',
    '',
    `更新时间：${queue.updatedAt || ''}`,
    `待审核：${pending.length} 条；总记录：${items.length} 条`,
    '',
  ];

  for (const item of items.slice(0, limit)) {
    lines.push(`## ${item.id}｜${item.status || 'pending'}｜${item.source || ''}｜${item.title || ''}`);
    lines.push('');
    lines.push(`- 时间：${item.messageTime || item.createdAt || ''}`);
    lines.push(`- 发送人：${item.sender || ''}`);
    lines.push(`- 问题：${normalizeQueueText(item.content, 800)}`);
    if (item.reason) lines.push(`- 入队原因：${normalizeQueueText(item.reason, 500)}`);
    if (item.deepseekSuggestion) lines.push(`- 候选回复：${normalizeQueueText(item.deepseekSuggestion, 1000)}`);
    if (item.context) lines.push(`- 上下文：${normalizeQueueText(item.context, 1200)}`);
    if (item.status === 'pending') {
      lines.push(`- 发送命令：${command} send ${item.id} --text "审核后的回复"`);
      lines.push(`- 跳过命令：${command} skip ${item.id} --reason "跳过原因"`);
    }
    if (item.finalReply) lines.push(`- 最终回复：${normalizeQueueText(item.finalReply, 1000)}`);
    if (item.skipReason) lines.push(`- 跳过原因：${normalizeQueueText(item.skipReason, 500)}`);
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = { normalizeQueueText, renderReviewQueueMarkdown };
