const assert = require('assert');
const bot = require('../auto-reply');

async function main() {
  const unresolved = bot.assessContextResolution('还有这个抽中抽的构件是通用的么', '客户：这个有安装视频吗\n客户：安装在哪里');
  assert(unresolved.needsContext && !unresolved.resolved, '抽中抽构件未定位时必须视为上下文不完整');

  const resolved = bot.assessContextResolution('这个有安装视频吗', '客户：之行阁双层抽屉款怎么安装');
  assert(resolved.needsContext && resolved.resolved && resolved.anchors.includes('之行阁'), '明确产品名的上文应可定位');
  assert(bot.looksLikeOrderConfigurationQuestion('定制565深度，轨道自动带不出吗？'), '轨道选项自动带出属于下单页面配置问题');
  assert(bot.looksLikeDiscontinuedLegacySeriesAfterSalesQuestion('三代的调料抽其中一根导轨能卖吗？'), '三代旧系列必须按售后处理');
  assert(bot.looksLikeDiscontinuedLegacySeriesAfterSalesQuestion('易酷调料抽还能装吗？'), '易酷旧系列必须按售后处理');
  assert(bot.looksLikeDrawerDividerMaterialQuestion('您好我们抽屉的分隔片是什么材质？'), '应识别抽屉分隔件材质问题');
  assert(bot.isEmployeeSender('深圳酷太总客服'), '总客服账号必须按员工排除');
  assert(bot.isEmployeeSender('客服1号'), '客服编号账号必须按员工排除');
  assert(bot.needsProductConfirmationForCabinetDepthInstallation('我柜内深度530 装了平开门铰链 这个装不下了 这个还能往后装装吗？'), '柜深加铰链但未说明产品时必须人工确认');
  assert(!bot.needsProductConfirmationForCabinetDepthInstallation('我柜内深度530 装了平开门铰链 这个装不下了', '客户前文：魔法抽能安装吗？'), '上文已有具体产品时不应误判为无产品上下文');
  assert.strictEqual(bot.sanitizeReplyAddressees('王贵芹你好，你问的是挂钩配件。', ['王贵芹']), '你好，你问的是挂钩配件。');
  assert.strictEqual(bot.classifyContextualBusinessFlow('不影响的对吗？会发挂钩的对吧', '上文：我选择的是挂钩，付款页面变成这样了'), 'order_payment_page_context');
  assert.strictEqual(bot.classifyContextualBusinessFlow('组合的细节尺寸在哪里看呀', '图片识别：圆方付款页面，已选择挂钩'), 'order_payment_page_context');
  assert.strictEqual(bot.classifyContextualBusinessFlow('哪个定制，标品吧', '客户：这个订单怎么还没发货，麻烦催一下'), 'logistics_followup_context');
  assert.strictEqual(bot.classifyContextualBusinessFlow('然后这里的配件是这样的吗？', '', '图片识别：圆方商城商品规格页面，包含已选规格和立即购买按钮'), 'order_flow_context');
  assert.strictEqual(bot.classifyContextualBusinessFlow('这个能补发吗？', '客户：收到后发现少了一个配件'), 'after_sales_context');

  const paymentAnalysis = bot.analyzeConversationContext(
    '不影响的对吗？会发挂钩的对吧',
    '我选择的是挂钩，付款页面变成这样了',
    '圆方商城订单确认页'
  );
  assert.strictEqual(paymentAnalysis.problemType, 'order_payment');
  assert.strictEqual(paymentAnalysis.confidence, 'high');
  assert(paymentAnalysis.evidence.some(item => item.includes('业务上下文')), '上下文解析应保留业务判断依据');

  const productAnalysis = bot.analyzeConversationContext('定制尺寸怎么写？', '70H 魔法抽，600柜单开门', '');
  assert.strictEqual(productAnalysis.problemType, 'dimension');
  assert(productAnalysis.productAnchors.includes('魔法抽'), '应能从前文定位魔法抽');
  assert(productAnalysis.dimensions.some(item => item.includes('600')), '应提取600柜尺寸线索');
  assert(productAnalysis.doorTypes.includes('单开门'), '应提取单开门线索');

  const vagueResolved = bot.assessContextResolution('这个尺寸可以做吗？', '客户：魔法抽600柜单开门');
  assert(vagueResolved.needsContext && vagueResolved.resolved && vagueResolved.anchors.includes('魔法抽'), '模糊尺寸问句应从上文定位唯一产品');
  const vagueUnresolved = bot.assessContextResolution('这个尺寸可以做吗？', '客户：请问一下');
  assert(vagueUnresolved.needsContext && !vagueUnresolved.resolved, '模糊尺寸问句没有产品锚点时必须抑制');

  await bot.ensureEngineReady();
  const messages = [
    { id: 'ctx-1', sender: '客户', time: '2026-06-08T10:01:31', content: '还有这个抽中抽的构件是通用的么' },
    { id: 'ctx-2', sender: '客户', time: '2026-06-08T10:01:47', content: '这个有安装视频吗' },
    { id: 'ctx-3', sender: '客户', time: '2026-06-08T10:02:43', content: '安装在哪里' },
  ];
  for (const msg of messages) {
    const decision = await bot.processSingleMessageForAutoReply({
      state: { repliedMsgs: {} }, msg, messages, title: '上下文回归测试', conversationId: 'context-test', targetType: 'group', sourcePrefix: '只读回归测试',
    });
    assert.strictEqual(decision.action, 'skip');
    assert.strictEqual(decision.reason, 'ambiguous_context_unresolved');
  }
  const orderMsg = { id: 'order-config-1', sender: '门店', time: '2026-06-25T11:06:23', content: '定制565深度，轨道自动带不出吗？' };
  const orderDecision = await bot.processSingleMessageForAutoReply({
    state: { repliedMsgs: {} }, msg: orderMsg, messages: [orderMsg], title: '下单配置回归测试', conversationId: 'order-config-test', targetType: 'group', sourcePrefix: '只读回归测试',
  });
  assert.strictEqual(orderDecision.action, 'skip');
  assert.strictEqual(orderDecision.reason, 'order_configuration_question');
  const legacyMsg = { id: 'legacy-series-1', sender: '门店', time: '2026-06-26T12:06:57', content: '三代的这个调料抽其中一根导轨能卖吗？' };
  const legacyDecision = await bot.processSingleMessageForAutoReply({
    state: { repliedMsgs: {} }, msg: legacyMsg, messages: [legacyMsg], title: '旧系列售后回归测试', conversationId: 'legacy-series-test', targetType: 'group', sourcePrefix: '只读回归测试',
  });
  assert.strictEqual(legacyDecision.action, 'skip');
  assert.strictEqual(legacyDecision.reason, 'discontinued_legacy_series_after_sales');
  assert.strictEqual(legacyDecision.reasonText, '涉及已下架的三代或易酷旧系列，按售后问题处理，不自动回复。');
  const dividerMaterialMsg = { id: 'divider-material-1', sender: '门店', time: '2026-05-24T16:55:52', content: '您好我们抽屉的分隔片是什么材质？' };
  const dividerMaterialDecision = await bot.processSingleMessageForAutoReply({
    state: { repliedMsgs: {} }, msg: dividerMaterialMsg, messages: [dividerMaterialMsg], title: '分隔片材质回归测试', conversationId: 'divider-material-test', targetType: 'group', sourcePrefix: '只读回归测试',
  });
  assert.strictEqual(dividerMaterialDecision.action, 'reply_ready');
  assert.strictEqual(dividerMaterialDecision.reason, 'no_sender_callback');
  assert.strictEqual(dividerMaterialDecision.reply, '抽屉内的分隔杆为六系铝合金；短分隔片为ABS材质。');
  const unresolvedInstallationMsg = { id: 'unresolved-installation-1', sender: '门店', time: '2026-05-20T10:14:48', content: '我柜内深度530 装了平开门铰链 这个装不下了 这个还能往后装装吗？' };
  const unresolvedInstallationDecision = await bot.processSingleMessageForAutoReply({
    state: { repliedMsgs: {} }, msg: unresolvedInstallationMsg, messages: [unresolvedInstallationMsg], title: '安装上下文回归测试', conversationId: 'unresolved-installation-test', targetType: 'group', sourcePrefix: '只读回归测试',
  });
  assert.strictEqual(unresolvedInstallationDecision.action, 'review');
  assert.strictEqual(unresolvedInstallationDecision.reason, 'unresolved_product_context_for_installation');
  assert.strictEqual(unresolvedInstallationDecision.reasonText, '问题涉及柜深、铰链和安装位置，但未能确认具体产品，不能套用抽屉安装公式，已转人工确认。');
  const paymentThread = [
    { id: 'payment-context-1', sender: '门店用户', time: '2026-05-21T10:39:20', content: '我选择的时候是挂钩，付款页面变成这样了' },
    { id: 'payment-context-2', sender: '门店用户', time: '2026-05-21T10:40:09', content: '不影响的对吗？会发挂钩的对吧' },
    { id: 'payment-context-3', sender: '门店用户', time: '2026-05-21T10:41:29', content: '你好，请教一下，我想看一下组合的细节尺寸在哪里可以看呀' },
  ];
  for (const paymentMsg of paymentThread.slice(1)) {
    const paymentDecision = await bot.processSingleMessageForAutoReply({
      state: { repliedMsgs: {} }, msg: paymentMsg, messages: paymentThread, title: '付款页面上下文回归测试', conversationId: `payment-context-${paymentMsg.id}`, targetType: 'group', sourcePrefix: '只读回归测试',
    });
    assert.strictEqual(paymentDecision.action, 'skip');
    assert.strictEqual(paymentDecision.reason, 'order_payment_page_context');
  }
  const magicDrawerWidthThread = [
    { id: 'magic-width-1', sender: '门店用户', time: '2026-05-19T14:21:57', content: '70H 魔法空抽没有 600 柜单开门的吗？' },
    { id: 'magic-width-2', sender: '门店用户', time: '2026-05-19T14:23:11', content: '600 的单开门要定制？' },
    { id: 'magic-width-3', sender: '门店用户', time: '2026-05-19T14:23:34', content: '定制范畴？' },
    { id: 'magic-width-4', sender: '门店用户', time: '2026-05-19T14:27:57', content: '定制尺寸直接写标准的 600 柜单开门可以吗？' },
  ];
  for (const magicMsg of magicDrawerWidthThread) {
    const magicDecision = await bot.processSingleMessageForAutoReply({
      state: { repliedMsgs: {} }, msg: magicMsg, messages: magicDrawerWidthThread, title: '魔法抽宽度上下文回归测试', conversationId: `magic-width-${magicMsg.id}`, targetType: 'group', sourcePrefix: '只读回归测试',
    });
    assert.strictEqual(magicDecision.action, 'reply_ready');
    assert(/600-18×2.*-11×2.*-25.*517mm/.test(magicDecision.reply || ''));
  }
  console.log('上下文定位与模糊问句抑制测试通过');
}

main().catch(error => { console.error(error); process.exit(1); });
