const assert = require('assert');
const path = require('path');
const { LlmWiki } = require('../lib/llm-wiki');

const wiki = new LlmWiki({
  root: process.env.LLM_WIKI_ROOT || (process.env.KNOWLEDGE_ROOT
    ? path.join(process.env.KNOWLEDGE_ROOT, 'LLM-Wiki')
    : path.resolve(__dirname, '..', '..', 'Dify知识库导入包', 'LLM-Wiki')),
  minScore: 18,
});

const count = wiki.load();
assert(count > 300, `索引页面数异常：${count}`);

const cases = [
  { query: '水槽侧拉能不能装200柜并且连门', expected: /水槽侧拉别名与安装边界|中枢阁水槽款/ },
  { query: '碗碟半抽怎么介绍', expected: /碗碟半抽|魔法抽/ },
  { query: '锅具抽能不能定深370', expected: /锅具|轨道角码|深度|定制/ },
  { query: '中枢阁水槽款是什么', expected: /水槽侧拉|中枢阁/ },
  { query: '柜内高度500，可以装一个碗碟半抽和一个锅具抽吗', expected: /抽屉组合高度判断口径/ },
];

for (const item of cases) {
  const results = wiki.query(item.query, { limit: 8 });
  assert(results.length, `没有检索结果：${item.query}`);
  const titles = results.map(result => result.title).join(' | ');
  assert(item.expected.test(titles), `检索不符合预期：${item.query}\n${titles}`);
  console.log(`✓ ${item.query}\n  ${results.slice(0, 3).map(result => `${result.title}(${result.score})`).join(' | ')}`);
}

console.log(`[LLM Wiki] ${cases.length} 个基础检索测试通过；索引共 ${count} 页。`);
