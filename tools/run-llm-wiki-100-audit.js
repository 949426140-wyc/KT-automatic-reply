const fs = require('fs');
const path = require('path');
const bot = require('../auto-reply');

const knowledgeRoot = process.env.AI_PLANNER_SOURCE_DIR || '/app/knowledge';
const reportFile = process.env.LLM_WIKI_100_REPORT || '/app/data/llm-wiki-100-audit.json';
const targetCount = Number(process.env.LLM_WIKI_AUDIT_COUNT || 100);

function addQuestion(list, seen, value, source) {
  const question = String(value || '').replace(/^[-*]\s*/, '').replace(/^['"]|['"]$/g, '').trim();
  if (question.length < 4 || question.length > 180 || seen.has(question)) return;
  if (/\.md$|知识库|当前章节|自动回复读取流程|矩阵索引/.test(question)) return;
  seen.add(question);
  list.push({ question, source });
}

function historicalQuestions() {
  const list = [];
  const seen = new Set();
  const files = [
    path.resolve(__dirname, '..', 'data', 'shared-history.json'),
    path.resolve(__dirname, '..', 'self-audit', 'product-self-audit.json'),
  ];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let payload;
    try { payload = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { continue; }
    const records = Array.isArray(payload) ? payload : Array.isArray(payload?.results) ? payload.results : [];
    for (const item of records) {
      let question = item.question || '';
      if (!question && item.user) question = (String(item.user).match(/(?:^|\n)内容[：:]\s*([\s\S]+)/) || [])[1] || '';
      addQuestion(list, seen, question, '历史问题');
    }
  }
  return { list, seen };
}

function cardQuestions(list, seen) {
  const dir = path.join(knowledgeRoot, '基础产品知识卡');
  if (!fs.existsSync(dir)) return;
  const preferred = /能不能|能否|可不可以|是否|怎么|如何|多少|多宽|多深|多高|是什么|是不是|区别|尺寸|安装|承重|材质|适配|兼容|定制|介绍/;
  for (const name of fs.readdirSync(dir).filter(file => file.endsWith('.md')).sort((a, b) => a.localeCompare(b, 'zh-CN'))) {
    const content = fs.readFileSync(path.join(dir, name), 'utf8');
    const frontmatter = content.startsWith('---') ? content.slice(3, content.indexOf('\n---', 3)) : '';
    const values = [...frontmatter.matchAll(/^\s+-\s+['"]?(.+?)['"]?\s*$/gm)].map(match => match[1]);
    const title = (content.match(/^#\s+(.+)$/m) || [])[1] || '';
    const candidates = values.filter(value => preferred.test(value));
    if (!candidates.length && title && preferred.test(title)) candidates.push(title);
    for (const value of candidates.slice(0, 2)) {
      addQuestion(list, seen, value, `基础卡:${name}`);
      if (list.length >= targetCount) return;
    }
  }
}

async function main() {
  await bot.ensureEngineReady();
  const { list, seen } = historicalQuestions();
  cardQuestions(list, seen);
  const samples = list.slice(0, targetCount);
  if (samples.length < targetCount) throw new Error(`只能构造 ${samples.length} 条有效样本，未达到 ${targetCount}`);

  const results = [];
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const msg = {
      id: `audit-100-${index + 1}`,
      time: '只读自测',
      sender: '100条自测用户',
      content: sample.question,
    };
    try {
      const decision = await bot.processSingleMessageForAutoReply({
        state: { repliedMsgs: {} },
        msg,
        messages: [msg],
        title: 'LLM Wiki 100条只读自测',
        conversationId: `audit-100-${index + 1}`,
        targetType: 'group',
        sourcePrefix: '100条只读自测',
      });
      results.push({
        number: index + 1,
        source: sample.source,
        question: sample.question,
        action: decision.action,
        reason: decision.reason || '',
        reply: decision.reply || '',
      });
    } catch (error) {
      results.push({ number: index + 1, source: sample.source, question: sample.question, action: 'error', reason: error.message, reply: '' });
    }
    if ((index + 1) % 10 === 0) console.log(`[100条自测] ${index + 1}/${targetCount}`);
  }

  const summary = results.reduce((acc, item) => {
    acc[item.action] = (acc[item.action] || 0) + 1;
    return acc;
  }, {});
  const suspicious = results.filter(item =>
    item.action === 'error' ||
    /我帮你查|稍后|不太确定|应该是|大概|估计/.test(item.reply) ||
    (/\d/.test(item.reply) && item.reason === 'bad_reply')
  );
  const report = { generatedAt: new Date().toISOString(), total: results.length, summary, suspiciousCount: suspicious.length, suspicious, results };
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ total: results.length, summary, suspiciousCount: suspicious.length, reportFile }));
}

main().catch(error => { console.error(error); process.exit(1); });
