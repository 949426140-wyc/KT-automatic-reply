const fs = require('fs');
const path = require('path');
const { LlmWiki } = require('../lib/llm-wiki');

const historyDir = process.env.HISTORY_DIR || path.resolve(__dirname, '..', 'data', 'conversations');
const reportFile = process.env.LLM_WIKI_AUDIT_REPORT || path.resolve(__dirname, '..', 'self-audit', 'llm-wiki-retrieval-audit.json');
const wiki = new LlmWiki({
  root: process.env.LLM_WIKI_ROOT || path.resolve(__dirname, '..', '..', '产品知识库', 'LLM-Wiki'),
  minScore: Number(process.env.LLM_WIKI_MIN_SCORE || 18),
});
const productCue = /抽屉|轨道|导轨|安装|尺寸|柜体|柜内|净宽|净深|净高|魔法抽|尚酷|中枢阁|翼枢阁|挂门宝|云狐|云梯|云阁|百纳阁|小怪物|拉篮|升降机|收纳架|挂盒|门板|碗碟|锅具|调料|水槽|承重|深度|宽度|高度|定制|连门|开门/;

function readQuestions() {
  const seen = new Set();
  const questions = [];
  const historyFiles = fs.existsSync(historyDir)
    ? fs.readdirSync(historyDir, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => path.join(historyDir, entry.name))
    : [];
  const sharedHistory = path.resolve(__dirname, '..', 'data', 'shared-history.json');
  if (fs.existsSync(sharedHistory)) historyFiles.push(sharedHistory);
  for (const historyFile of historyFiles) {
    let records = [];
    try { records = JSON.parse(fs.readFileSync(historyFile, 'utf8')); } catch (error) { continue; }
    for (const record of Array.isArray(records) ? records : []) {
      const raw = String(record.user || '');
      const compactContent = (raw.match(/(?:^|\n)内容[：:]\s*([\s\S]+)/) || [])[1]?.trim();
      const candidateLines = compactContent ? [`[共享历史] 用户: ${compactContent}`] : raw.split(/\r?\n/);
      for (const line of candidateLines) {
        const match = line.match(/^\[([^\]]+)\]\s*([^:：]+)[:：]\s*(.+)$/);
        if (!match) continue;
        const question = match[3].replace(/\[图片消息\][\s\S]*/g, '').trim();
        if (question.length < 4 || question.length > 240 || !productCue.test(question) || seen.has(question)) continue;
        seen.add(question);
        questions.push(question);
      }
    }
  }
  const previousAudit = path.resolve(__dirname, '..', 'self-audit', 'product-self-audit.json');
  if (fs.existsSync(previousAudit)) {
    try {
      const payload = JSON.parse(fs.readFileSync(previousAudit, 'utf8'));
      for (const item of Array.isArray(payload?.results) ? payload.results : []) {
        const question = String(item.question || '').trim();
        if (question.length < 4 || question.length > 240 || !productCue.test(question) || seen.has(question)) continue;
        seen.add(question);
        questions.push(question);
      }
    } catch (error) {}
  }
  return questions.slice(0, 100);
}

function main() {
  const pages = wiki.load();
  if (!pages) throw new Error(`LLM Wiki 索引不可用：${wiki.indexFile}`);
  const results = readQuestions().map(question => {
    const hits = wiki.query(question, { limit: 5 });
    return {
      question,
      hasEvidence: hits.length > 0,
      topScore: hits[0]?.score || 0,
      hits: hits.map(hit => ({ title: hit.title, pageType: hit.pageType, score: hit.score, sourcePath: hit.sourcePath })),
    };
  });
  const withEvidence = results.filter(result => result.hasEvidence).length;
  const lowConfidence = results.filter(result => result.hasEvidence && result.topScore < 50).length;
  const summary = {
    generatedAt: new Date().toISOString(),
    indexedPages: pages,
    totalQuestions: results.length,
    withEvidence,
    withoutEvidence: results.length - withEvidence,
    lowConfidence,
    coverage: results.length ? Math.round((withEvidence / results.length) * 10000) / 100 : 0,
  };
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, JSON.stringify({ summary, results }, null, 2), 'utf8');
  console.log(JSON.stringify({ ...summary, reportFile }, null, 2));
}

main();
