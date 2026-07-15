const bot = require('../auto-reply');

const questions = [
  '魔法抽的标准规格有几个宽度',
  '魔法抽的标准规格深度是多少',
  '魔法抽深度定制有多少尺寸可以选择',
  '尚酷抽的标准规格深度是多少',
  '停机坪的标准规格深度是多少',
  '百纳阁有几个标准柜宽',
  '云阁升降机有几个标准柜宽',
];

async function main() {
  await bot.ensureEngineReady();
  const results = [];
  for (let index = 0; index < questions.length; index += 1) {
    const content = questions[index];
    const msg = { id: `parameter-test-${index}`, sender: '参数回归测试', time: new Date().toISOString(), content };
    const decision = await bot.processSingleMessageForAutoReply({
      state: { repliedMsgs: {} },
      msg,
      messages: [msg],
      title: '产品参数离线回归测试',
      conversationId: `parameter-test-${index}`,
      targetType: 'direct',
      sourcePrefix: '只读参数回归测试',
    });
    results.push({ content, action: decision.action, reason: decision.reason, reply: decision.reply || '', review: decision.review || null });
  }
  console.log(JSON.stringify(results, null, 2));
}

main().catch(error => { console.error(error); process.exit(1); });
