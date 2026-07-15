const fs = require('fs');
const path = require('path');
const bot = require('../auto-reply');

const sourceRoot = process.env.DINGTALK_HISTORY_ROOT || '/dingtalk-source';
const reportFile = process.env.DINGTALK_100_MD_REPORT || '/app/data/钉钉群100个产品问题内部模拟回复.md';
const jsonReportFile = reportFile.replace(/\.md$/i, '.json');
const limit = Number(process.env.DINGTALK_AUDIT_LIMIT || 100);
const fallbackReportFile = process.env.DINGTALK_AUDIT_FALLBACK_REPORT || '/dingtalk-source/data/钉钉群100个产品问题内部模拟回复_屏蔽员工.json';
const fallbackReportFile2 = process.env.DINGTALK_AUDIT_FALLBACK_REPORT_2 || '/dingtalk-source/data/钉钉群100个产品问题内部模拟回复.json';
const pendingKnowledgeHistoryFile = process.env.DINGTALK_AUDIT_PENDING_HISTORY || '/dingtalk-source/产品知识库/酷太自动回复待确认.md';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { return null; }
}

function redact(value) {
  return String(value || '').replace(/1\d{10}/g, '手机号已隐藏').replace(/\b(?:KT|S|E)\d{8,}\b/gi, '订单号已隐藏');
}

function cleanContent(value) {
  return String(value || '')
    .replace(/\[图片消息\][^\n]*/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@[^\s，。,:：]{1,30}(?:\([^)]*\))?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractConversationCache(file, output) {
  const records = readJson(file);
  if (!Array.isArray(records)) return;
  const group = path.basename(file, '.json');
  for (const record of records) {
    for (const line of String(record.user || '').split(/\r?\n/)) {
      const match = line.match(/^\[([^\]]+)\]\s*([^:：]+)[:：]\s*(.+)$/);
      if (!match) continue;
      output.push({ group, time: match[1], sender: match[2].trim(), content: cleanContent(match[3]), rawContent: String(match[3]), source: '群会话缓存' });
    }
  }
}

function extractSharedHistory(file, output) {
  const records = readJson(file);
  if (!Array.isArray(records)) return;
  for (const record of records) {
    const match = String(record.user || '').match(/^\[([^\]]+)\]\s*([^:：]+)[:：]\s*([\s\S]+)$/);
    if (!match) continue;
    output.push({ group: '共享群历史', time: match[1], sender: match[2].trim(), content: cleanContent(match[3]), rawContent: String(match[3]), source: '共享历史' });
  }
}

function extractLearningCases(file, output) {
  const cases = readJson(file);
  if (!Array.isArray(cases)) return;
  for (const item of cases) {
    for (const message of Array.isArray(item.messages) ? item.messages : []) {
      output.push({
        group: item.title || item.openConversationId || '客服群',
        time: message.createTime || '',
        sender: message.sender || message.role || '',
        role: message.role || '',
        content: cleanContent(message.content),
        rawContent: String(message.content || ''),
        source: '客服群学习记录',
      });
    }
  }
}

function extractLearnedThreads(file, output) {
  const threads = readJson(file);
  if (!Array.isArray(threads)) return;
  for (const thread of threads) {
    for (const message of Array.isArray(thread.rawMessages) ? thread.rawMessages : []) {
      output.push({
        group: thread.group || thread.topic || '客服群',
        time: message.createTime || thread.date || '',
        sender: message.sender || '',
        content: cleanContent(message.content),
        rawContent: String(message.content || ''),
        source: '钉钉群历史学习缓存',
      });
    }
  }
}

function extractHistoricalReportFallback(file, output) {
  const report = readJson(file);
  if (!Array.isArray(report?.results)) return;
  for (const item of report.results) {
    if (!item?.content) continue;
    output.push({
      group: item.group || '历史钉钉群',
      time: item.time || '',
      sender: item.sender || '',
      role: item.role || '',
      content: cleanContent(item.content),
      rawContent: String(item.content || ''),
      source: '历史钉钉100题回放源',
    });
  }
}

// 这是此前从真实钉钉群整理出来、尚待知识确认的原始上下文。每个“上下文”段落
// 独立成一个会话，避免跨段落把无关产品信息拼接成伪上下文。
function extractPendingKnowledgeHistory(file, output) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  const contexts = text.split(/^\s*-\s*上下文：/m).slice(1);
  for (let contextIndex = 0; contextIndex < contexts.length; contextIndex += 1) {
    const block = contexts[contextIndex]
      .split(/\r?\n##\s+/)[0]
      .split(/\r?\n-\s*(?:原消息|判定|建议口径|建议|备注|结论)：/)[0];
    const matches = block.matchAll(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+([^:：|]{1,80})[：:]\s*([\s\S]*?)(?=\s*\|\s*\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+[^:：|]{1,80}[：:]|$)/g);
    for (const match of matches) {
      const rawContent = String(match[3] || '').trim();
      if (!rawContent) continue;
      output.push({
        group: `待确认群历史-${contextIndex + 1}`,
        time: match[1],
        sender: match[2].trim(),
        content: cleanContent(rawContent),
        rawContent,
        source: '钉钉群历史待确认记录',
      });
    }
  }
}

function gatherMessages() {
  const output = [];
  const conversationsDir = path.join(sourceRoot, 'data', 'conversations');
  if (fs.existsSync(conversationsDir)) {
    for (const name of fs.readdirSync(conversationsDir).filter(file => file.endsWith('.json'))) {
      extractConversationCache(path.join(conversationsDir, name), output);
    }
  }
  extractSharedHistory(path.join(sourceRoot, 'data', 'shared-history.json'), output);
  extractLearningCases(path.join(sourceRoot, '产品知识库', '酷太客服群聊学习候选规则.json'), output);
  extractLearnedThreads(path.join(sourceRoot, 'learned-threads.json'), output);
  // 回放此前已从真实钉钉历史拉取的原始问题文本；不造题、不补模糊问句。
  extractHistoricalReportFallback(fallbackReportFile, output);
  extractHistoricalReportFallback(fallbackReportFile2, output);
  extractPendingKnowledgeHistory(pendingKnowledgeHistoryFile, output);
  return output;
}

function isExcludedBusinessQuestion(text) {
  return /发货|物流|快递|单号|订单|下单|退款|退货|换货|补发|取件|运费|付款|支付|价格|多少钱|报价|折扣|优惠|库存|有货|缺货|上架|下架|商城|小程序|发票|合同|财务|客资|报备|售后|投诉|直播|打款|返差|账号|登录|验证码/.test(text);
}

function isProductQuestion(text) {
  if (!text || text.length < 4 || text.length > 220) return false;
  if (isExcludedBusinessQuestion(text)) return false;
  if (bot.looksLikeProductPlatformOperationQuestion(text)) return false;
  if (!bot.looksLikeProductQuestion(text)) return false;
  const normalized = text.replace(/\s+/g, '');
  const explicitQuestion = /[?？]|吗(?:呀|啊|呢)?$|么(?:呀|啊|呢)?$|多少(?:呀|啊|呢)?$|怎么(?:办|装|用|选|拆|调|处理)?|如何|能否|能不能|可不可以|是否|是不是|有没有|有没|哪(?:个|款|种|边|里)|什么|多宽|多深|多高|多大|区别|区分|需要.*吗|可以.*吗|能.*吗|装.*吗|做.*吗|定制.*吗/.test(normalized);
  if (!explicitQuestion) return false;
  const answerLike = /^(可以|不可以|能装|不能装|需要的|是的|不是|建议|规格[:：]|尺寸[:：]|安装方法[:：]|注意[:：])/.test(normalized);
  return !answerLike;
}

function selectQuestions(messages) {
  const seen = new Set();
  const selected = [];
  const contextSkipped = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const key = message.content.toLowerCase().replace(/\s+/g, '');
    if (message.role === '员工' || bot.isEmployeeSender(message.sender, message.senderUserId || '')) continue;
    if (!isProductQuestion(message.content) || seen.has(key)) continue;
    const contextMessages = messages
      .slice(Math.max(0, index - 6), Math.min(messages.length, index + 3))
      .filter(item => item.source === message.source && item.group === message.group);
    const contextText = contextMessages.map(item => `${item.time} ${item.sender}: ${item.rawContent || item.content}`).join('\n');
    const resolution = bot.assessContextResolution(message.content, contextText);
    // 无法从同一会话前后文定位到产品/型号的指代句，不是可审计的具体问题。
    const hasContextImage = contextMessages.some(item => /\[图片消息\]|mediaId=/.test(item.rawContent || ''));
    if (resolution.needsContext && !resolution.resolved && !hasContextImage) {
      contextSkipped.push({
        ...message,
        reasonCode: 'ambiguous_context_unresolved',
        reason: toChineseReason('ambiguous_context_unresolved'),
      });
      continue;
    }
    seen.add(key);
    selected.push({ ...message, contextMessages, contextText });
  }
  return { selected, contextSkipped };
}

function markdownEscape(value) {
  return redact(value).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function toChineseReason(reason) {
  return bot.describeDecisionReason(reason);
}

async function main() {
  await bot.ensureEngineReady();
  const messages = gatherMessages();
  const employeeMessages = messages.filter(message => message.role === '员工' || bot.isEmployeeSender(message.sender, message.senderUserId || ''));
  const { selected, contextSkipped } = selectQuestions(messages);
  if (process.env.DINGTALK_AUDIT_DRY_RUN === 'true') {
    console.log(JSON.stringify({ messages: messages.length, employeeMessagesSkipped: employeeMessages.length, selected: selected.length, contextSkipped: contextSkipped.length, questions: selected.map(item => item.content) }, null, 2));
    return;
  }
  if (selected.length < limit) {
    throw new Error(`当前缓存与历史真实取样中只筛出 ${selected.length} 个去重产品问题，未达到 ${limit}；未使用知识卡或人工问题补数。`);
  }

  const results = [];
  for (let index = 0; index < selected.length && results.length < limit; index += 1) {
    const item = selected[index];
    const msg = { id: `dingtalk-product-${index + 1}`, time: item.time, sender: item.sender, content: item.content };
    try {
      const decision = await bot.processSingleMessageForAutoReply({
        state: { repliedMsgs: {} },
        msg,
        messages: item.contextMessages.length ? item.contextMessages.map((row, contextIndex) => ({
          id: row === item ? msg.id : `dingtalk-context-${index + 1}-${contextIndex}`,
          time: row.time,
          sender: row.sender,
          content: row.rawContent || row.content,
        })) : [msg],
        title: item.group,
        conversationId: `offline-${index + 1}`,
        targetType: 'group',
        sourcePrefix: '钉钉群100产品问题只读模拟',
      });
      // 图片和文字上下文仍无法定位产品的跟问，不能作为“产品问题”单独出现在审计报告里。
      if (decision.reason !== 'ambiguous_context_unresolved') {
        results.push({
          ...item,
          number: results.length + 1,
          action: decision.action,
          reasonCode: decision.reason || '',
          reason: decision.reasonText || toChineseReason(decision.reason),
          reply: decision.reply || '',
          contextAnalysis: decision.contextAnalysis || null,
        });
      } else {
        contextSkipped.push({ ...item, reasonCode: decision.reason, reason: toChineseReason(decision.reason) });
      }
    } catch (error) {
      results.push({ ...item, number: results.length + 1, action: 'error', reasonCode: 'runtime_error', reason: `模拟运行异常：${error.message}`, reply: '' });
    }
    if ((index + 1) % 10 === 0) console.log(`[钉钉100产品问题] 已检查 ${index + 1} 条候选，已保留 ${results.length}/${limit}`);
  }

  if (results.length < limit) {
    throw new Error(`上下文过滤后只保留 ${results.length} 个可定位产品问题，未达到 ${limit}；不使用模糊跟问补数。`);
  }

  const summary = results.reduce((acc, item) => {
    acc[item.action] = (acc[item.action] || 0) + 1;
    return acc;
  }, {});
  const lines = [
    '# 钉钉群100个产品问题内部模拟回复报告',
    '',
    `> 生成时间：${new Date().toISOString()}`,
    '> 数据范围：本机此前通过钉钉接口同步的真实群会话缓存、共享群历史和客服群学习记录。',
    '> 若当前缓存不足100个候选，会追加“历史钉钉100题回放源”中的原始问题文本重新模拟；该来源为先前真实取样，不生成虚构问题。',
    '> 本轮还使用“钉钉群历史待确认记录”补足历史原文；只取其中带发送人、且通过员工过滤的具体产品问句。',
    '> 人员过滤：取样前已按员工角色、员工姓名关键词和员工 userId 排除内部员工消息；员工回复不进入100条问题样本。',
    '> 安全说明：本轮只做内部模拟，没有提供发送接口，不会向任何钉钉群发送消息。群名中的手机号和订单号已隐藏。',
    '',
    '## 汇总',
    '',
    `- 原始群消息数：${messages.length}`,
    `- 取样前排除员工消息：${employeeMessages.length}`,
    `- 筛选后的产品问题：${results.length}`,
    `- 可回复候选：${summary.reply_ready || 0}`,
    `- 转人工确认：${(summary.review || 0) + (summary.queued || 0)}`,
    `- 本地过滤/跳过：${summary.skip || 0}`,
    `- 运行错误：${summary.error || 0}`,
    '',
    '## 100个产品问题模拟结果',
    '',
  ];

  for (const item of results) {
    lines.push(`### ${String(item.number).padStart(3, '0')}｜${markdownEscape(item.content)}`);
    lines.push('');
    lines.push(`- 来源：${markdownEscape(item.source)}`);
    lines.push(`- 群：${markdownEscape(item.group)}`);
    lines.push(`- 时间：${markdownEscape(item.time)}`);
    lines.push(`- 发送人：${markdownEscape(item.sender)}`);
    lines.push(`- 决策：${item.action}`);
    lines.push(`- 原因：${markdownEscape(item.reason) || '—'}`);
    if (item.contextAnalysis) {
      lines.push(`- 上下文识别：${markdownEscape(item.contextAnalysis.problemTypeText || '尚未确认')}；产品：${markdownEscape((item.contextAnalysis.productAnchors || []).join('、') || '未唯一定位')}；置信度：${markdownEscape(item.contextAnalysis.confidence || 'low')}`);
      if (item.contextAnalysis.evidence?.length) lines.push(`- 识别依据：${markdownEscape(item.contextAnalysis.evidence.join('；'))}`);
    }
    lines.push('');
    lines.push('模拟回复：');
    lines.push('');
    lines.push(item.reply ? redact(item.reply) : '（不自动回复）');
    lines.push('');
  }

  const skipped = results.filter(item => item.action === 'skip');
  lines.push('## 本轮跳过清单（后置复核）');
  lines.push('');
  lines.push('> 本节不省略任何已跳过产品问题。请重点复核“跳过原因”是否合理；订单/物流/售后/商城操作等业务问题通常应保持跳过，产品问题但上下文不足的跳过应等待补充产品名、型号、尺寸或可识别图片。');
  lines.push('');
  if (!skipped.length) {
    lines.push('本轮没有跳过项。');
    lines.push('');
  }
  for (const item of skipped) {
    lines.push(`### 跳过-${String(item.number).padStart(3, '0')}｜${markdownEscape(item.content)}`);
    lines.push('');
    lines.push(`- 来源：${markdownEscape(item.source)}`);
    lines.push(`- 群：${markdownEscape(item.group)}`);
    lines.push(`- 发送人：${markdownEscape(item.sender)}`);
    lines.push(`- 跳过原因：${markdownEscape(item.reason) || '—'}`);
    if (item.contextAnalysis) {
      lines.push(`- 上下文识别：${markdownEscape(item.contextAnalysis.problemTypeText || '尚未确认')}；产品：${markdownEscape((item.contextAnalysis.productAnchors || []).join('、') || '未唯一定位')}；置信度：${markdownEscape(item.contextAnalysis.confidence || 'low')}`);
      if (item.contextAnalysis.evidence?.length) lines.push(`- 识别依据：${markdownEscape(item.contextAnalysis.evidence.join('；'))}`);
    }
    lines.push(`- 初步判定：${/customer_service|order|configuration|platform/.test(item.reasonCode || '') ? '业务/下单流程类，通常合理跳过' : '需结合产品上下文复核；缺少定位信息时不自动回复'}`);
    lines.push('');
  }

  lines.push('## 取样阶段跳过清单（未计入100题）');
  lines.push('');
  lines.push('> 这些是有问句形式、但从同一段对话和可识别图片中仍不能唯一定位产品或配件的指代型问题。它们没有进入100个具体产品问题，也不会在生产环境直接回复。');
  lines.push('');
  if (!contextSkipped.length) {
    lines.push('本轮没有此类取样阶段跳过项。');
    lines.push('');
  }
  for (const item of contextSkipped) {
    lines.push(`### 取样跳过｜${markdownEscape(item.content)}`);
    lines.push('');
    lines.push(`- 来源：${markdownEscape(item.source)}`);
    lines.push(`- 群：${markdownEscape(item.group)}`);
    lines.push(`- 发送人：${markdownEscape(item.sender)}`);
    lines.push(`- 跳过原因：${markdownEscape(item.reasonCode ? toChineseReason(item.reasonCode) : item.reason)}`);
    lines.push('- 处理：需要补充同一会话中能定位产品/型号/尺寸的文字或可识别图片，才能重新进入模拟或生产回复。');
    lines.push('');
  }

  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, lines.join('\n'), 'utf8');
  fs.writeFileSync(jsonReportFile, JSON.stringify({ generatedAt: new Date().toISOString(), total: results.length, summary, results, contextSkipped }, null, 2), 'utf8');
  console.log(JSON.stringify({ total: results.length, summary, reportFile, jsonReportFile }));
}

main().catch(error => { console.error(error); process.exit(1); });
