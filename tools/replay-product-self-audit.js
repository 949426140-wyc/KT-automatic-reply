/*
 * 只读回放历史钉钉群消息：不发送、不写生产审计日志。
 * 用法由 Docker 运行，并通过 HISTORY_DIR / SELF_AUDIT_REPORT 指定输入与报告。
 */
const fs = require('fs');
const path = require('path');
const bot = require('../auto-reply');

const historyDir = process.env.HISTORY_DIR || '/source/conversations';
const reportFile = process.env.SELF_AUDIT_REPORT || '/output/product-self-audit.json';
const productCue = /抽屉|轨道|导轨|安装|尺寸|柜体|柜内|净宽|净深|净高|魔法抽|尚酷|中枢阁|翼枢阁|挂门宝|云狐|云梯|云阁|百纳阁|小怪物|拉篮|升降机|收纳架|挂盒|门板|碗碟|锅具|调料|水槽|承重|深度|宽度|高度|定制|连门|开门/;

function readHistoryMessages() {
  const seen = new Set();
  const messages = [];
  for (const entry of fs.readdirSync(historyDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    let records = [];
    try { records = JSON.parse(fs.readFileSync(path.join(historyDir, entry.name), 'utf8')); } catch { continue; }
    for (const record of Array.isArray(records) ? records : []) {
      const raw = String(record.user || '');
      const compactContent = (raw.match(/(?:^|\n)内容[：:]\s*([\s\S]+)/) || [])[1]?.trim();
      const sender = (raw.match(/(?:^|\n)发送人[：:]\s*([^\r\n]+)/) || [])[1]?.trim() || '历史用户';
      const lines = compactContent ? [`[共享历史] ${sender}: ${compactContent}`] : raw.split(/\r?\n/);
      for (const line of lines) {
        const match = line.match(/^\[([^\]]+)\]\s*([^:：]+)[:：]\s*(.+)$/);
        if (!match) continue;
        const content = match[3].replace(/\[图片消息\][\s\S]*/g, '').trim();
        if (content.length < 4 || content.length > 240 || !productCue.test(content)) continue;
        const id = `${entry.name}:${match[1]}:${content}`;
        if (seen.has(id)) continue;
        seen.add(id);
        messages.push({ id: `replay-${messages.length + 1}`, time: match[1], sender: match[2].trim(), content, file: entry.name });
      }
    }
  }
  return messages.slice(0, 100);
}

async function main() {
  await bot.ensureEngineReady();
  const inputs = readHistoryMessages();
  const results = [];
  for (const msg of inputs) {
    const decision = await bot.processSingleMessageForAutoReply({
      state: { repliedMsgs: {} }, msg, messages: [msg], title: '历史回放',
      conversationId: `replay-${msg.file}`, targetType: 'group', sourcePrefix: '历史回放',
      // 不提供 send，因此任何“回复”均只生成候选，不会发送到钉钉。
    });
    results.push({ question: msg.content, action: decision.action, reason: decision.reason || '', decision: decision.deepseekDecision || '', reply: decision.reply || '' });
  }
  const summary = results.reduce((acc, item) => { acc[item.action] = (acc[item.action] || 0) + 1; return acc; }, {});
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, JSON.stringify({ generatedAt: new Date().toISOString(), total: results.length, summary, results }, null, 2), 'utf8');
  console.log(JSON.stringify({ total: results.length, summary, reportFile }));
}

main().catch(error => { console.error(error); process.exit(1); });
