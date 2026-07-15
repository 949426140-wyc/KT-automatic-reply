const assert = require('assert');
const bot = require('../auto-reply');

async function main() {
  await bot.ensureEngineReady();

  assert(bot.buildAmbiguousProductClarification('帮我写一个中枢阁的介绍话术').includes('哪一款中枢阁'));
  assert(bot.buildAmbiguousProductClarification('写中枢阁水槽款介绍话术') === '');
  assert(bot.buildAmbiguousProductClarification('写小怪物介绍话术').includes('转角小怪物'));
  assert(bot.buildAmbiguousProductClarification('写巧翼阁介绍话术') === '');
  assert(bot.buildAmbiguousProductFactClarification('中枢阁区分左右吗').includes('具体是哪款中枢阁'));
  assert(bot.buildAmbiguousProductFactClarification('中枢阁水槽款安装尺寸') === '');
  assert(bot.buildAmbiguousProductFactClarification('挂门宝的安装尺寸').includes('层数和柜体规格'));
  assert(bot.looksLikeProductQuestion('中枢阁区分左右吗'));
  assert(bot.looksLikeProductPlatformOperationQuestion('Mate2.0上只显示开门式，找不到抽屉式'));

  const factualPolicy = bot.getProductKnowledgeRetrievalPolicy('水槽侧拉的极限安装尺寸和结构是什么');
  assert(factualPolicy.factual);
  assert.deepStrictEqual(factualPolicy.options.pageTypes, ['fact']);
  const factualPrompt = bot.buildPromptProductKnowledge('水槽侧拉的极限安装尺寸和结构是什么');
  assert(factualPrompt.includes('仅来自结构化产品事实卡'));
  assert(!factualPrompt.includes('页面类型：planning'));
  assert(!factualPrompt.includes('页面类型：application'));

  const nonFactualPolicy = bot.getProductKnowledgeRetrievalPolicy('帮我写一段收纳设计建议');
  assert(!nonFactualPolicy.factual);

  const stockDecision = await bot.processSingleMessageForAutoReply({
    state: { repliedMsgs: {} },
    msg: { id: 'stock-test', time: '共享历史', sender: '自测用户', content: '250的轨道现在还有吗' },
    messages: [],
    title: '库存过滤自测',
    conversationId: 'stock-filter-test',
    targetType: 'group',
    sourcePrefix: '只读自测',
  });
  assert(stockDecision.action === 'skip');
  assert(stockDecision.reason === 'customer_service_or_order_block');

  const tokens = bot.extractReplyEvidenceTokens('型号51.203.0250B，柜体250，深度480mm，承重10KG');
  assert(tokens.includes('51.203.0250b'));
  assert(tokens.includes('250'));
  assert(tokens.includes('480mm'));
  assert(tokens.includes('10kg'));

  const supported = bot.validateReplyAgainstWiki(
    '水槽侧拉能不能装200柜并且连门',
    '水槽侧拉标准口径是51.203.0250B、250柜，不支持连门安装。'
  );
  assert(supported.valid, `正确证据被误拦截：${supported.unsupported.join('、')}`);

  const invented = bot.validateReplyAgainstWiki(
    '水槽侧拉能不能装200柜并且连门',
    '水槽侧拉可以安装在999柜，承重88KG。'
  );
  assert(!invented.valid);
  assert(invented.unsupported.includes('999'));
  assert(invented.unsupported.includes('88kg'));

  const magicWidth = bot.buildMagicDrawerParameterReplyFromKnowledge('魔法抽的标准规格有几个宽度');
  assert(magicWidth.includes('200-1200mm'));
  assert(magicWidth.includes('需要补充产品名称'));

  const magicDepth = bot.buildMagicDrawerParameterReplyFromKnowledge('魔法抽的标准规格深度是多少');
  assert(magicDepth.includes('480mm'));
  assert(magicDepth.includes('450mm轨道'));
  assert(!magicDepth.includes('650mm'));

  const magicCustomDepth = bot.buildMagicDrawerParameterReplyFromKnowledge('魔法抽深度定制有多少尺寸可以选择');
  assert(magicCustomDepth.includes('共9种轨道规格'));
  assert(magicCustomDepth.includes('250、300、350、400、450、500、550、600、650mm'));

  const otherProduct = bot.buildMagicDrawerParameterReplyFromKnowledge('尚酷抽的标准规格深度是多少');
  assert(otherProduct === '');

  console.log('✓ 产品名称歧义澄清测试通过');
  console.log('✓ 实时库存问法优先过滤测试通过');
  console.log('✓ 数字、型号和单位证据校验测试通过');
  console.log('✓ 事实检索与营销/设计内容隔离测试通过');
}

main().catch(error => { console.error(error); process.exit(1); });
