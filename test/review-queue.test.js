const test = require('node:test');
const assert = require('node:assert/strict');
const { renderReviewQueueMarkdown } = require('../lib/review-queue');
const rules = require('../config/auto-reply-rules.json');

test('审核队列渲染保留上下文、候选回复和审核命令', () => {
  const markdown = renderReviewQueueMarkdown({
    updatedAt: '2026-07-15 16:00:00',
    items: [{
      id: 'pr-001', status: 'pending', source: '群会话缓存', title: '测试群', sender: '客户',
      content: '这个产品怎么安装？', context: '前文已确认是魔法抽', deepseekSuggestion: '请按安装图确认。',
    }],
  });
  assert.match(markdown, /上下文：前文已确认是魔法抽/);
  assert.match(markdown, /候选回复：请按安装图确认/);
  assert.match(markdown, /pending-replies\.js send pr-001/);
});

test('自动回复规则均从可解析的外置配置读取', () => {
  assert.ok(Array.isArray(rules.blockKeywords) && rules.blockKeywords.length > 20);
  assert.ok(Array.isArray(rules.replyBlock) && rules.replyBlock.length > 10);
  assert.ok(Array.isArray(rules.productMatrixRoutes) && rules.productMatrixRoutes.length >= 8);
  assert.ok(rules.productMatrixRoutes.every(route => route.file && route.keywords?.length));
});
