/**
 * 钉钉群消息 AI 自动回复服务
 * 轮询未读消息 → AI 理解上下文 → 自动回复
 */
const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { LlmWiki } = require('./lib/llm-wiki');
const { quoteForShell } = require('./lib/shell');
const { renderReviewQueueMarkdown } = require('./lib/review-queue');
const { parseDwsJson } = require('./lib/dws-client');
const AUTO_REPLY_RULES = require('./config/auto-reply-rules.json');
const {
  downloadOriginalMedia,
  recognizeImage: recognizeOriginalImage,
} = require('./image-recognizer');
const DWS_BIN = process.platform === 'win32' ? 'dws.cmd' : 'dws';
require('dotenv').config({ path: __dirname + '/.env' });
const IS_MAIN = require.main === module;

// ====== 硬禁用开关 ======
const DISABLED_FILE = path.join(__dirname, 'auto-reply.disabled');
const BOOT_PENDING_REVIEW_MODE = process.env.PENDING_REVIEW_MODE === 'true';
if (IS_MAIN && fs.existsSync(DISABLED_FILE) && !BOOT_PENDING_REVIEW_MODE) {
  console.log('[启动拦截] 检测到 auto-reply.disabled，自动回复服务已禁用。');
  process.exit(0);
}
if (IS_MAIN && fs.existsSync(DISABLED_FILE) && BOOT_PENDING_REVIEW_MODE) {
  console.log('[启动] 检测到 auto-reply.disabled；待回复扫描模式继续运行，但不会自动发送钉钉消息。');
}

// ====== 单实例锁 ======
const PID_FILE = path.join(__dirname, 'auto-reply.pid');
const myPid = process.pid;

function isSafeToTerminatePreviousAutoReply(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === myPid) return false;
  // Windows 无法可靠读取进程命令行；不再仅凭 PID 结束未知进程。
  if (process.platform === 'win32') return false;
  try {
    const commandLine = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
    return commandLine.includes('auto-reply.js');
  } catch (_) {
    return false;
  }
}

if (IS_MAIN && fs.existsSync(PID_FILE)) {
  const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim());
  if (isSafeToTerminatePreviousAutoReply(oldPid)) {
    try { process.kill(oldPid, 'SIGTERM'); } catch (_) {}
    console.log(`[启动] 已终止旧自动回复进程 PID=${oldPid}`);
  } else if (oldPid && oldPid !== myPid) {
    console.warn(`[启动] 发现旧 PID=${oldPid}，未验证为自动回复进程，不执行终止。`);
  }
}
if (IS_MAIN) fs.writeFileSync(PID_FILE, String(myPid));

// ====== AI 前关键词过滤（不送 AI，直接 SKIP） ======
const BLOCK_KEYWORDS = AUTO_REPLY_RULES.blockKeywords;

function shouldBlock(content) {
  const text = String(content || '');
  return BLOCK_KEYWORDS.some(kw => text.includes(kw)) ||
    looksLikeDiscontinuedLegacySeriesAfterSalesQuestion(text) ||
    looksLikeStockAvailabilityQuestion(text) ||
    /(?:打)?[一二三四五六七八九十\d]+折/.test(text) ||
    looksLikeOrderingAction(text) ||
    looksLikeListingOrReleaseQuestion(text) ||
    looksLikeComponentSwapOrderingAction(text) ||
    looksLikeProductExchangeAfterSalesQuestion(text) ||
    looksLikeAfterSalesInstallAbnormalQuestion(text);
}

// 目前在售抽屉体系只有魔法抽、尚酷；“三代”和“易酷”均为已下架旧系列。
// 旧系列的导轨、配件、安装、替换等提问一律按售后处理，不能用现售产品知识作答。
function looksLikeDiscontinuedLegacySeriesAfterSalesQuestion(content, context = '') {
  const text = `${content || ''}\n${context || ''}`.replace(/\s+/g, '');
  return /三代|易酷/.test(text);
}

function looksLikeDrawerDividerMaterialQuestion(content) {
  const text = String(content || '').replace(/\s+/g, '');
  if (!/(分隔片|分割片|分隔杆|分割杆)/.test(text)) return false;
  return /材质|什么材|什么做|啥材质|啥做|什么材料|啥材料/.test(text);
}

function buildDrawerDividerMaterialReply(content) {
  if (!looksLikeDrawerDividerMaterialQuestion(content)) return '';
  return '抽屉内的分隔杆为六系铝合金；短分隔片为ABS材质。';
}

// 库存属于实时业务数据，不能交给模型猜测。除了“库存/有货”外，
// 还要识别业务中最常见的口语问法，例如“250 的轨道现在还有吗”。
function looksLikeStockAvailabilityQuestion(content) {
  const text = String(content || '').replace(/\s+/g, '');
  if (!text) return false;
  return /(?:现在|目前|这款|这个|该|[\d一二三四五六七八九十]+(?:的)?(?:轨道|导轨|抽屉|拉篮|配件|产品|款))?(?:还有|有没有|有没|是否有)(?:货|现货|库存|吗|可用)?$/.test(text) ||
    /(?:是否|能否|可否)(?:有|提供).{0,8}(?:现货|库存)/.test(text);
}

function looksLikeRailSpecificationQuestion(content) {
  const text = String(content || '').replace(/\s+/g, '');
  if (/现在|目前|还有|有货|现货|库存|缺货|没货/.test(text)) return false;
  return /(?:轨道|导轨)(?:有没有|是否有|有无)?250(?:mm)?(?:这个)?规格(?:吗)?$/.test(text) ||
    /250(?:mm)?(?:的)?(?:轨道|导轨)(?:这个)?规格(?:有吗|吗)?$/.test(text);
}

function looksLikeOrderingAction(content) {
  const text = String(content || '');
  if (looksLikeOrderConfigurationQuestion(text)) return true;
  if (/下单|订单|加购|补单|运费|省个运费|商城|小程序|购物车|付款|支付|链接|商品页|有货|还有没有|公司有吗/.test(text)) return true;
  if (/(怎么|如何|咋|在哪|哪里|从哪).{0,8}下(?!降|层|方|面|沿|轨|柜|滑|沉|垂|压|来|去)/.test(text)) return true;
  if (/(下|下单|订单|客户|门店|商城|小程序).{0,12}(要|需要|还要|也要|再要|补|配|订|买).{0,8}[一二三四五六七八九十\d]+(个|套|只|片|件|根|盒)/.test(text)) return true;
  // “互换一下”“问下尚酷”里的“下”不是下单动作，不能拦截产品能力问题。
  if (/(单独|只|不|不用|不要|再|可以|能不能|能否|是不是|就是).{0,16}下(?:单|订|购买|采购)/.test(text)) return true;
  if (/(?:^|想|要|需要|准备|帮我)下(水槽|主架|挂盒|盒子|配件|反弹器|推弹器|抽屉|拉篮|轨道|导轨|置物架|中枢阁|云狐|云梯|魔法抽|尚酷)/.test(text) && !/(?:问|咨询|确认|看)下/.test(text)) return true;
  return false;
}

// 看似在问轨道/尺寸，实质是在问商城下单页面的规格联动或选项显示。
function looksLikeOrderConfigurationQuestion(content) {
  const text = String(content || '').replace(/\s+/g, '');
  if (!text) return false;
  if (/圆方(?:商城)?|商城|小程序|商品页|下单页|下单页面/.test(text) && /轨道|导轨|规格|选项|定制|深度/.test(text)) return true;
  return /(?:定制)?\d{3,4}(?:mm)?深度.{0,16}(?:轨道|导轨).{0,16}(?:自动(?:带出|选择|匹配|跟随)|带不出|不自动|选项(?:没有|不显示|出不来))/.test(text) ||
    /(?:轨道|导轨).{0,16}(?:自动(?:带出|选择|匹配|跟随)|带不出|不自动|选项(?:没有|不显示|出不来)).{0,24}(?:定制|深度|\d{3,4})/.test(text);
}

function looksLikeListingOrReleaseQuestion(content) {
  const text = String(content || '');
  if (/上架|下架|上市|上线|上新|开售|售卖|开卖|开放购买|开放下单|什么时候上|啥时候上|多久上|预计.*上|一起上|还没上|没上架|上了吗|上了没/.test(text)) {
    return true;
  }
  return /(?:固定定制|尚酷.*定制|工具抽.*定制|抽定制|定制.*模块|模块).*(弄好了吗|弄好了|做好了吗|做好了|好了吗|开放了吗|可以下了吗|能下了吗)/.test(text);
}

function looksLikeComponentSwapOrderingAction(content) {
  const text = String(content || '');
  const swapCue = /换成|替换|换掉|更换|不要原配|不买原配|不是原配|非原配/.test(text);
  if (!swapCue) return false;
  const componentCue = /内部|里面|内配|原配|标配|搭配|配件|模块|盒子|挂盒|横杆|横条|竖条|分割片|分隔|锅盖架|调料|水槽侧拉|上层小|下层|最宽/.test(text);
  if (!componentCue) return false;
  return !/(左装|右装|方向|开门|连门式|抽面|门板|拉手|铰链)/.test(text);
}

function looksLikeProductExchangeAfterSalesQuestion(content) {
  const text = String(content || '').replace(/\s+/g, '');
  if (!text) return false;

  const productName = /升降机|云狐|云梯|云阁|云弧|中枢阁|翼枢阁|展翼阁|巧翼阁|之行阁|万象阁|魔法抽|尚酷|食品抽|衣物抽|谷物抽|工具抽|收纳抽|抽中抽|子母抽|水槽侧拉|拉篮|小怪物|大怪物|灵动衣架|挂门宝|备餐架|红酒抽|产品|整机|设备/;
  if (!productName.test(text)) return false;

  if (/换货|退换|退换货|换新|换产品|换整机|调换|置换/.test(text)) return true;

  const partOrInstallTarget = /方向|左装|右装|安装方向|开门方向|轨道|导轨|阻尼|反弹器|推弹器|铰链|门板|拉手|模块|挂盒|配件|上层|下层|安装|拆装|维修/;
  const hasPartSwap = new RegExp(`${partOrInstallTarget.source}.{0,4}换|换.{0,4}${partOrInstallTarget.source}`).test(text);
  if (hasPartSwap) return false;

  const wholeProductBefore = /(?:换|调换|置换)(?:一台|一个|个|台|新的|新)?(?:升降机|云狐|云梯|云阁|云弧|中枢阁|翼枢阁|展翼阁|巧翼阁|之行阁|万象阁|魔法抽|尚酷|食品抽|衣物抽|谷物抽|工具抽|收纳抽|抽中抽|子母抽|水槽侧拉|拉篮|小怪物|大怪物|灵动衣架|挂门宝|备餐架|红酒抽|产品|整机|设备)/;
  const wholeProductAfter = /(?:升降机|云狐|云梯|云阁|云弧|中枢阁|翼枢阁|展翼阁|巧翼阁|之行阁|万象阁|魔法抽|尚酷|食品抽|衣物抽|谷物抽|工具抽|收纳抽|抽中抽|子母抽|水槽侧拉|拉篮|小怪物|大怪物|灵动衣架|挂门宝|备餐架|红酒抽|产品|整机|设备).{0,8}(?:换吗|换么|换不换|换一个|换一台|换个|换台|换新的|换新)/;
  return wholeProductBefore.test(text) || wholeProductAfter.test(text);
}

function looksLikeAfterSalesInstallAbnormalQuestion(content, context = '') {
  const text = `${content || ''}\n${context || ''}`.replace(/\s+/g, '');
  if (!text) return false;

  const productName = /升降机|云狐|云梯|云阁|云弧|中枢阁|翼枢阁|展翼阁|巧翼阁|之行阁|万象阁|魔法抽|尚酷|食品抽|衣物抽|谷物抽|工具抽|收纳抽|抽中抽|子母抽|水槽侧拉|拉篮|小怪物|大怪物|灵动衣架|挂门宝|备餐架|红酒抽|产品|整机|设备/;
  if (!productName.test(text)) return false;

  const sceneCue = /客户家|现场|师傅|上门|安装好|安装后|装好|装完|已安装|使用中|运行中|拉下来|拉下来的时候|拉到下面|打开时|关闭时|柜门|门板|门做的|造型/;
  const abnormalCue = /摩擦|刮|蹭|碰|干涉|卡住|卡滞|异响|不顺|打不开|开不全|不能完全打开|关不上|下不来|上不去|停止不动|故障|左右调|调节一点|微调|调整一点|重设限位|重新设置上下限位/;
  if (sceneCue.test(text) && abnormalCue.test(text)) return true;

  return /升降机.{0,30}(摩擦|刮|蹭|碰|卡住|卡滞|异响|左右调|调节一点|微调)|(?:摩擦|刮|蹭|碰|卡住|卡滞|异响|左右调|调节一点|微调).{0,30}升降机/.test(text);
}

function shouldSkipReviewQueueForBlocked(content) {
  const text = content || '';
  if (looksLikeDiscontinuedLegacySeriesAfterSalesQuestion(text)) return true;
  const hasOrderNo = /\b(?:KT|S|DPK|SF|E)\d{6,}\b/i.test(text);
  const operationalTerms = /发货|物流|快递|单号|顺丰|德邦|催一下|催下|加急|催单|帮我催|订单进度|什么时候发|多久发货|还没发|退款|退货|换货|退换|换新|调换|置换|售后|补发|取件|运费|退回|审批|审核|审单|已申请|暂停制作|不发货|支付|付款|加购|差价|怎么下|如何下|咋下|下几个|下多少|价格|报价|多少钱|费用|折扣|打折|几折|优惠|活动|促销|商城|小程序|上架|下架|上市|上线|上新|开售|售卖|开卖|绑定|提交|报备|分享码|凭证|收据|财务|客资费|(?:打)?[一二三四五六七八九十\d]+折/.test(text);
  return operationalTerms ||
    looksLikeStockAvailabilityQuestion(text) ||
    looksLikeOrderingAction(text) ||
    looksLikeListingOrReleaseQuestion(text) ||
    looksLikeComponentSwapOrderingAction(text) ||
    looksLikeProductExchangeAfterSalesQuestion(text) ||
    looksLikeAfterSalesInstallAbnormalQuestion(text) ||
    (hasOrderNo && /订单|下单|发|退|售后|加急|审核|审单|支付|付款|报价|加购|查一下|帮忙看|处理/.test(text));
}

function shouldSkipReviewQueueForReview(content, reason, suggestion) {
  const combined = `${content || ''}\n${reason || ''}\n${suggestion || ''}`;
  return shouldSkipReviewQueueForBlocked(combined) ||
    /订单系统|物流系统|售后系统|需要核实|订单审核|审单|发货状态|退款状态|售后记录|退换货|换新|下单流程|商城|小程序|上架|下架|上市|上线|开售|售卖|报价规则|加购方式|支付方式|财务核实/.test(combined);
}

// 对外审计和 Markdown 报告使用中文原因；reason 保留稳定的内部代码，便于测试和排障。
const DECISION_REASON_TEXT = Object.freeze({
  ambiguous_context_unresolved: '上下文未能唯一定位具体产品、型号或配件，不能自动回复。',
  unresolved_product_context_for_installation: '问题涉及柜深、铰链和安装位置，但未能确认具体产品，不能套用抽屉安装公式，已转人工确认。',
  order_payment_page_context: '结合上下文，这是付款或下单页面及随单配件确认，按下单流程问题跳过。',
  order_flow_context: '结合上下文，这是下单或定制配置问题，按下单流程问题跳过。',
  logistics_followup_context: '结合上下文，这是催发货或物流进度问题，按物流流程问题跳过。',
  after_sales_context: '结合上下文，这是退换、补发、维修或缺件等售后问题，按售后流程跳过。',
  order_configuration_question: '这是圆方/商城的下单配置问题，按下单流程规则不自动回复。',
  discontinued_legacy_series_after_sales: '涉及已下架的三代或易酷旧系列，按售后问题处理，不自动回复。',
  drawer_divider_material_rule: '抽屉分隔杆、短分隔片材质的确认口径。',
  customer_service_or_order_block: '这是订单、物流、售后或报价等业务流程问题，按规则不自动回复。',
  review_customer_service_block: '识别为订单、售后或下单流程问题，人工复核后仍按规则跳过。',
  product_platform_operation_question: '这是产品平台或商城操作问题，不属于产品知识自动回复范围。',
  design_or_site_image_question: '这是设计图、现场图或安装现场判断问题，需要人工结合图片确认。',
  video_context: '上文包含视频，需要人工结合视频内容判断，不能自动回复。',
  original_image_not_downloaded: '问题依赖群内图片，但原图未能从钉钉下载；禁止使用缩略图或缓存猜测，已跳过。',
  original_image_recognition_failed: '已获取群内原图，但视觉识别未得到可靠结果；禁止猜测，已跳过。',
  ai_skip: 'AI 判断当前信息不足或不适合自动回复，已跳过。',
  bad_reply: '候选回复未通过内容质量校验，已拦截。',
  casual_chat_failed: '未识别为可回答的具体产品问题，已跳过。',
  skip_force_review: '产品尺寸或结构问题不能静默跳过，已转人工确认。',
  ai_review: 'AI 需要人工确认后才能回复。',
  no_sender_callback: '内部模拟：已生成可回复内容，未调用钉钉发送接口。',
  semi_auto: '半自动模式：已生成回复建议，等待人工确认发送。',
  send_failed: '发送失败，已保留记录等待后续处理。',
  sent: '已发送。',
});

function describeDecisionReason(reason) {
  const code = String(reason || '').trim();
  if (!code) return '系统未提供具体原因。';
  if (DECISION_REASON_TEXT[code]) return DECISION_REASON_TEXT[code];
  if (code.startsWith('duplicate_')) return '同一消息已处理或仍在冷却期，为避免重复回复已跳过。';
  if (/^[\u4e00-\u9fff，。；：、（）()！!？?\s\dA-Za-z_-]+$/.test(code) && /[\u4e00-\u9fff]/.test(code)) return code;
  return '系统规则拦截，未生成自动回复。';
}

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 所有出站回复禁止称呼对方或会话中其他人的姓名/昵称。
// 提示词负责约束生成，出站前再做一次确定性清理，避免模型偶发带姓名开头。
function sanitizeReplyAddressees(reply, names = []) {
  let output = String(reply || '').trim();
  const variants = new Set();
  for (const rawName of Array.isArray(names) ? names : [names]) {
    const raw = String(rawName || '').trim();
    if (!raw) continue;
    const withoutPhone = raw.replace(/1\d{10}/g, '').trim();
    const withoutRole = withoutPhone.replace(/^(?:客户|门店|员工|客服|规划师)[-—_：:\s]*/i, '').trim();
    for (const value of [raw, withoutPhone, withoutRole]) {
      if (value.length >= 2 && !/^(?:客户|门店|员工|客服|用户|系统|机器人)$/.test(value)) variants.add(value);
    }
  }
  for (const name of [...variants].sort((a, b) => b.length - a.length)) {
    output = output.replace(new RegExp(`@?${escapeRegExp(name)}`, 'g'), '');
  }
  return output
    .replace(/^[\s，,：:、-]+/, '')
    .replace(/([，,：:、]){2,}/g, '$1')
    .replace(/\s+([，。！？；：])/g, '$1')
    .trim();
}

function classifyContextualBusinessFlow(content, context = '', imageContext = '') {
  const current = stripMediaMarkers(String(content || '')).replace(/\s+/g, '');
  const combined = stripMediaMarkers(`${context || ''}\n${imageContext || ''}\n${content || ''}`).replace(/\s+/g, '');
  const followUpCue = /这个|这款|这里|然后|不影响|对吗|对吧|会发|发吗|配件|挂钩|组合|细节尺寸|在哪里|哪里看|怎么选|如何选|定制|标品|页面|变成|选择|能不能|可以吗|怎么办|怎么处理/;
  const shortQuestion = current.length <= 48 && /吗|么|呢|哪|怎么|如何|是否|能否|对不对|\?|？/.test(current);
  const isFollowUp = followUpCue.test(current) || shortQuestion;
  const paymentCue = /(?:付款|支付|收银|付款页|付款页面|支付页|支付页面|提交订单|订单确认)/;
  const orderPageCue = /(?:圆方(?:商城)?|商城|下单页|下单页面|订单详情|商品规格|规格选项|已选规格|购物车|立即购买|提交订单|订单信息)/;
  const logisticsCue = /(?:催发货|催单|物流|快递|发货进度|什么时候发|多久发|到哪了|运单|单号|还没发|没有发|未发货|发出了吗)/;
  const afterSalesCue = /(?:售后|退货|换货|换新|补发|少发|漏发|缺件|坏了|破损|维修|返修|拆换|退换)/;
  const currentProductAnchors = getSpecificProductAnchors(current);
  const currentProductFactCue = /(?:尺寸是多少|尺寸|宽度|深度|高度|规格|结构|材质|安装|能装|能否安装|可以安装|怎么装|能做|可以做)/.test(current);
  const currentBusinessCue = paymentCue.test(current) || orderPageCue.test(current) || logisticsCue.test(current) || afterSalesCue.test(current) || /(?:下单|订单|加购|填写|付款|支付|发货|物流|售后)/.test(current);

  // 不能让前文（尤其是机器人上一句）里的“下单/物流”等字眼覆盖当前明确的产品事实追问。
  // 例如“130H分隔抽（600柜）无门”后追问“尺寸是多少”，仍是产品尺寸问题。
  if (!currentBusinessCue && (currentProductAnchors.length > 0 || currentProductFactCue)) {
    return '';
  }

  if (paymentCue.test(combined) && (isFollowUp || paymentCue.test(current))) {
    return 'order_payment_page_context';
  }
  if (logisticsCue.test(combined) && (isFollowUp || logisticsCue.test(current))) {
    return 'logistics_followup_context';
  }
  if (afterSalesCue.test(combined) && (isFollowUp || afterSalesCue.test(current))) {
    return 'after_sales_context';
  }
  if ((orderPageCue.test(combined) || /(?:下单|订单|加购|定制单|标准单|标品单)/.test(combined)) &&
      (isFollowUp || /定制|标品|怎么选|哪个|选择|页面|填写|尺寸|配置/.test(current))) {
    return 'order_flow_context';
  }
  return '';
}

const CONTEXT_PROBLEM_TYPE_TEXT = Object.freeze({
  order_payment: '付款/下单页面',
  order_configuration: '下单/定制配置',
  logistics: '物流/催发货',
  after_sales: '售后',
  installation: '产品安装',
  dimension: '产品尺寸/适配',
  material: '产品材质',
  compatibility: '产品兼容/选型',
  product_fact: '产品事实',
  unknown: '尚未确认',
});

function extractContextDimensions(text) {
  const source = stripMediaMarkers(String(text || '')).replace(/\s+/g, '');
  const matches = source.match(/(?:柜内净宽|柜内深度|柜宽|柜深|宽度|深度|高度|宽|深|高)\D{0,4}\d{2,4}(?:\.\d+)?(?:mm|毫米|cm|厘米)?|\d{2,4}(?:\.\d+)?(?:mm|毫米|cm|厘米|柜|宽|深|高)/gi) || [];
  return [...new Set(matches)].slice(0, 8);
}

// 把同一条消息的文字、前文和图片识别统一解析成可审计的结构。
// 本函数只做定位和分类，不生成产品事实；产品答案仍必须来自知识库或确定性公式。
function analyzeConversationContext(content, context = '', imageContext = '') {
  const current = stripMediaMarkers(String(content || '')).trim();
  const prior = stripMediaMarkers(String(context || '')).trim();
  const visual = stripMediaMarkers(String(imageContext || '')).trim();
  const combined = `${prior}\n${visual}\n${current}`;
  const currentProductAnchors = getSpecificProductAnchors(current);
  const contextProductAnchors = getSpecificProductAnchors(`${prior}\n${visual}`);
  const productAnchors = [...new Set([...currentProductAnchors, ...contextProductAnchors])];
  const businessReason = classifyContextualBusinessFlow(current, prior, visual);
  const evidence = [];
  let problemType = 'unknown';

  if (businessReason === 'order_payment_page_context') problemType = 'order_payment';
  else if (businessReason === 'order_flow_context' || looksLikeOrderConfigurationQuestion(current)) problemType = 'order_configuration';
  else if (businessReason === 'logistics_followup_context') problemType = 'logistics';
  else if (businessReason === 'after_sales_context' || looksLikeDiscontinuedLegacySeriesAfterSalesQuestion(current, prior)) problemType = 'after_sales';
  else if (/安装|孔位|铰链|拆卸|拆开|装不下|怎么装|往后装/.test(current)) problemType = 'installation';
  else if (/尺寸|宽度|深度|高度|净宽|净深|柜宽|柜深|能做|可以做|定制/.test(current)) problemType = 'dimension';
  else if (/材质|材料|铝合金|ABS|抗倍特板|玻璃|不锈钢/.test(current)) problemType = 'material';
  else if (/通用|兼容|适配|选型|怎么选|能否搭配|可以搭配/.test(current)) problemType = 'compatibility';
  else if (looksLikeProductQuestion(current) || productAnchors.length > 0) problemType = 'product_fact';

  if (businessReason) evidence.push(`业务上下文：${describeDecisionReason(businessReason)}`);
  if (currentProductAnchors.length) evidence.push(`当前问题明确产品：${currentProductAnchors.join('、')}`);
  else if (contextProductAnchors.length) evidence.push(`从前文或图片定位产品：${contextProductAnchors.join('、')}`);
  if (visual && /付款|支付|订单|圆方|商城|商品规格|规格选项|购物车|立即购买|提交订单/.test(visual)) {
    evidence.push('图片识别包含商城、订单或付款页面线索');
  }

  const dimensions = extractContextDimensions(combined);
  const doorTypes = [...new Set((combined.match(/单开门|双开门|平开门|连门|无门/gi) || []).map(item => item.toLowerCase()))];
  if (dimensions.length) evidence.push(`尺寸线索：${dimensions.join('、')}`);
  if (doorTypes.length) evidence.push(`门型线索：${doorTypes.join('、')}`);

  let confidence = 'low';
  if (businessReason || currentProductAnchors.length === 1) confidence = 'high';
  else if (contextProductAnchors.length === 1 || problemType !== 'unknown') confidence = 'medium';
  if (productAnchors.length > 1 && currentProductAnchors.length === 0) confidence = 'low';

  return {
    problemType,
    problemTypeText: CONTEXT_PROBLEM_TYPE_TEXT[problemType] || CONTEXT_PROBLEM_TYPE_TEXT.unknown,
    businessReason,
    productAnchors,
    currentProductAnchors,
    contextProductAnchors,
    dimensions,
    doorTypes,
    confidence,
    evidence: evidence.slice(0, 6),
  };
}

// ====== AI 后回复质量过滤（拦截不发） ======
// 这是本地安全机制；“建议 / 通常 / 一般 / 可能 / 大概率”可用于有依据的产品判断，
// 不应仅因出现这些词而拦截。这里主要拦截明显的不确定回答、空头承诺和跑题内容。
const REPLY_BLOCK = AUTO_REPLY_RULES.replyBlock;

function replyLooksBad(text) {
  const matched = REPLY_BLOCK.filter(kw => text.includes(kw));
  if (matched.length) console.log(`[回复拦截] 命中关键词: ${matched.join('、')}`);
  return matched.length > 0;
}

const CONFIG = {
  aiProvider: (process.env.AI_PROVIDER || (process.env.DIFY_API_KEY ? 'dify' : 'deepseek')).toLowerCase(),
  aiKey: process.env.AI_API_KEY || '',
  aiUrl: process.env.AI_API_URL || 'https://api.deepseek.com/v1/chat/completions',
  aiModel: process.env.AI_MODEL || 'deepseek-chat',
  difyApiKey: process.env.DIFY_API_KEY || '',
  difyBaseUrl: (process.env.DIFY_BASE_URL || 'http://localhost:8088').replace(/\/+$/, ''),
  difyApiUrl: process.env.DIFY_API_URL || '',
  difyAppType: (process.env.DIFY_APP_TYPE || 'chat').toLowerCase(),
  difyResponseMode: process.env.DIFY_RESPONSE_MODE || 'blocking',
  difyUser: process.env.DIFY_USER || 'kutai-dingtalk-auto-reply',
  difyTimeoutMs: parseInt(process.env.DIFY_TIMEOUT_SEC || '45', 10) * 1000,
  difyFallbackToDeepSeek: process.env.DIFY_FALLBACK_TO_DEEPSEEK !== 'false',
  llmWikiEnabled: process.env.LLM_WIKI_ENABLED !== 'false',
  llmWikiStrict: process.env.LLM_WIKI_STRICT !== 'false',
  llmWikiMaxPages: parseInt(process.env.LLM_WIKI_MAX_PAGES || '6', 10),
  llmWikiMinScore: parseInt(process.env.LLM_WIKI_MIN_SCORE || '18', 10),
  pollInterval: parseInt(process.env.POLL_INTERVAL || '30', 10) * 1000,
  maxHistoryRounds: parseInt(process.env.MAX_HISTORY_ROUNDS || '5', 10),
  skipSelf: process.env.SKIP_SELF !== 'false',
  filterHQSenders: process.env.FILTER_HQ_SENDERS === 'true',
  filterEmployeeSenders: process.env.FILTER_EMPLOYEE_SENDERS === 'true',
  botSkipEmployeeSenders: process.env.BOT_SKIP_EMPLOYEE_SENDERS === 'true',
  skipSenders: process.env.FILTER_HQ_SENDERS === 'true' ? loadHQStaff() : [],
  employeeSenders: (process.env.FILTER_EMPLOYEE_SENDERS === 'true' || process.env.BOT_SKIP_EMPLOYEE_SENDERS === 'true') ? loadEmployeeSenders() : [],
  employeeUserIds: (process.env.FILTER_EMPLOYEE_SENDERS === 'true' || process.env.BOT_SKIP_EMPLOYEE_SENDERS === 'true') ? loadEmployeeUserIds() : [],
  rateLimitSec: parseInt(process.env.RATE_LIMIT_SEC || '60', 10),
  directRateLimitSec: parseInt(process.env.DIRECT_RATE_LIMIT_SEC || '2', 10),
  groupRateLimitSec: parseInt(process.env.GROUP_RATE_LIMIT_SEC || '2', 10),
  maxGroupsPerPoll: parseInt(process.env.MAX_GROUPS_PER_POLL || '10', 10),
  skipCooldownMs: parseInt(process.env.SKIP_COOLDOWN_SEC || '300', 10) * 1000,
  repliedRetentionMs: parseInt(process.env.REPLIED_RETENTION_SEC || '1800', 10) * 1000,
  recentMessageWindowMs: parseInt(process.env.RECENT_MESSAGE_WINDOW_MIN || '10', 10) * 60 * 1000,
  dwsTimeoutMs: parseInt(process.env.DWS_TIMEOUT_SEC || '25', 10) * 1000,
  dwsRetries: parseInt(process.env.DWS_RETRIES || '2', 10),
  dwsMaxConsecutiveFailures: parseInt(process.env.DWS_MAX_CONSECUTIVE_FAILURES || '12', 10),
  dwsAuthErrorPauseMs: parseInt(process.env.DWS_AUTH_ERROR_PAUSE_MIN || '30', 10) * 60 * 1000,
  dwsGroupAuthBlockMs: parseInt(process.env.DWS_GROUP_AUTH_BLOCK_MIN || '1440', 10) * 60 * 1000,
  enableGroupReplies: process.env.ENABLE_GROUP_REPLIES !== 'false',
  enableDirectReplies: process.env.ENABLE_DIRECT_REPLIES !== 'false',
  relaxedDirectReplies: process.env.RELAXED_DIRECT_REPLIES === 'true',
  semiAutoMode: process.env.SEMI_AUTO_MODE === 'true',
  pendingReviewMode: process.env.PENDING_REVIEW_MODE === 'true',
  pendingQueueMaxItems: parseInt(process.env.PENDING_QUEUE_MAX_ITEMS || '300', 10),
  botAuditLogFile: process.env.BOT_AUDIT_LOG_FILE || path.join(__dirname, 'bot-reply-audit.jsonl'),
  botMaxMessageAgeMs: parseInt(process.env.BOT_MAX_MESSAGE_AGE_MIN || '5', 10) * 60 * 1000,
  botGroupOnlyAt: process.env.BOT_GROUP_ONLY_AT !== 'false',
};

const RUNTIME_DIR = process.env.RUNTIME_DIR || __dirname;
fs.mkdirSync(RUNTIME_DIR, { recursive: true });
const STATE_FILE = path.join(RUNTIME_DIR, 'auto-reply-state.json');
const DATA_DIR = path.join(__dirname, 'data');
const CONV_DIR = path.join(DATA_DIR, 'conversations');
const PRODUCT_KB_DIR = path.join(__dirname, '产品知识库');
// 当前产品事实源已迁入 Obsidian 知识库；容器中由 PRODUCT_KB_ROOT 覆盖为 /app/knowledge。
const CURRENT_PRODUCT_KB_ROOT = process.env.PRODUCT_KB_ROOT || path.resolve(__dirname, '..', '产品知识库');
const CURRENT_PRODUCT_MATRIX_DIR = process.env.PRODUCT_MATRIX_DIR || path.join(CURRENT_PRODUCT_KB_ROOT, '01_MD章节矩阵');
const CURRENT_PRODUCT_DATA_DIR = process.env.PRODUCT_DATA_DIR || path.join(CURRENT_PRODUCT_KB_ROOT, '05_数据与图片');
const AI_PLANNER_SOURCE_DIR = process.env.AI_PLANNER_SOURCE_DIR || CURRENT_PRODUCT_KB_ROOT;
const LLM_WIKI_ROOT = process.env.LLM_WIKI_ROOT || path.join(AI_PLANNER_SOURCE_DIR, 'LLM-Wiki');
const llmWiki = new LlmWiki({
  root: LLM_WIKI_ROOT,
  maxPages: CONFIG.llmWikiMaxPages,
  minScore: CONFIG.llmWikiMinScore,
});
const REVIEW_QUEUE_FILE = path.join(PRODUCT_KB_DIR, '酷太自动回复待确认.md');
const PENDING_REPLY_QUEUE_FILE = path.join(RUNTIME_DIR, '待回复队列.json');
const PENDING_REPLY_QUEUE_MD_FILE = path.join(RUNTIME_DIR, '待回复队列.md');

function appendBotAudit(entry) {
  try {
    const payload = {
      timestamp: new Date().toISOString(),
      ...entry,
    };
    fs.appendFileSync(CONFIG.botAuditLogFile, `${JSON.stringify(payload)}\n`, 'utf-8');
  } catch (e) {
    console.error(`[机器人审计] 写入失败: ${e.message}`);
  }
}

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(CONV_DIR)) fs.mkdirSync(CONV_DIR, { recursive: true });
if (!fs.existsSync(PRODUCT_KB_DIR)) fs.mkdirSync(PRODUCT_KB_DIR, { recursive: true });

// ====== DWS 调用 ======
let consecutiveDwsFailures = 0;
let lastDwsCacheRefreshAt = 0;
let lastDwsErrorText = '';

function getDwsErrorText(error) {
  return [
    error?.message || '',
    error?.stderr ? String(error.stderr) : '',
    error?.stdout ? String(error.stdout) : '',
  ].join('\n');
}

function isTransientDwsError(text) {
  return /discovery|mcp-gw|dial tcp|timeout|timed out|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|service connectivity|protocol version|cache refresh|temporarily|被另一进程|being used by another process/i.test(text || '');
}

function isDwsAuthorizationPromptError(text) {
  return /authorizationUrl|personalAuthorization|AGENT_CODE_NOT_EXISTS|developerSettings|CLI 数据访问权限|TOKEN_VERIFY_FAILED|USER_TOKEN_ILLEGAL|AUTH_TOKEN_EXPIRED|forbidden request|server_error_code"?\s*:\s*"1001"/i.test(text || '');
}

function compactDwsError(text, maxLen = 220) {
  return String(text || '')
    .replace(/https?:\/\/\S+/g, '[auth-url]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function refreshDwsCache(reason) {
  const now = Date.now();
  if (now - lastDwsCacheRefreshAt < 60 * 1000) return;
  lastDwsCacheRefreshAt = now;
  console.log(`[DWS] 尝试刷新缓存: ${reason}`);
  try {
    execSync('dws cache refresh', {
      encoding: 'utf-8',
      maxBuffer: 2 * 1024 * 1024,
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log('[DWS] 缓存刷新完成');
  } catch (e) {
    const err = getDwsErrorText(e).slice(0, 300).replace(/\s+/g, ' ');
    console.error(`[DWS] 缓存刷新失败: ${err}`);
  }
}

function noteDwsResult(ok, context) {
  if (ok) {
    if (consecutiveDwsFailures > 0) {
      console.log(`[DWS] 连接恢复，连续失败清零（之前 ${consecutiveDwsFailures} 次）`);
    }
    consecutiveDwsFailures = 0;
    return;
  }

  consecutiveDwsFailures += 1;
  console.error(`[DWS] ${context} 失败，连续失败 ${consecutiveDwsFailures}/${CONFIG.dwsMaxConsecutiveFailures}`);
  if (consecutiveDwsFailures >= CONFIG.dwsMaxConsecutiveFailures) {
    console.error('[DWS] 连续失败过多，主动退出交给守护脚本重启');
    process.exit(2);
  }
}

function execDwsJson(cmd, logPrefix, retries = CONFIG.dwsRetries) {
  let lastErrorText = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = execSync(cmd, {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: CONFIG.dwsTimeoutMs,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const parsed = parseDwsJson(r);
      lastDwsErrorText = '';
      noteDwsResult(true, logPrefix);
      return parsed;
    } catch (e) {
      lastErrorText = getDwsErrorText(e);
      lastDwsErrorText = lastErrorText;
      const compact = lastErrorText.slice(0, 500).replace(/\s+/g, ' ');
      console.error(`[${logPrefix}] 第 ${attempt + 1}/${retries + 1} 次失败: ${compact}`);
      if (isDwsAuthorizationPromptError(lastErrorText)) break;
      if (isTransientDwsError(lastErrorText)) {
        refreshDwsCache(compact);
      }
      if (!isTransientDwsError(lastErrorText) || attempt === retries) break;
    }
  }

  noteDwsResult(false, logPrefix);
  return null;
}

function dws(args) {
  try {
    const cmd = `dws ${args} --format json -y`;
    return execDwsJson(cmd, 'DWS');
  } catch (e) {
    const stderr = getDwsErrorText(e).slice(0, 300);
    if (stderr) console.error(`[DWS] ${stderr}`);
    noteDwsResult(false, 'DWS');
    return null;
  }
}

// ====== 状态管理 ======
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {}
  return { repliedMsgs: {}, groupConfig: {} };
}

function pruneDwsAuthState(state) {
  const now = Date.now();
  if (!state.dwsPauses) state.dwsPauses = {};
  if (!state.dwsAuthBlockedGroups) state.dwsAuthBlockedGroups = {};

  for (const [cid, item] of Object.entries(state.dwsAuthBlockedGroups)) {
    if (!item || item.blockedUntil <= now) {
      delete state.dwsAuthBlockedGroups[cid];
    }
  }
}

function pauseDwsScan(state, scope, errorText) {
  pruneDwsAuthState(state);
  const until = Date.now() + CONFIG.dwsAuthErrorPauseMs;
  state.dwsPauses[`${scope}Until`] = until;
  state.dwsPauses[`${scope}Reason`] = compactDwsError(errorText);
  console.log(`[DWS] 授权/权限弹窗类错误，暂停${scope === 'group' ? '群聊' : '私聊'}扫描 ${Math.round(CONFIG.dwsAuthErrorPauseMs / 60000)} 分钟：${state.dwsPauses[`${scope}Reason`]}`);
}

function isDwsScanPaused(state, scope) {
  pruneDwsAuthState(state);
  let until = state.dwsPauses?.[`${scope}Until`] || 0;
  const now = Date.now();
  if (until <= now) return false;
  const configuredUntil = now + CONFIG.dwsAuthErrorPauseMs;
  if (configuredUntil > until) {
    state.dwsPauses[`${scope}Until`] = configuredUntil;
    until = configuredUntil;
  }
  const remainMin = Math.ceil((until - now) / 60000);
  console.log(`[DWS] ${scope === 'group' ? '群聊' : '私聊'}扫描因授权/权限错误暂停中，约 ${remainMin} 分钟后恢复`);
  return true;
}

function blockDwsAuthGroup(state, cid, title, errorText) {
  pruneDwsAuthState(state);
  state.dwsAuthBlockedGroups[cid] = {
    title,
    blockedUntil: Date.now() + CONFIG.dwsGroupAuthBlockMs,
    reason: compactDwsError(errorText),
    updatedAt: Date.now(),
  };
  console.log(`[DWS] 群触发授权/权限弹窗，临时跳过 ${Math.round(CONFIG.dwsGroupAuthBlockMs / 3600000)} 小时: ${title}`);
}

function isDwsAuthGroupBlocked(state, cid, title) {
  pruneDwsAuthState(state);
  const item = state.dwsAuthBlockedGroups?.[cid];
  if (!item) return false;
  const remainMin = Math.ceil((item.blockedUntil - Date.now()) / 60000);
  console.log(`  [DWS跳过] 授权/权限异常群，${remainMin} 分钟后再试: ${title || item.title}`);
  return true;
}

function saveState(state) {
  const cleaned = { ...state };
  const cutoff = Date.now() - CONFIG.repliedRetentionMs;
  for (const [k, v] of Object.entries(cleaned.repliedMsgs || {})) {
    if (typeof v === 'number') {
      if (v < cutoff) delete cleaned.repliedMsgs[k];
      continue;
    }

    if (!v || typeof v !== 'object') {
      delete cleaned.repliedMsgs[k];
      continue;
    }

    if (v.status === 'replied' && v.timestamp < cutoff) {
      delete cleaned.repliedMsgs[k];
      continue;
    }

    if ((v.status === 'skipped' || v.status === 'deferred') && v.expiresAt <= Date.now()) {
      delete cleaned.repliedMsgs[k];
    }
  }
  for (const [key, timestamp] of Object.entries(cleaned.lastRepliesByConversation || {})) {
    if (!Number.isFinite(timestamp) || timestamp < cutoff) delete cleaned.lastRepliesByConversation[key];
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(cleaned, null, 2));
}

function conversationRateKey(targetType, conversationId) {
  return `${targetType || 'group'}:${conversationId || 'unknown'}`;
}

function getConversationLastReply(state, targetType, conversationId) {
  return state.lastRepliesByConversation?.[conversationRateKey(targetType, conversationId)] || 0;
}

function markConversationReply(state, targetType, conversationId) {
  state.lastRepliesByConversation = state.lastRepliesByConversation || {};
  state.lastRepliesByConversation[conversationRateKey(targetType, conversationId)] = Date.now();
}

function getMessageRecord(state, msgId) {
  const record = state.repliedMsgs?.[msgId];
  if (!record) return null;
  if (typeof record === 'number') return { status: 'replied', timestamp: record };
  return record;
}

function markReplied(state, msgId) {
  state.repliedMsgs[msgId] = { status: 'replied', timestamp: Date.now() };
}

function markQueued(state, msgId, pendingId) {
  state.repliedMsgs[msgId] = { status: 'queued', pendingId, timestamp: Date.now() };
}

function markCooldown(state, msgId, ms, status = 'skipped') {
  state.repliedMsgs[msgId] = { status, expiresAt: Date.now() + ms };
}

function normalizeReviewText(text, maxLen = 500) {
  return String(text || '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function nextReviewQueueNumber(existing) {
  const numbered = [...String(existing || '').matchAll(/^##\s+(\d{1,6})[｜|\s]/gm)]
    .map(m => Number(m[1]))
    .filter(n => Number.isFinite(n));
  if (numbered.length) return Math.max(...numbered) + 1;
  const headingCount = (String(existing || '').match(/^##\s+/gm) || []).length;
  return headingCount + 1;
}

function parseMessageTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  const raw = String(value || '').trim();
  if (!raw) return 0;
  if (/^\d{10,13}$/.test(raw)) {
    const numeric = Number(raw);
    return raw.length === 10 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(raw.replace(' ', 'T'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function selectRecentContextMessages(messages, targetMessage, limit = 8, windowMs = 2 * 60 * 60 * 1000) {
  const list = Array.isArray(messages) ? messages : [];
  const targetId = targetMessage?.id;
  const index = list.findIndex(m => {
    if (!m) return false;
    if (targetId && m.id && m.id === targetId) return true;
    return m === targetMessage ||
      (
        (m.time || m.createTime || '') === (targetMessage?.time || targetMessage?.createTime || '') &&
        (m.sender || '') === (targetMessage?.sender || '') &&
        (m.content || '') === (targetMessage?.content || '')
      );
  });
  if (index < 0) return [];

  const targetTime = parseMessageTimestamp(targetMessage?.time || targetMessage?.createTime || targetMessage?.createdAt);
  return list
    .slice(0, index + 1)
    .filter(message => {
      if (!targetTime) return true;
      const messageTime = parseMessageTimestamp(message?.time || message?.createTime || message?.createdAt);
      if (!messageTime) return true;
      const age = targetTime - messageTime;
      return age >= 0 && age <= windowMs;
    })
    .slice(-limit);
}

function buildReviewContext(messages, targetMessage, limit = 6) {
  return selectRecentContextMessages(messages, targetMessage, limit)
    .map(m => `${m.time || m.createTime || ''} ${m.sender || ''}: ${normalizeReviewText(m.content || '', 150)}`)
    .join(' | ');
}

function isEmployeeSender(sender, senderUserId = '') {
  const text = String(sender || '').trim();
  const userId = String(senderUserId || '').trim();
  if (userId && CONFIG.employeeUserIds.includes(userId)) return true;
  if (!text) return false;
  if (/(?:酷太.*客服|总客服|客服\d*号)/.test(text)) return true;
  return CONFIG.employeeSenders.some(name => text.includes(name));
}

function appendReviewQueue({ source, title, sender, content, reason, suggestion, context }) {
  const safeTitle = normalizeReviewText(title || '未知会话');
  const safeSender = normalizeReviewText(sender || '未知');
  const safeContent = normalizeReviewText(content, 500);
  const safeReason = normalizeReviewText(reason || '需要人工确认', 500);
  const safeSuggestion = normalizeReviewText(suggestion, 800);
  const safeContext = normalizeReviewText(context || '', 1200);

  try {
    if ((source || '').includes('群聊') && CONFIG.filterEmployeeSenders && isEmployeeSender(safeSender)) {
      console.log(`[待确认] 员工群聊消息跳过: ${safeSender}: ${safeContent.slice(0, 60)}`);
      return;
    }
    if (!fs.existsSync(REVIEW_QUEUE_FILE)) {
      fs.writeFileSync(REVIEW_QUEUE_FILE, '# 酷太自动回复待确认\n\n> 这里记录自动回复拿不准、不敢直接回复、需要大和确认后才能沉淀进客服知识库的问题。\n', 'utf-8');
    }
    const existing = fs.readFileSync(REVIEW_QUEUE_FILE, 'utf-8');
    if (
      existing.includes(`- 会话：${safeTitle}`) &&
      existing.includes(`- 发送人：${safeSender}`) &&
      existing.includes(`- 原消息：${safeContent}`)
    ) {
      console.log(`[待确认] 已存在，跳过重复记录: ${safeSender}: ${safeContent.slice(0, 60)}`);
      return;
    }
    const reviewNo = String(nextReviewQueueNumber(existing)).padStart(3, '0');
    const lines = [
      '',
      `## ${reviewNo}｜${new Date().toLocaleString('zh-CN')} ${source || '未知来源'}`,
      '',
      `- 会话：${safeTitle}`,
      `- 发送人：${safeSender}`,
      `- 原消息：${safeContent}`,
    `- 待确认原因：${safeReason}`,
    ];
    if (safeContext) {
      lines.push(`- 上下文：${safeContext}`);
    }
    if (safeSuggestion) {
      lines.push(`- 建议口径：${safeSuggestion}`);
    }
    lines.push('');

    fs.appendFileSync(REVIEW_QUEUE_FILE, lines.join('\n'), 'utf-8');
    console.log(`[待确认] 已记录 #${reviewNo}: ${safeSender}: ${safeContent.slice(0, 60)}`);
  } catch (e) {
    console.error(`[待确认] 记录失败: ${e.message}`);
  }
}

function stableHash(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function readPendingReplyQueue() {
  try {
    if (!fs.existsSync(PENDING_REPLY_QUEUE_FILE)) {
      return { version: 1, updatedAt: '', items: [] };
    }
    const parsed = JSON.parse(fs.readFileSync(PENDING_REPLY_QUEUE_FILE, 'utf-8'));
    if (Array.isArray(parsed)) return { version: 1, updatedAt: '', items: parsed };
    if (!Array.isArray(parsed.items)) parsed.items = [];
    return parsed;
  } catch (e) {
    console.error(`[待回复] 读取队列失败: ${e.message}`);
    return { version: 1, updatedAt: '', items: [] };
  }
}

function renderPendingReplyQueue(queue) {
  return renderReviewQueueMarkdown(queue, { limit: 80, command: 'node pending-replies.js' });
}

function writePendingReplyQueue(queue) {
  const maxItems = Number.isFinite(CONFIG.pendingQueueMaxItems) ? CONFIG.pendingQueueMaxItems : 300;
  queue.version = 1;
  queue.updatedAt = new Date().toLocaleString('zh-CN', { hour12: false });
  queue.items = [...(queue.items || [])]
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, maxItems);
  fs.writeFileSync(PENDING_REPLY_QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf-8');
  fs.writeFileSync(PENDING_REPLY_QUEUE_MD_FILE, renderPendingReplyQueue(queue), 'utf-8');
}

function appendPendingReplyQueue(item) {
  const queue = readPendingReplyQueue();
  const messageKey = item.messageKey || stableHash(`${item.source}|${item.title}|${item.sender}|${item.messageTime}|${item.content}`);
  const existing = (queue.items || []).find(entry => (
    entry.messageKey && entry.messageKey === messageKey &&
    !['sent', 'skipped'].includes(entry.status)
  ));
  if (existing) {
    console.log(`[待回复] 已存在，跳过重复入队: ${existing.id}`);
    return existing;
  }

  const id = `pr-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${stableHash(messageKey).slice(0, 6)}`;
  const record = {
    id,
    status: 'pending',
    createdAt: new Date().toISOString(),
    messageKey,
    source: item.source || '未知',
    targetType: item.targetType || 'group',
    title: item.title || '',
    conversationId: item.conversationId || '',
    sender: item.sender || '',
    senderUserId: item.senderUserId || '',
    senderOpenDingTalkId: item.senderOpenDingTalkId || '',
    messageTime: item.messageTime || '',
    content: item.content || '',
    context: item.context || '',
    reason: item.reason || '',
    deepseekSuggestion: item.deepseekSuggestion || '',
    deepseekDecision: item.deepseekDecision || '',
  };

  queue.items = [record, ...(queue.items || [])];
  writePendingReplyQueue(queue);
  console.log(`[待回复] 已入队 ${id}: ${record.sender}: ${normalizeReviewText(record.content, 60)}`);
  return record;
}

function queuePendingReply(state, msgId, item) {
  const record = appendPendingReplyQueue({ ...item, messageKey: msgId });
  markQueued(state, msgId, record.id);
  saveState(state);
  return record;
}

function parseReviewReply(reply) {
  const text = String(reply || '').trim();
  if (!/^REVIEW[:：]/i.test(text)) return null;
  const body = text.replace(/^REVIEW[:：]\s*/i, '').trim();
  const reasonMatch = body.match(/(?:原因|reason)[:：]\s*([^\n]+)/i);
  const suggestionMatch = body.match(/(?:建议|suggestion)[:：]\s*([\s\S]+)/i);
  return {
    reason: reasonMatch ? reasonMatch[1].trim() : body.slice(0, 300),
    suggestion: suggestionMatch ? suggestionMatch[1].trim() : '',
  };
}

function runDwsCommand(args, logPrefix) {
  try {
    const finalArgs = [...args];
    if (!finalArgs.includes('--format') && !finalArgs.includes('-f')) {
      finalArgs.push('--format', 'json');
    }
    if (!finalArgs.includes('-y') && !finalArgs.includes('--yes')) {
      finalArgs.push('-y');
    }

    const cmd = `dws ${finalArgs.map(quoteForShell).join(' ')}`;
    return execDwsJson(cmd, logPrefix, Math.max(CONFIG.dwsRetries, 3));
  } catch (e) {
    const stderr = getDwsErrorText(e).slice(0, 300);
    if (stderr) console.error(`[${logPrefix}] ${stderr}`);
    else console.error(`[${logPrefix}] ${e.message}`);
    noteDwsResult(false, logPrefix);
    return null;
  }
}

// ====== 当前用户（优先从环境变量获取）======
let currentUserName = process.env.SELF_NAME || '';

function loadCurrentUser() {
  if (currentUserName) {
    console.log(`[User] 当前用户 (env): ${currentUserName}`);
    return;
  }
  // 尝试自动检测
  try {
    const user = execDwsJson('dws api GET /v1.0/contact/users/me --format json -y', 'DWS USER', 1);
    currentUserName = user?.result?.name || user?.name || '';
    if (currentUserName) console.log(`[User] 当前用户 (auto): ${currentUserName}`);
  } catch (e) {
    console.log('[User] 无法自动检测用户名，请在 .env 中设置 SELF_NAME');
  }
}

// ====== AI 调用 ======
function requestJson(urlText, body, headers, timeoutMs) {
  return new Promise((resolve) => {
    const url = new URL(urlText);
    const client = url.protocol === 'http:' ? http : https;
    let settled = false;
    const payload = JSON.stringify(body);
    const req = client.request({
      hostname: url.hostname, path: url.pathname + url.search,
      port: url.port || undefined,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (settled) return;
        settled = true;
        try {
          const parsed = JSON.parse(data || '{}');
          if (res.statusCode >= 400) {
            resolve({ ok: false, statusCode: res.statusCode, body: parsed, raw: data });
            return;
          }
          resolve({ ok: true, statusCode: res.statusCode, body: parsed, raw: data });
        } catch {
          resolve({ ok: false, statusCode: res.statusCode, body: null, raw: data });
        }
      });
    });
    req.on('timeout', () => {
      if (settled) return;
      settled = true;
      req.destroy();
      resolve({ ok: false, timeout: true, body: null, raw: '' });
    });
    req.on('error', (e) => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: e.message, body: null, raw: '' });
    });
    req.write(payload);
    req.end();
  });
}

async function callDeepSeekAI(systemPrompt, userPrompt) {
  if (!CONFIG.aiKey) {
    console.error('[AI] 缺少 AI_API_KEY，当前消息跳过');
    return 'SKIP';
  }

  const useAnthropicMessages = /\/anthropic\/|\/messages(?:\?|$)/.test(CONFIG.aiUrl);
  const body = useAnthropicMessages
    ? {
        model: CONFIG.aiModel,
        max_tokens: 600,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }
    : {
        model: CONFIG.aiModel,
        max_tokens: 600,
        temperature: 0.2,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      };

  try {
    const result = await requestJson(CONFIG.aiUrl, body, { Authorization: `Bearer ${CONFIG.aiKey}` }, 30000);

    if (!result.ok) {
      console.error(`[AI] DeepSeek 请求失败: ${result.statusCode || result.error || (result.timeout ? 'timeout' : 'unknown')}`);
      return 'SKIP';
    }

    const data = result.body || {};
    const openAiText = data.choices?.[0]?.message?.content || data.choices?.[0]?.text || '';
    const anthropicContent = data.content || [];
    const anthropicText = Array.isArray(anthropicContent)
      ? anthropicContent.filter(b => b.type === 'text').map(b => b.text).join('')
      : String(anthropicContent || '');
    return String(openAiText || anthropicText || '').trim() || 'SKIP';
  } catch (error) {
    console.error(`[AI] DeepSeek 响应解析失败: ${error.message}`);
    return 'SKIP';
  }
}

function difyEndpoint() {
  if (CONFIG.difyApiUrl) return CONFIG.difyApiUrl;
  const route = CONFIG.difyAppType === 'workflow' ? 'workflows/run' : 'chat-messages';
  return `${CONFIG.difyBaseUrl}/v1/${route}`;
}

function parseJsonFromText(text) {
  const cleaned = String(text || '').trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  try { return JSON.parse(cleaned); } catch {}
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch {}
  }
  return null;
}

function normalizeDifyAnswer(answer) {
  const text = String(answer || '').trim();
  if (!text) return 'SKIP';

  const parsed = parseJsonFromText(text);
  if (parsed && typeof parsed === 'object') {
    const decision = String(parsed.decision || parsed.action || parsed.status || '').toLowerCase();
    const reply = String(parsed.reply || parsed.answer || parsed.text || '').trim();
    const reason = String(parsed.reason || parsed.why || '').trim();
    const suggestion = String(parsed.suggestion || parsed.suggested_reply || reply || '').trim();

    if (['skip', 'no_reply', 'ignore'].includes(decision)) return 'SKIP';
    if (['review', 'manual', 'uncertain'].includes(decision)) {
      return `REVIEW: 原因: ${reason || 'Dify 要求人工确认'} 建议: ${suggestion || '转人工确认'}`;
    }
    if (['ask', 'clarify', 'reply', 'send_asset'].includes(decision) && reply) return reply;
    if (reply) return reply;
  }

  return text;
}

async function callDifyAI(systemPrompt, userPrompt) {
  if (!CONFIG.difyApiKey) {
    console.error('[AI] 缺少 DIFY_API_KEY，当前消息跳过');
    return '__DIFY_ERROR__';
  }

  const endpoint = difyEndpoint();
  const commonInputs = {
    system_prompt: systemPrompt,
    dingtalk_context: userPrompt,
    source: 'dingtalk_auto_reply',
  };
  const body = CONFIG.difyAppType === 'workflow'
    ? {
        inputs: {
          ...commonInputs,
          query: userPrompt,
          user_prompt: userPrompt,
        },
        response_mode: CONFIG.difyResponseMode,
        user: CONFIG.difyUser,
      }
    : {
        inputs: commonInputs,
        query: userPrompt,
        response_mode: CONFIG.difyResponseMode,
        user: CONFIG.difyUser,
      };

  const result = await requestJson(endpoint, body, {
    Authorization: `Bearer ${CONFIG.difyApiKey}`,
  }, CONFIG.difyTimeoutMs);

  if (!result.ok) {
    const detail = result.raw ? String(result.raw).slice(0, 300) : (result.error || (result.timeout ? 'timeout' : 'unknown'));
    console.error(`[AI] Dify 请求失败: ${result.statusCode || ''} ${detail}`);
    return '__DIFY_ERROR__';
  }

  const data = result.body || {};
  const outputs = data.data?.outputs || data.outputs || {};
  const answer = data.answer ||
    outputs.answer ||
    outputs.reply ||
    outputs.text ||
    outputs.result ||
    Object.values(outputs).find(v => typeof v === 'string') ||
    '';

  return normalizeDifyAnswer(answer);
}

async function callAI(systemPrompt, userPrompt) {
  if (CONFIG.aiProvider === 'dify') {
    const difyReply = await callDifyAI(systemPrompt, userPrompt);
    if (difyReply !== '__DIFY_ERROR__' || !CONFIG.difyFallbackToDeepSeek) {
      return difyReply === '__DIFY_ERROR__' ? 'SKIP' : difyReply;
    }
    console.log('[AI] Dify 请求失败，回退 DeepSeek');
    return callDeepSeekAI(systemPrompt, userPrompt);
  }
  if (CONFIG.aiProvider === 'auto' && CONFIG.difyApiKey) {
    const difyReply = await callDifyAI(systemPrompt, userPrompt);
    if (difyReply !== '__DIFY_ERROR__' || !CONFIG.difyFallbackToDeepSeek) {
      return difyReply === '__DIFY_ERROR__' ? 'SKIP' : difyReply;
    }
    console.log('[AI] Dify 请求失败，回退 DeepSeek');
  }
  return callDeepSeekAI(systemPrompt, userPrompt);
}

// ====== 加载总部人员名单 ======
function loadHQStaff() {
  const f = path.join(__dirname, 'hq-staff-names.json');
  try {
    if (fs.existsSync(f)) {
      const names = JSON.parse(fs.readFileSync(f, 'utf-8'));
      console.log(`[HQ名单] 已加载 ${names.length} 个总部人员关键词`);
      return names;
    }
  } catch (e) {}
  // 兜底：env 中的手动名单
  return (process.env.SKIP_SENDERS || '').split(',').map(s => s.trim()).filter(Boolean);
}

function loadEmployeeSenders() {
  const names = new Set(loadHQStaff());
  const extras = ['艺想'];
  for (const name of extras) names.add(name);

  const file = process.env.HQ_USER_TABLE_FILE || '';
  try {
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf-8');
      for (const line of text.split(/\r?\n/)) {
        if (!/^\|/.test(line) || /序号|------/.test(line)) continue;
        const cols = line.split('|').map(s => s.trim());
        const name = cols[2] || '';
        const nickname = cols[3] || '';
        if (name) names.add(name);
        if (nickname) names.add(nickname);
      }
    }
  } catch (e) {}

  const finalNames = [...names].map(s => String(s || '').trim()).filter(Boolean);
  console.log(`[员工名单] 已加载 ${finalNames.length} 个员工关键词`);
  return finalNames;
}

function loadEmployeeUserIds() {
  const ids = new Set();
  const file = process.env.HQ_USER_TABLE_FILE || '';
  try {
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf-8');
      for (const line of text.split(/\r?\n/)) {
        if (!/^\|/.test(line) || /序号|------/.test(line)) continue;
        const cols = line.split('|').map(s => s.trim());
        const userId = cols[4] || '';
        if (userId) ids.add(userId);
      }
    }
  } catch (e) {}
  const finalIds = [...ids].map(s => String(s || '').trim()).filter(Boolean);
  console.log(`[员工ID] 已加载 ${finalIds.length} 个员工 userId`);
  return finalIds;
}

// ====== 加载知识库（产品知识 + 客服规则）======
let productKnowledge = '';
let productKnowledgeSections = new Map();
let customerServiceKnowledge = '';
let visualKnowledgeBase = null; // 图文知识库 JSON

const PRODUCT_BASE_MATRIX_FILES = [
  '00-AI检索入口.md',
  '00-矩阵索引.md',
  '01-公司概况与设计理念.md',
  '02-产品体系总览.md',
];

const PRODUCT_ROUTED_MATRIX_FILES = [
  '04-抽屉产品详解.md',
  '05-升降机系列详解.md',
  '06-置物架系列详解.md',
  '07-收纳模块与电子设备.md',
  '08A-全屋收纳产品应用.md',
  '09-材质与工艺.md',
  '10-尺寸体系与安装.md',
  '10A-极限安装.md',
  '11-命名逻辑与竞品.md',
];

const PRODUCT_MATRIX_ROUTES = AUTO_REPLY_RULES.productMatrixRoutes;

function normalizeSearchText(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, '');
}

function cleanPromptValue(value, maxLen = 220) {
  const text = String(value || '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[|]+/g, ' / ')
    .trim();
  if (!text || text === '—') return '';
  return text.length > maxLen ? text.slice(0, maxLen - 1) + '…' : text;
}

function stripProductHeight(name) {
  return String(name || '')
    .replace(/[（(]\s*\d+\s*H\s*[）)]/ig, '')
    .replace(/[（(].*?[）)]/g, '')
    .trim();
}

function productField(product, labels) {
  for (const label of labels) {
    const value = product?.tableFields?.[label] ?? product?.[label];
    const cleaned = cleanPromptValue(value);
    if (cleaned) return cleaned;
  }
  return '';
}

function productSearchTerms(product) {
  const terms = new Set();
  [
    product?.name,
    stripProductHeight(product?.name),
    product?.sourceName,
    product?.structuralType,
    product?.parentStructure,
    product?.series,
    product?.majorCategory,
    product?.tableFields?.产品,
    product?.tableFields?.规格,
    ...(product?.aliases || []),
  ].forEach((term) => {
    const cleaned = cleanPromptValue(term, 80);
    if (cleaned && cleaned.length >= 2) terms.add(cleaned);
  });
  return [...terms];
}

function scoreProductForQuery(product, query) {
  const q = normalizeSearchText(query);
  if (!q) return 0;
  let score = 0;
  for (const term of productSearchTerms(product)) {
    const t = normalizeSearchText(term);
    if (!t || t.length < 2) continue;
    if (q.includes(t)) score += 80 + Math.min(t.length, 20);
    else if (t.includes(q) && q.length >= 2) score += 40;
  }
  const fieldText = normalizeSearchText([
    product?.name,
    product?.sourceName,
    product?.structuralType,
    product?.parentStructure,
    product?.series,
    product?.majorCategory,
    product?.structureContext,
    product?.tableFields && Object.values(product.tableFields).join(' '),
  ].filter(Boolean).join(' '));
  for (const kw of ['承重', '尺寸', '高度', '宽度', '深度', '安装', '材质', '配件', '曾用名', '状态']) {
    if (q.includes(kw) && fieldText.includes(kw)) score += 6;
  }
  return score;
}

function summarizeProductForPrompt(product) {
  const fields = [];
  const aliases = (product?.aliases || [])
    .filter(alias => alias && alias !== product.name && alias !== product.sourceName)
    .slice(0, 4)
    .join(' / ');
  const status = productField(product, ['状态']);
  const size = productField(product, ['尺寸/高度/适配', '尺寸', '高度', '规格', '宽度', '适配']);
  const load = productField(product, ['承重', '轨道承重']);
  const structureFeature = productField(product, ['结构特点', '说明', '备注', '产品特点']);
  const custom = productField(product, ['定制', '定制/适配边界']);

  fields.push(`产品: ${cleanPromptValue(product?.name || product?.sourceName || '未命名')}`);
  if (aliases) fields.push(`别名: ${aliases}`);
  if (product?.majorCategory) fields.push(`大类: ${cleanPromptValue(product.majorCategory)}`);
  if (product?.series) fields.push(`系列: ${cleanPromptValue(product.series)}`);
  if (product?.structuralType) fields.push(`结构: ${cleanPromptValue(product.structuralType)}`);
  if (product?.parentStructure) fields.push(`归属结构: ${cleanPromptValue(product.parentStructure)}`);
  if (status) fields.push(`状态: ${status}`);
  if (size) fields.push(`尺寸/规格: ${size}`);
  if (load) fields.push(`承重: ${load}`);
  if (structureFeature) fields.push(`说明: ${structureFeature}`);
  if (custom) fields.push(`定制/适配: ${custom}`);
  if (product?.structureContext) fields.push(`结构口径: ${cleanPromptValue(product.structureContext, 260)}`);
  return `- ${fields.join('；')}`;
}

function buildRelevantProductKnowledge(query, limit = 12) {
  if (!visualKnowledgeBase?.products?.length) return '';
  const scored = visualKnowledgeBase.products
    .map(product => ({ product, score: scoreProductForQuery(product, query) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  if (!scored.length) return '';
  return [
    '===== 命中产品速查（来自当前结构化 JSON）=====',
    ...scored.map(item => summarizeProductForPrompt(item.product)),
  ].join('\n');
}

function buildRelevantMatrixKnowledge(query) {
  if (!productKnowledgeSections.size) return '';
  const normalizedQuery = normalizeSearchText(query);
  const selected = [];
  for (const route of PRODUCT_MATRIX_ROUTES) {
    const matched = route.keywords.some(keyword => normalizedQuery.includes(normalizeSearchText(keyword)));
    if (matched && productKnowledgeSections.has(route.file)) selected.push(route.file);
  }
  const uniqueFiles = [...new Set(selected)].slice(0, 5);
  if (!uniqueFiles.length) return '';
  return uniqueFiles
    .map(fileName => `\n\n===== ${fileName} =====\n\n${productKnowledgeSections.get(fileName)}`)
    .join('');
}

// 尺寸、安装、极限和结构属于“事实判定”问题。
// 这类问题禁止让营销话术、设计建议或空间方案进入同一召回池，以免语言相近却事实无关的页面抢占证据。
const FACTUAL_PRODUCT_QUESTION_RE = /尺寸|宽度|深度|高度|极限|安装|孔位|开孔|净宽|净深|净高|轨道|导轨|承重|材质|结构|构件|配件|适配|兼容|连门|开门|能装|装得下|能否安装|可不可以装|能否定制|定制范围|标准规格|最大|最小/;
const FACTUAL_RETRIEVAL_EXCLUDE_RE = /营销|话术|设计理念|设计建议|空间痛点|空间规划|收纳方案|应用名|品牌定位|公司概况|竞品/;

function getProductKnowledgeRetrievalPolicy(query) {
  const factual = FACTUAL_PRODUCT_QUESTION_RE.test(String(query || '').replace(/\s+/g, ''));
  if (!factual) return { factual: false, options: { limit: CONFIG.llmWikiMaxPages } };
  return {
    factual: true,
    options: {
      // 事实卡保存产品规格、公式、结构和安装边界；规划页和应用/营销页不参与事实检索。
      pageTypes: ['fact'],
      excludePattern: FACTUAL_RETRIEVAL_EXCLUDE_RE,
      limit: Math.max(CONFIG.llmWikiMaxPages, 8),
    },
  };
}

function buildPromptProductKnowledge(query) {
  if (CONFIG.llmWikiEnabled) {
    const policy = getProductKnowledgeRetrievalPolicy(query);
    const result = llmWiki.buildPrompt(query, policy.options);
    if (result.pages.length) {
      console.log(`[LLM Wiki] ${policy.factual ? '事实优先' : '通用'}命中 ${result.pages.length} 页: ${result.pages.map(page => `${page.title}(${page.score})`).join('、')}`);
      return [
        policy.factual
          ? '本题属于产品事实判定。以下内容仅来自结构化产品事实卡；营销话术、设计建议、空间方案均未参与检索，也不得用于尺寸、安装、极限、结构、兼容或材质的事实判断。只能按证据回答，最后才可做不改变事实的简短润色。'
          : '以下内容是本次问题唯一允许使用的产品证据。每条证据均保留原始来源；不得用常识补充证据中没有的尺寸、型号、兼容或安装结论。',
        result.prompt,
      ].join('\n\n');
    }
    console.log('[LLM Wiki] 没有达到最低分的证据页');
    if (CONFIG.llmWikiStrict) {
      return 'LLM Wiki 未找到足够相关的产品证据。不得根据常识回答；只允许返回 REVIEW，要求补充具体产品名称、型号、尺寸或由人工确认。';
    }
  }
  const routed = buildRelevantMatrixKnowledge(query);
  const relevant = buildRelevantProductKnowledge(query);
  return [productKnowledge, routed, relevant].filter(Boolean).join('\n\n');
}

function readExistingText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    return '';
  }
}

function buildCurrentProductKnowledge() {
  const matrixFiles = [...PRODUCT_BASE_MATRIX_FILES, ...PRODUCT_ROUTED_MATRIX_FILES];
  productKnowledgeSections = new Map();
  const sections = [
    '# 酷太产品知识库自动回复精简源',
    '',
    '- 当前事实源：D:\\酷太\\产品知识库\\01_MD章节矩阵 + 05_数据与图片\\酷太产品图文知识库.json。',
    '- 产品应用源文件固定为：D:\\酷太\\产品知识库\\01_MD章节矩阵\\08A-全屋收纳产品应用.md。',
    `- 旧的全屋空间应用框架、空间痛点和场景诊断资料已迁入：${AI_PLANNER_SOURCE_DIR.replace(/\//g, '\\')}\\空间痛点与诊断规则.md；自动回复只把它作为路由边界提示，不把旧 08 文件当当前矩阵入口。`,
    '- HTML 只作为人工阅读层，不作为自动回复事实源。',
    '- 默认只常驻 AI 检索入口、矩阵索引、设计理念和产品体系总览；具体章节按问题意图追加。',
    '- 自动回复只回答产品结构、尺寸、选型、安装、材质、承重、适配、资料发送等有明确依据的问题。',
    '- 价格、订单、物流、退款、财务、售后责任和系统操作不自动回复。',
    '- 抽屉类基础单品统一口径：轨道承重 30kg；产品自重先标记为 *kg，后续按单品补充；组合购买或多层叠加不改变单个抽屉的轨道承重口径。',
    '',
  ];
  for (const fileName of matrixFiles) {
    const filePath = path.join(CURRENT_PRODUCT_MATRIX_DIR, fileName);
    const text = readExistingText(filePath).trim();
    if (text) {
      productKnowledgeSections.set(fileName, text);
      if (PRODUCT_BASE_MATRIX_FILES.includes(fileName)) {
        sections.push(`\n\n===== ${fileName} =====\n\n${text}`);
      }
    }
  }
  const built = sections.join('\n').trim();
  return built.length > 300 ? built : '';
}

function loadVisualKnowledgeBase() {
  const visualKbCandidates = [
    path.join(CURRENT_PRODUCT_DATA_DIR, '酷太产品图文知识库.json'),
  ];

  for (const visualKbPath of visualKbCandidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(visualKbPath, 'utf-8'));
      if (parsed?.products?.length) {
        console.log(`[图文知识库] 已加载 JSON ${path.basename(visualKbPath)} (${parsed.products.length} 个产品)`);
        return parsed;
      }
    } catch (e) {}
  }

  console.log('[图文知识库] 加载失败: 未找到当前产品 JSON');
  return null;
}

function loadProductKnowledge() {
  visualKnowledgeBase = loadVisualKnowledgeBase();

  if (CONFIG.llmWikiEnabled) {
    const wikiPages = llmWiki.load();
    if (wikiPages) console.log(`[LLM Wiki] 已加载 ${wikiPages} 页，生成时间 ${llmWiki.generatedAt || '未知'}`);
    else console.log(`[LLM Wiki] 加载失败: ${llmWiki.indexFile}`);
  }

  const currentKnowledge = buildCurrentProductKnowledge();
  if (currentKnowledge) {
    productKnowledge = currentKnowledge;
    console.log(`[知识库] 已加载当前矩阵精简源 (${(productKnowledge.length / 1024).toFixed(0)} KB)`);
    return;
  }

  if (!productKnowledge) {
    console.log('[知识库] 加载失败: 未找到当前产品矩阵');
  }
}

function loadCustomerServiceKnowledge() {
  const kbCandidates = [
    path.join(PRODUCT_KB_DIR, '酷太客服自动回复知识库.md'),
  ];

  for (const kbFile of kbCandidates) {
    try {
      customerServiceKnowledge = fs.readFileSync(kbFile, 'utf-8');
      console.log(`[客服知识库] 已加载 ${path.basename(kbFile)} (${(customerServiceKnowledge.length / 1024).toFixed(0)} KB)`);
      break;
    } catch (e) {}
  }

  if (!customerServiceKnowledge) {
    console.log('[客服知识库] 加载失败: 未找到可用客服规则文件');
  }
}

// ====== 图文知识库匹配 ======
function matchProductFromVisualKB(imageDescription) {
  if (!visualKnowledgeBase?.products) return null;
  const desc = (imageDescription || '').toLowerCase();

  // 关键词 → 产品结构类型映射
  const keywordMap = {
    '碗碟': ['碗碟', '碗盘', '餐盘', '盘子'],
    '半抽': ['半抽', '一半', '一分为二'],
    '抽中抽': ['抽中抽', '双层', '薄抽', '两层'],
    '横向分隔': ['横向', '横杆', '分隔片', '横隔'],
    '纵向分隔': ['纵向', '竖杆', '竖隔', '纵隔'],
    '调料': ['调料', '调味', '香料', '油瓶'],
    '锅具': ['锅', '锅盖', '锅铲', '炒锅'],
    '工具': ['工具', '铲子', '勺子', '厨具'],
    '谷物': ['谷物', '米', '粮食', '干货', '杂粮'],
    '空抽': ['空抽', '空抽屉', '无分隔'],
    '升降': ['升降', '下拉', '拉下'],
    '置物架': ['置物架', '台面架', '微波炉架'],
    '拉篮': ['拉篮', '网篮', '线篮'],
    '百纳阁': ['百纳阁', '百纳', '整抽', '轨道装底板'],
    '百纳抽': ['百纳抽', '魔法百纳'],
  };

  const scores = [];
  for (const p of visualKnowledgeBase.products) {
    let score = 0;
    const name = (p.name || '').toLowerCase();
    const structuralType = (p.structuralType || '').toLowerCase();
    const aiContext = (p.aiContext || '').toLowerCase();
    const searchText = name + ' ' + structuralType + ' ' + aiContext + ' ' +
      (p.aliases || []).join(' ') + ' ' + (p.knowledgeSnippets || []).map(s => (s.excerpt || '')).join(' ');

    // 结构类型精确匹配
    for (const [type, keywords] of Object.entries(keywordMap)) {
      for (const kw of keywords) {
        if (desc.includes(kw) && name.includes(kw)) score += 15;
        else if (desc.includes(kw) && structuralType.includes(kw)) score += 12;
        else if (desc.includes(kw) && aiContext.includes(kw)) score += 5;
      }
    }

    // 图片相关描述 vs 产品知识匹配
    const terms = ['抽屉', '柜', '厨房', '分隔', '金属', '拉篮', '收纳', '层板',
      '开门', '连门', '安装', '轨道', '深度', '宽度', '高度', '柜体',
      '竖放', '插放', '堆放', '平放', '不锈钢', '铝合金', '塑料'];
    for (const t of terms) {
      if (desc.includes(t) && searchText.includes(t)) score += 2;
    }

    // 产品名直接出现在识别结果中
    if (desc.includes(name)) score += 20;

    if (score > 0) scores.push({ product: p, score });
  }

  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, 3); // 返回 top 3
}
const SHARED_HISTORY_FILE = path.join(DATA_DIR, 'shared-history.json');
const FILE_ASSET_ROOTS = [
  process.env.IMAGE_LIBRARY_ROOT || '',
  path.join(CURRENT_PRODUCT_DATA_DIR, 'images'),
  path.join(CURRENT_PRODUCT_DATA_DIR, '极限尺寸安装示意图'),
  path.join(CURRENT_PRODUCT_DATA_DIR, '钉钉PDF下载'),
  'D:/Codex/钉钉PDF下载/产品受控文件（服务商）',
  'D:/Codex/钉钉PDF下载',
].filter(Boolean);
const INSTALL_IMAGE_INDEX_FILE = process.env.INSTALL_IMAGE_INDEX_FILE || path.join(
  process.env.IMAGE_LIBRARY_ROOT || path.resolve(__dirname, '..', '图片库'),
  '产品安装图片',
  '产品安装图片索引.json'
);
let fileAssetIndex = null;
let productReferenceImageCatalog = null;
let installImageIndex = null;

function loadHistory() {
  try { return fs.existsSync(SHARED_HISTORY_FILE) ? JSON.parse(fs.readFileSync(SHARED_HISTORY_FILE, 'utf-8')) : []; }
  catch { return []; }
}

function saveHistory(history) {
  fs.writeFileSync(SHARED_HISTORY_FILE, JSON.stringify(history.slice(-50)));
}

function buildFileAssetIndex() {
  if (fileAssetIndex) return fileAssetIndex;
  const index = new Map();
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(pdf|png|jpg|jpeg|webp)$/i.test(entry.name)) continue;
      const key = entry.name.toLowerCase();
      if (!index.has(key)) index.set(key, full);
    }
  };
  for (const root of FILE_ASSET_ROOTS) {
    if (fs.existsSync(root)) walk(root);
  }
  fileAssetIndex = index;
  console.log(`[文件索引] 已加载 ${index.size} 个资料文件`);
  return fileAssetIndex;
}

function loadProductReferenceImageCatalog() {
  if (productReferenceImageCatalog) return productReferenceImageCatalog;
  const root = path.join(process.env.IMAGE_LIBRARY_ROOT || path.resolve(__dirname, '..', '图片库'), '产品基础图片');
  const rows = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (/\.(png|jpg|jpeg|webp)$/i.test(entry.name)) rows.push({ base: entry.name, fullPath });
    }
  };
  walk(root);
  productReferenceImageCatalog = rows;
  console.log(`[产品参考图索引] 已加载 ${rows.length} 张基础产品图`);
  return productReferenceImageCatalog;
}

function loadInstallImageIndex() {
  if (installImageIndex) return installImageIndex;
  try {
    const parsed = JSON.parse(fs.readFileSync(INSTALL_IMAGE_INDEX_FILE, 'utf-8'));
    const imageDir = path.dirname(INSTALL_IMAGE_INDEX_FILE);
    const items = (parsed.items || [])
      .map(item => ({
        ...item,
        product: String(item.product || '').trim(),
        file: String(item.file || '').trim(),
        aliases: Array.isArray(item.aliases) ? item.aliases.map(alias => String(alias || '').trim()).filter(Boolean) : [],
        fullPath: path.join(imageDir, String(item.file || '').trim()),
        extraPaths: Array.isArray(item.extraFiles)
          ? item.extraFiles.map(file => path.join(imageDir, String(file || '').trim())).filter(file => fs.existsSync(file))
          : [],
        installExtraPaths: Array.isArray(item.installExtraFiles)
          ? item.installExtraFiles.map(file => path.join(imageDir, String(file || '').trim())).filter(file => fs.existsSync(file))
          : [],
      }))
      .filter(item => item.product && item.file && fs.existsSync(item.fullPath));
    installImageIndex = { ...parsed, items, imageDir };
    console.log(`[安装图片索引] 已加载 ${items.length} 个产品关联`);
    return installImageIndex;
  } catch (e) {
    console.warn(`[安装图片索引] 加载失败: ${e.message}`);
    installImageIndex = { items: [] };
    return installImageIndex;
  }
}

function looksLikeInstallationRelatedQuestion(content) {
  const text = stripMediaMarkers(String(content || '')).replace(/\s+/g, '');
  if (!text) return false;
  return /(安装|怎么装|如何装|咋装|能装|可以装|装得下|装不了|孔位|开孔|极限尺寸|极限安装|安装尺寸|安装宽度|安装深度|安装高度|柜内净宽|柜内净深|柜内净高|预留尺寸|安装条件|安装要求)/.test(text);
}

function containsInstallImageExclusion(text) {
  const source = normalizeAssetSearchText(text);
  const exclusions = loadInstallImageIndex().magic_drawer_inheritance_exclusions || {};
  const terms = [
    ...(exclusions.custom_shapes_not_linked_yet || []),
    ...(exclusions.non_customizable_models || []),
  ].map(normalizeAssetSearchText).filter(Boolean);
  return terms.some(term => source.includes(term));
}

function scoreInstallImageItem(item, text) {
  const source = normalizeAssetSearchText(text);
  if (!source) return 0;
  const terms = [item.product, ...(item.aliases || [])]
    .map(normalizeAssetSearchText)
    .filter(term => term.length >= 2);
  let best = 0;
  for (const term of terms) {
    if (!source.includes(term)) continue;
    const exactProduct = term === normalizeAssetSearchText(item.product);
    best = Math.max(best, (exactProduct ? 300 : 180) + term.length * 8);
  }
  return best;
}

function findFamilyInstallationImages(currentContent, limit = 3) {
  const index = loadInstallImageIndex();
  const source = normalizeAssetSearchText(currentContent);
  for (const group of index.family_install_groups || []) {
    const matchTerms = (group.matchTerms || []).map(normalizeAssetSearchText).filter(Boolean);
    if (!matchTerms.some(term => source.includes(term))) continue;
    const specificCues = (group.specificCues || []).map(normalizeAssetSearchText).filter(Boolean);
    if (specificCues.some(term => source.includes(term))) continue;
    return (group.files || [])
      .map(file => path.join(index.imageDir || path.dirname(INSTALL_IMAGE_INDEX_FILE), String(file || '').trim()))
      .filter(file => fs.existsSync(file))
      .slice(0, limit);
  }
  return [];
}

function findInstallationReferenceImages(currentContent, contextText = '', replyText = '', limit = 1) {
  if (!looksLikeInstallationRelatedQuestion(currentContent)) return [];
  if (containsInstallImageExclusion(currentContent)) return [];
  const familyImages = findFamilyInstallationImages(currentContent, limit);
  if (familyImages.length) return familyImages;
  const items = loadInstallImageIndex().items || [];
  const candidates = items
    .filter(item => item.confidence !== 'needs_confirmation')
    .map(item => ({
      item,
      score:
        scoreInstallImageItem(item, currentContent) * 4 +
        scoreInstallImageItem(item, replyText) * 2 +
        scoreInstallImageItem(item, contextText),
    }))
    .filter(candidate => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.item.product.localeCompare(b.item.product, 'zh-CN'));

  if (!candidates.length) return [];
  if (candidates[1] && candidates[0].score === candidates[1].score) {
    console.log(`[安装图片索引] 匹配并列，暂不自动附图: ${candidates[0].item.product} / ${candidates[1].item.product}`);
    return [];
  }
  const top = candidates[0].item;
  const source = normalizeAssetSearchText(currentContent);
  if ((top.installExtraPaths || []).length) {
    if (/(开门式|开门款|开门安装)/.test(source)) return top.installExtraPaths.slice(0, limit);
    if (/(抽屉式|连门式|连门款|连门安装)/.test(source)) return [top.fullPath].slice(0, limit);
  }
  return [top.fullPath, ...(top.installExtraPaths || [])].slice(0, limit);
}

function findIndexedProductImages(text, limit = 2) {
  if (containsInstallImageExclusion(text)) return [];
  const candidates = (loadInstallImageIndex().items || [])
    .filter(item => item.confidence !== 'needs_confirmation')
    .map(item => ({ item, score: scoreInstallImageItem(item, text) }))
    .filter(candidate => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.item.product.localeCompare(b.item.product, 'zh-CN'));
  if (!candidates.length) return [];
  if (candidates[1] && candidates[0].score === candidates[1].score) return [];
  return [candidates[0].item.fullPath, ...(candidates[0].item.extraPaths || [])].slice(0, limit);
}

function buildReplyAssetPaths({ content = '', context = '', reply = '', decision = '' } = {}) {
  const paths = [];
  const add = file => {
    if (file && fs.existsSync(file) && !paths.includes(file)) paths.push(file);
  };

  for (const name of extractReferencedAssetNames(reply)) add(findLocalAssetByName(name));

  // 图片请求由消息意图或候选回复的明确承诺触发。后者用于“云狐长啥样”这类
  // 口语问法：模型已确认要发产品参考图时，不能只发送文字而漏掉附件。
  const promisedProductImage = /(?:产品|实物|参考|效果|外观).{0,5}(?:图|图片)|(?:直接|给你|我).{0,6}发.{0,6}(?:图|图片)/.test(String(reply || ''));
  if (decision === 'local_product_image_rule' || looksLikeProductImageRequest(content) || promisedProductImage) {
    const productImages = findProductReferenceImages(`${content}\n${context}`, 2);
    for (const file of productImages) add(file);
    // 没有基础产品图时才回退到安装图索引，避免“看外观”混发安装尺寸图。
    if (!productImages.length) {
      for (const file of findIndexedProductImages(`${content}\n${context}`, 2)) add(file);
    }
  }

  for (const file of findInstallationReferenceImages(content, context, reply, 3)) add(file);
  return paths.slice(0, 3);
}

function extractReferencedAssetNames(text) {
  const source = String(text || '');
  const results = new Set();
  const patterns = [
    /`([^`]+\.(?:pdf|png|jpg|jpeg|webp))`/gi,
    /([^\s`"'<>，。；、：:]+?\.(?:pdf|png|jpg|jpeg|webp))/giu,
    /(S\d{2}\.\d{3}[A-Z]?-[^\n`。；，]+?\.(?:pdf|png|jpg|jpeg|webp))/gi,
    /([^\s`"'<>，。；、：:]+?(?:说明书|孔位图|极限尺寸|极限安装|安装示意图|示意图)[^\s`"'<>，。；、：:]*\.(?:pdf|png|jpg|jpeg|webp))/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source)) !== null) {
      const name = String(m[1] || '').trim();
      if (name) results.add(name);
    }
  }
  return [...results];
}

function findLocalAssetByName(name) {
  const target = String(name || '').trim().toLowerCase();
  if (!target) return '';
  const index = buildFileAssetIndex();
  if (index.has(target)) return index.get(target);

  for (const [base, full] of index.entries()) {
    if (base.includes(target) || target.includes(base)) return full;
  }
  return '';
}

function getDirectConversationSpaceId(msg) {
  if (!msg?.senderOpenDingTalkId) return '';
  const info = dws(`chat conversation-info --open-dingtalk-id "${msg.senderOpenDingTalkId}"`);
  return info?.result?.conversationInfo?.extension?.newCSpaceIdIM || '';
}

function sendDirectFile(msg, localPath, title = '资料') {
  try {
    const spaceId = getDirectConversationSpaceId(msg);
    if (!spaceId) {
      console.error('[DWS DIRECT FILE] 获取单聊空间失败');
      return null;
    }

    const uploadArgs = ['drive', 'upload', '--file', localPath, '--space-id', String(spaceId)];
    const upload = runDwsCommand(uploadArgs, 'DWS DRIVE UPLOAD');
    const fileId = upload?.result?.fileId;
    const fileName = upload?.result?.fileName || path.basename(localPath);
    const fileSize = upload?.result?.fileSize || fs.statSync(localPath).size;
    if (!fileId) {
      console.error('[DWS DIRECT FILE] 上传后未返回 fileId');
      return null;
    }

    const infoArgs = ['drive', 'info', '--node', String(fileId), '--space-id', String(spaceId)];
    const info = runDwsCommand(infoArgs, 'DWS DRIVE INFO');
    const dentryId = info?.result?.dentryId;
    const filePath = info?.result?.path || `/${fileName}`;
    const fileType = info?.result?.extension || path.extname(fileName).replace(/^\./, '') || 'pdf';
    if (!dentryId) {
      console.error('[DWS DIRECT FILE] 获取 dentryId 失败');
      return null;
    }

    const sendArgs = [
      'chat', 'message', 'send',
      '--open-dingtalk-id', msg.senderOpenDingTalkId,
      '--title', title,
      '--msg-type', 'file',
      '--dentry-id', String(dentryId),
      '--space-id', String(spaceId),
      '--file-name', fileName,
      '--file-type', fileType,
      '--file-path', filePath,
      '--file-size', String(fileSize),
    ];
    return runDwsCommand(sendArgs, 'DWS DIRECT FILE SEND');
  } catch (e) {
    console.error(`[DWS DIRECT FILE] ${e.message}`);
    return null;
  }
}

function maybeSendReferencedFiles(msg, reply) {
  const names = extractReferencedAssetNames(reply);
  if (!names.length) return { sentAny: false, sent: [] };
  const sent = [];
  for (const name of names) {
    const localPath = findLocalAssetByName(name);
    if (!localPath) continue;
    const result = sendDirectFile(msg, localPath, '资料文件');
    if (result?.success || result?.errorCode === 0 || result?.result?.openTaskId) {
      sent.push({ name, localPath });
      console.log(`  [文件发送] ${msg.sender}: ${path.basename(localPath)}`);
    }
  }
  return { sentAny: sent.length > 0, sent };
}

const INSTALL_TUTORIAL_FALLBACK_REPLY = '安装教程在微信视频号搜：酷太新零售哦';
const PRODUCT_ASSET_SEARCH_TERMS = [
  '云狐', '云梯', '云阁', '云弧', '云曦', '升降机', '尚酷双层升降机', '尚酷高柜',
  '中枢阁', '翼枢阁', '展翼阁', '巧翼阁', '之行阁', '挂门宝', '万象阁', '转枢阁',
  '魔法抽', '四代魔法抽', '尚酷抽', '倾松抽', '水槽抽', '水槽柜', '水槽中枢阁', '水槽侧拉',
  '碗碟', '插锅架', '工具分隔盒', '百纳阁', '护发抽', '墙挂', '挂多多',
  '柜底双层', '备餐架', '大嘴阁', '灵动衣架', '小怪物', '飞蝶', '高柜', '护理小精灵',
];

function normalizeAssetSearchText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, '');
}

function looksLikeInstallTutorialQuestion(content) {
  const text = stripMediaMarkers(String(content || '')).replace(/\s+/g, '');
  if (!text) return false;

  if (/(安装说明书|说明书|安装教程|安装视频|安装指南|安装步骤|安装流程|安装方法|安装使用说明书)/.test(text)) return true;
  if (/(怎么|如何|咋).{0,8}(安装|装)/.test(text)) return true;
  if (/(安装|装).{0,8}(怎么弄|怎么搞|怎么操作|咋弄|咋搞|教程|视频|说明|指南|步骤|流程|方法)/.test(text)) return true;
  if (/(发|给).{0,8}(安装说明书|说明书|安装教程|安装视频|安装指南|教程|视频|指南)/.test(text)) return true;
  if (/(要|有).{0,8}(安装说明书|说明书|安装教程|安装视频|安装指南|教程|视频|指南)/.test(text)) return true;

  return false;
}

function extractInstallAssetSearchTerms(text) {
  const source = normalizeAssetSearchText(text);
  const terms = new Set();

  const codeMatches = String(text || '').match(/\b[A-Z]?\d{2}\.\d{3}[A-Z]?(?:[-.]?\d{3,4}[A-Z]?)?\b/gi) || [];
  for (const code of codeMatches) terms.add(normalizeAssetSearchText(code));

  for (const term of PRODUCT_ASSET_SEARCH_TERMS) {
    const normalized = normalizeAssetSearchText(term);
    if (normalized && source.includes(normalized)) terms.add(normalized);
  }

  return [...terms].sort((a, b) => b.length - a.length);
}

function looksLikeProductImageRequest(content) {
  const text = stripMediaMarkers(String(content || '')).replace(/\s+/g, '');
  if (!text) return false;
  if (/(支持图片吗|可以发图片吗|能看图片吗|图片支持吗|图片可以吗)/.test(text)) return false;
  if (/(看图|图里|图中|现场图|客户家|这个位置|这种位置|方案|能不能装|可以装吗|怎么装|如何装)/.test(text)) return false;
  return /(实物图|实物图片|产品图|产品图片|产品参考图|参考图|效果图|外观图|场景图|应用图|长啥样|长什么样|什么样子|外观如何)|((有|有没有|发|给|要|需要|看|看看|提供).{0,10}(图|图片|照片))/.test(text);
}

function findProductReferenceImages(text, limit = 2) {
  const terms = extractInstallAssetSearchTerms(text);
  if (!terms.length) return [];

  const candidates = [];
  // 仅从“产品基础图片”匹配，避免同名空间效果图、未绑定素材或安装图抢占结果。
  for (const { base, fullPath } of loadProductReferenceImageCatalog()) {
    const name = normalizeAssetSearchText(base);
    const full = normalizeAssetSearchText(fullPath);

    let score = 0;
    for (const term of terms) {
      if (name.includes(term)) score += 140 + term.length;
      else if (full.includes(term)) score += 90 + term.length;
    }
    if (!score) continue;
    if (/^(1-1|01|1_1)/i.test(base)) score += 30;
    if (/^(1-2|02|1_2)/i.test(base)) score += 20;
    if (/(详情|尺寸|安装|孔位|示意|说明)/.test(name)) score -= 80;
    candidates.push({ base, fullPath, score });
  }

  candidates.sort((a, b) => b.score - a.score || a.base.localeCompare(b.base, 'zh-CN'));
  const seen = new Set();
  return candidates
    .filter(item => {
      const key = normalizeAssetSearchText(item.base);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit)
    .map(item => item.fullPath);
}

function isInstallationManualAssetName(assetName) {
  const name = normalizeAssetSearchText(assetName);
  if (!/(安装使用说明书|安装说明书|安装指南说明书|安装指南|安装说明|说明书|安装教程|安装示意|简易安装说明)/.test(name)) return false;
  return !/(孔位|极限尺寸|极限安装|模版|模板)/.test(name);
}

function applyInstallAssetHints(candidates, text) {
  let result = candidates;
  const source = normalizeAssetSearchText(text);
  const applyHint = (hint, pattern) => {
    if (!hint.test(source)) return;
    const filtered = result.filter(item => pattern.test(item.name) || pattern.test(item.full));
    if (filtered.length) result = filtered;
  };

  applyHint(/水槽/, /水槽/);
  applyHint(/(二、三层|二三层|2、3层|2-3层|2\/3层|三层|3层)/, /(二、三层|二三层|2、3层|2-3层|三层|3层|三)/);
  applyHint(/(七层|7层)/, /(七层|7层|七)/);
  applyHint(/(两层|二层|2层)/, /(两层|二层|2层|二)/);
  applyHint(/四代|4代/, /四代|4代/);
  applyHint(/尚酷/, /尚酷/);

  return result;
}

function findInstallationManualAsset(text) {
  const terms = extractInstallAssetSearchTerms(text);
  if (!terms.length) return '';

  const index = buildFileAssetIndex();
  let candidates = [];
  for (const [base, fullPath] of index.entries()) {
    const name = normalizeAssetSearchText(base);
    const full = normalizeAssetSearchText(fullPath);
    if (!isInstallationManualAssetName(base)) continue;

    let score = 0;
    for (const term of terms) {
      if (name.includes(term) || full.includes(term)) {
        score += /^\d{2}\.\d{3}|^[a-z]\d{2}\.\d{3}/i.test(term) ? 200 : 100 + term.length;
      }
    }
    if (score > 0) candidates.push({ base, fullPath, name, full, score });
  }

  candidates = applyInstallAssetHints(candidates, text)
    .sort((a, b) => b.score - a.score || a.base.length - b.base.length);

  if (candidates.length === 1) return candidates[0].fullPath;
  if (!candidates.length) return '';
  if (/\b[A-Z]?\d{2}\.\d{3}/i.test(text) && candidates[0].score >= 200) return candidates[0].fullPath;
  if (candidates[0].score - (candidates[1]?.score || 0) >= 20) return candidates[0].fullPath;
  return '';
}

function buildInstallTutorialRuleReply(currentContent, contextText = '') {
  if (!looksLikeInstallTutorialQuestion(currentContent)) return '';
  const assetPath = findInstallationManualAsset(`${currentContent || ''}\n${contextText || ''}`);
  if (assetPath) return `这个有对应安装说明书，我发你这份：${path.basename(assetPath)}`;
  return INSTALL_TUTORIAL_FALLBACK_REPLY;
}

function buildProductImageRuleReply(currentContent, contextText = '') {
  if (!looksLikeProductImageRequest(currentContent)) return '';
  const imagePaths = findProductReferenceImages(`${currentContent || ''}\n${contextText || ''}`, 2);
  if (!imagePaths.length) return '';
  const names = imagePaths.map(file => `\`${path.basename(file)}\``).join('、');
  return `参考图：${names}`;
}

function looksLikeProductIntroductionRequest(text) {
  const source = stripMediaMarkers(String(text || '')).replace(/\s+/g, '');
  return /(?:介绍话术|介绍文案|产品介绍|怎么介绍|如何介绍|怎么讲|话术)/.test(source);
}

function plannerPitchKnowledgeCandidates() {
  const fileName = '10_魔法抽产品介绍话术专项.md';
  return [
    path.join(AI_PLANNER_SOURCE_DIR, '_Dify上传合集', fileName),
    path.join(AI_PLANNER_SOURCE_DIR, fileName),
    path.join(CURRENT_PRODUCT_KB_ROOT, '_Dify上传合集', fileName),
    path.join(CURRENT_PRODUCT_KB_ROOT, fileName),
  ];
}

function extractPlannerPitchCodeBlock(knowledge, cardTitle, sectionTitle) {
  const cardStart = knowledge.indexOf(`# ${cardTitle}`);
  if (cardStart < 0) return '';
  const nextCard = knowledge.indexOf('\n---\n\n<!--', cardStart + cardTitle.length + 2);
  const card = knowledge.slice(cardStart, nextCard >= 0 ? nextCard : undefined);
  const sectionStart = card.indexOf(`## ${sectionTitle}`);
  if (sectionStart < 0) return '';
  const section = card.slice(sectionStart);
  const match = section.match(/```text\s*\r?\n([\s\S]*?)\r?\n```/);
  return match ? match[1].trim() : '';
}

function buildProductIntroductionReplyFromKnowledge(text) {
  if (!looksLikeProductIntroductionRequest(text)) return '';
  const knowledge = plannerPitchKnowledgeCandidates()
    .map(readExistingText)
    .find(Boolean);
  if (!knowledge) return '';

  const source = stripMediaMarkers(String(text || '')).replace(/\s+/g, '');
  if (/碗碟(?:抽)?半抽|碗碟抽中抽半抽/.test(source)) {
    return extractPlannerPitchCodeBlock(knowledge, '碗碟半抽介绍话术与结构防错', '可直接发送的话术');
  }
  if (/魔法抽/.test(source)) {
    return extractPlannerPitchCodeBlock(knowledge, '魔法抽通用版与补充信息版', '通用介绍（可直接回复）');
  }
  return '';
}

function buildAmbiguousProductClarification(text, context = '') {
  if (!looksLikeProductIntroductionRequest(text)) return '';
  const source = stripMediaMarkers(`${context || ''}\n${text || ''}`).replace(/\s+/g, '');
  const rules = [
    {
      family: /中枢阁/,
      specific: /水槽|餐边|层盒|地柜|普通款|[237]层|二层|三层|七层|51\.203\./i,
      reply: '你想介绍的是哪一款中枢阁？请确认是普通地柜款、中枢阁水槽款，还是餐边层盒款；不同款的结构和使用场景不一样，确认后我再按对应产品写介绍话术。',
    },
    {
      family: /小怪物/,
      specific: /转角|全开|巧翼阁|展翼阁|四代/,
      reply: '请确认你说的是转角小怪物（巧翼阁），还是全开小怪物（展翼阁）；两款结构和使用场景不同，确认后我再写对应介绍话术。',
    },
    {
      family: /升降机/,
      specific: /云狐|云梯|云阁|云舱|云峰|尚酷|双层|高柜|吊柜/,
      reply: '请补充具体升降机名称或使用位置，例如云狐、云梯、云阁、吊柜升降机或高柜升降机；确认具体产品后我再写介绍话术。',
    },
    {
      family: /(?:置物架|抽屉)(?!系列)/,
      specific: /魔法抽|尚酷|中枢阁|翼枢阁|展翼阁|巧翼阁|旋翼阁|碗碟|锅具|调料|食品|衣物|水槽|具体型号/,
      reply: '请补充具体产品名称或型号。当前名称对应多种产品，直接写介绍容易把结构和场景混在一起。',
    },
  ];
  for (const rule of rules) {
    if (rule.family.test(source) && !rule.specific.test(source)) return rule.reply;
  }
  return '';
}

function buildAmbiguousProductFactClarification(text, context = '') {
  const source = stripMediaMarkers(`${context || ''}\n${text || ''}`).replace(/\s+/g, '');
  const factCue = /左右|方向|尺寸|安装|宽|深|高|承重|挂盒|几层|多少|能不能|是否|适配|兼容/.test(source);
  if (!factCue) return '';
  if (/中枢阁/.test(source) && !/水槽|餐边|层盒|地柜|普通款|[237]层|二层|三层|七层|\d{3}柜|51\.20[123]\./i.test(source)) {
    return '请先确认具体是哪款中枢阁，以及层数或柜体规格。普通地柜款、水槽款和餐边层盒款的方向、挂盒与安装尺寸不同，不能用一个款式的参数代替整个中枢阁系列。';
  }
  if (/挂门宝/.test(source) && !/[23]层|两层|三层|\d{3}柜|450柜/i.test(source)) {
    return '请补充挂门宝的层数和柜体规格。不同规格的产品尺寸、挂盒尺寸和安装极限不同，确认后我再给对应数据。';
  }
  if (/小怪物/.test(source) && !/转角|全开|巧翼阁|展翼阁|四代/.test(source)) {
    return '请确认是转角小怪物（巧翼阁）还是全开小怪物（展翼阁）；两款安装尺寸和结构不同。';
  }
  return '';
}

function buildMagicDrawerParameterReplyFromKnowledge(text) {
  const source = stripMediaMarkers(String(text || '')).replace(/\s+/g, '');
  if (!/魔法抽/.test(source)) return '';

  let field = '';
  if (/深度.*定制|定制.*深度/.test(source) && /多少|几个|哪些|可选|选择|范围|规格/.test(source)) {
    field = '深度定制问法';
  } else if (/标准(?:规格|品)?.*深度|深度.*标准(?:规格|品)?/.test(source)) {
    field = '标准深度问法';
  } else if (/标准(?:规格|品)?.*宽度|宽度.*标准(?:规格|品)?|标准规格.*几个宽/.test(source)) {
    field = '标准宽度问法';
  }
  if (!field) return '';

  const candidates = [
    path.join(AI_PLANNER_SOURCE_DIR, '基础产品知识卡', '0291_尺寸与安装_魔法抽通用规格参数问法.md'),
    path.join(AI_PLANNER_SOURCE_DIR, '01_MD章节矩阵', '16-自动回复精准规则补充.md'),
    path.join(AI_PLANNER_SOURCE_DIR, '_Dify上传合集', '06_尺寸安装与极限安装.md'),
    path.join(CURRENT_PRODUCT_KB_ROOT, '基础产品知识卡', '0291_尺寸与安装_魔法抽通用规格参数问法.md'),
    path.join(CURRENT_PRODUCT_KB_ROOT, '01_MD章节矩阵', '16-自动回复精准规则补充.md'),
    path.join(CURRENT_PRODUCT_KB_ROOT, '_Dify上传合集', '06_尺寸安装与极限安装.md'),
  ];
  const knowledge = candidates.map(readExistingText).find(content => content.includes('# 魔法抽通用规格参数问法') || content.includes('标准宽度问法')) || '';
  const match = knowledge.match(new RegExp(`^- ${field}：(.+)$`, 'm'));
  return match ? match[1].trim() : '';
}

function buildMagicDrawerSingleDoorWidthReplyFromKnowledge(text) {
  const source = stripMediaMarkers(String(text || '')).replace(/\s+/g, '');
  if (!/(?:魔法抽|魔法空抽)/.test(source)) return '';
  if (!/(?:单开门|开门)/.test(source)) return '';

  const widthMatch = source.match(/(\d{3,4})(?:mm)?柜/);
  const cabinetWidth = widthMatch ? Number(widthMatch[1]) : 0;
  if (cabinetWidth < 600) return '';

  const knowledge = loadDrawerWidthFormulaFromKnowledge();
  const deduction = knowledge?.formulas?.['单开门'];
  if (!deduction) return `魔法抽单开门的标品最大做到550柜。${cabinetWidth}柜单开门没有标品；如确有需要，可以走定制。`;
  const drawerWidth = Math.round((cabinetWidth - deduction) * 10) / 10;
  return `魔法抽${cabinetWidth}柜单开门按现有宽度公式计算：${cabinetWidth}-18×2（两侧柜板）-11×2（两侧轨道间隙）-25（单边避铰链轨道垫块）=${drawerWidth}mm，因此抽屉定制外宽为${drawerWidth}mm。${cabinetWidth}柜单开门没有标品，需要走定制。`;
}

// 衣帽间抽屉仅有两档轨道；抽屉深度必须严格按“轨道深度 + 10mm”计算。
const WARDROBE_DRAWER_RAIL_DEPTHS = new Set([450, 500]);

function buildWardrobeDrawerDepthReplyFromKnowledge(content) {
  const text = String(content || '').replace(/\s+/g, '');
  if (!/(衣帽间|衣帽抽|衣柜抽|衣柜).*(?:抽屉|抽|轨道|导轨|深度)|(?:抽屉|抽|轨道|导轨|深度).*(?:衣帽间|衣帽抽|衣柜抽|衣柜)/.test(text)) return '';
  if (!/(深度|抽深|轨道|导轨|能装|可以装|可不可以|能不能|定制)/.test(text)) return '';

  const railMatch = text.match(/(\d{3})(?:mm)?(?:轨道|导轨)|(?:轨道|导轨)(\d{3})(?:mm)?/);
  const railDepth = railMatch ? Number(railMatch[1] || railMatch[2]) : 0;
  const depthMatch = text.match(/(?:衣柜|衣帽间|柜内(?:净)?深|柜体(?:内)?深|抽屉深度|抽深|深度).{0,8}?(\d{3})(?:mm)?/);
  const statedDepth = depthMatch ? Number(depthMatch[1]) : 0;

  if (railDepth) {
    if (!WARDROBE_DRAWER_RAIL_DEPTHS.has(railDepth)) {
      return `衣帽间抽屉仅有450mm和500mm两档轨道，不接受其他深度范围或特殊定制；抽屉深度固定按“轨道深度+10mm”配套，即460mm或510mm。${railDepth}mm不是当前衣帽抽的标准轨道规格。`;
    }
    const drawerDepth = railDepth + 10;
    return `${railDepth}mm轨道对应${drawerDepth}mm抽屉深度。衣帽间抽屉仅有460mm和510mm两档：450mm轨道配460mm、500mm轨道配510mm；不走连续深度范围或其他特殊定制。轨道尾部卡扣固定在抽屉背后，若衣柜内净深只等于${drawerDepth}mm，背后会额外凸出约5mm；需在业主衣柜背板的轨道尾部卡扣对应位置打孔，抽屉才能完全推进。该打孔会对衣柜背板造成轻度不可逆改动，须事先确认。`;
  }

  if (statedDepth) {
    const matchedRail = statedDepth - 10;
    if (!WARDROBE_DRAWER_RAIL_DEPTHS.has(matchedRail)) {
      return `衣帽间抽屉仅有460mm和510mm两档，不接受其他深度范围或特殊定制；固定按“轨道深度+10mm”配套。${statedDepth}mm需要${matchedRail}mm轨道，但当前衣帽抽只用450mm或500mm轨道，不能按${statedDepth}mm特殊定制。`;
    }
    return `可以按衣帽间抽屉的固定公式处理：${statedDepth}mm抽屉深度配${matchedRail}mm轨道；衣帽间抽屉仅有460mm和510mm两档，抽屉深度=轨道深度+10mm，不走连续深度范围或其他特殊定制。轨道尾部卡扣固定在抽屉背后；若衣柜内净深只有${statedDepth}mm，背后会额外凸出约5mm，需在业主衣柜背板的轨道尾部卡扣对应位置打孔，确保抽屉能完全推进。该打孔会对衣柜背板造成轻度不可逆改动，须事先确认。`;
  }

  return '衣帽间抽屉仅有460mm和510mm两档：450mm轨道配460mm抽屉深度，500mm轨道配510mm抽屉深度；固定按“抽屉深度=轨道深度+10mm”配套，不走连续深度范围或其他特殊定制。轨道尾部卡扣固定在抽屉背后；若柜内净深只等于抽屉深度，需在业主衣柜背板的轨道尾部卡扣对应位置打孔，给背后约5mm凸出预留空间，才能完全推进。该打孔会对衣柜背板造成轻度不可逆改动，须事先确认。';
}

function buildDrawerCustomizationReplyFromKnowledge(text, context = '') {
  const source = stripMediaMarkers(String(text || '')).replace(/\s+/g, '');
  const contextSource = stripMediaMarkers(String(context || '')).replace(/\s+/g, '');
  let field = '';
  if (/(?:尺寸是多少|多大|多宽|多深|多高|规格)/.test(source) && /130H?分隔抽/.test(contextSource) && /600柜/.test(contextSource) && /无门/.test(contextSource)) {
    field = '130H分隔抽600柜无门尺寸';
  } else if (/内衣抽/.test(source) && /深度/.test(source) && /定制|做/.test(source)) {
    field = '内衣抽深度定制';
  } else if (/四代/.test(source) && /碗碟半抽/.test(source) && /互换|交换|调换|换.*位置|位置.*换/.test(source)) {
    field = '四代碗碟半抽位置互换';
  } else if (/停机坪/.test(source) && /尺寸|宽|深|高|定制/.test(source)) {
    field = '停机坪尺寸定制';
  } else if (/倾松抽/.test(source) && /定制|深度|改深|更改|改到|做深/.test(source)) {
    field = '倾松抽深度定制';
  } else if (/尚酷/.test(source) && /切角|U型|u型/.test(source)) {
    field = '尚酷切角抽';
  } else if (/130H?分隔抽/.test(source) && /600柜/.test(source) && /无门/.test(source)) {
    field = '130H分隔抽600柜无门';
  } else if (/鞋(?:抽|薄抽)/.test(source) && /(?:36\s*\*\s*2|36×2)/.test(source) && /柜内净宽|宽度/.test(source)) {
    field = '鞋抽宽度36×2';
  } else if (/之行阁/.test(source) && /横条|抽屉/.test(source) && /拆|清洁|清洗/.test(source)) {
    field = '之行阁横条/抽屉拆卸';
  }

  // 普通抽屉深度公式只能用于已明确为抽屉的问题；“柜深 + 铰链 + 这个”
  // 可能是任意产品的安装冲突，不能因出现“深度”就擅自套用抽屉轨道公式。
  const hasExplicitDrawerAnchor = /抽屉|魔法抽|尚酷(?:抽)?|碗碟(?:半)?抽|内衣抽|鞋(?:薄)?抽|谷物抽|调料抽|锅具抽|衣帽抽/.test(source);
  const depthMatch = hasExplicitDrawerAnchor
    ? source.match(/(?:抽屉)?深度(?:可以|能|能不能|能否)?(?:做|定制)?(?:到|成|为)?(\d{3,4})(?:mm|毫米)?/)
    : null;
  if (!field && depthMatch) {
    const depth = Number(depthMatch[1]);
    const rails = [250, 300, 350, 400, 450, 500, 550, 600, 650];
    const matchingRails = rails.filter(rail => {
      const offsetMin = rail === 550 || rail === 600 ? 15 : 5;
      const offsetMax = rail === 550 || rail === 600 ? 65 : 55;
      return depth >= rail + offsetMin && depth <= rail + offsetMax;
    });
    if (!matchingRails.length) {
      return `${depth}mm抽屉深度不能做。可用轨道中最短规格是250mm，按250+5mm计算，最小可做抽屉深度为255mm；${depth}mm不在任何轨道的可定制范围内。`;
    }
    return `${depth}mm抽屉深度可以做，可匹配${matchingRails.join('或')}mm轨道的定制范围；下单时需按对应轨道规格确认。`;
  }
  if (!field) return '';

  const candidates = [
    path.join(AI_PLANNER_SOURCE_DIR, '基础产品知识卡', '0292_抽屉产品_定制能力与轨道深度判断.md'),
    path.join(AI_PLANNER_SOURCE_DIR, '01_MD章节矩阵', '16-自动回复精准规则补充.md'),
    path.join(CURRENT_PRODUCT_KB_ROOT, '基础产品知识卡', '0292_抽屉产品_定制能力与轨道深度判断.md'),
    path.join(CURRENT_PRODUCT_KB_ROOT, '01_MD章节矩阵', '16-自动回复精准规则补充.md'),
  ];
  const knowledge = candidates.map(readExistingText).find(content => content.includes('# 抽屉产品定制能力与轨道深度判断') || content.includes('衣帽间抽屉深度定制总规则')) || '';
  const match = knowledge.match(new RegExp(`^- ${field}：(.+)$`, 'm'));
  if (match) return match[1].trim();

  const fallbackRules = {
    '内衣抽深度定制': /140H内衣抽支持深度定制[。；]?.*/,
    '四代碗碟半抽位置互换': /四代碗碟半抽支持定制[。；]?.*/,
    '停机坪尺寸定制': /停机坪为固定标准尺寸[。；]?.*/,
    '倾松抽深度定制': /倾松抽属于标品[。；]?.*/,
    '尚酷切角抽': /尚酷抽不支持切角抽定制[。；]?.*/,
    '130H分隔抽600柜无门': /130H分隔抽600柜无门：(.+)/,
    '130H分隔抽600柜无门尺寸': /130H分隔抽600柜无门尺寸：(.+)/,
    '鞋抽宽度36×2': /鞋抽属于衣帽抽体系[。；]?.*/,
    '之行阁横条/抽屉拆卸': /之行阁抽屉款底部使用可拆卸三节轨[。；]?.*/,
  };
  const fallback = fallbackRules[field];
  if (!fallback) return '';
  const fallbackMatch = knowledge.match(fallback);
  if (!fallbackMatch) return '';
  return String(fallbackMatch[1] || fallbackMatch[0]).trim();
}

function extractReplyEvidenceTokens(text) {
  const source = String(text || '');
  const tokens = new Set();
  const patterns = [
    /\b[A-Z]?\d{2,}(?:\.\d+)+(?:[A-Z])?\b/gi,
    /\b\d+(?:\.\d+)?\s*(?:mm|cm|kg|毫米|厘米|公斤|H)\b/gi,
    /\b\d{3,4}\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const token = match[0].replace(/\s+/g, '').toLowerCase();
      if (token) tokens.add(token);
    }
  }
  return [...tokens];
}

function validateReplyAgainstWiki(question, reply) {
  if (!CONFIG.llmWikiEnabled) return { valid: true, unsupported: [], pages: [] };
  const tokens = extractReplyEvidenceTokens(reply);
  if (!tokens.length) return { valid: true, unsupported: [], pages: [] };
  const pages = llmWiki.query(question, getProductKnowledgeRetrievalPolicy(question).options);
  const evidence = pages.map(page => `${page.content}\n${page.searchText || ''}`).join('\n').replace(/\s+/g, '').toLowerCase();
  const unsupported = tokens.filter(token => !evidence.includes(token));
  return { valid: unsupported.length === 0, unsupported, pages: pages.map(page => page.title) };
}

// ====== 发送回复 ======
function sendReply(cid, text) {
  return runDwsCommand(
    ['chat', 'message', 'send', '--group', cid, '--title', '回复', '--text', text],
    'DWS SEND'
  );
}

function sendDirectReply(msg, text) {
  const args = ['chat', 'message', 'send', '--title', '回复', '--text', text];

  if (msg.senderUserId) {
    args.splice(3, 0, '--user', msg.senderUserId);
  } else if (msg.senderOpenDingTalkId) {
    args.splice(3, 0, '--open-dingtalk-id', msg.senderOpenDingTalkId);
  } else {
    console.error('[DWS DIRECT SEND] 私信发送失败：缺少 userId / openDingTalkId');
    return null;
  }

  return runDwsCommand(args, 'DWS DIRECT SEND');
}

function handlePreparedRuleReply({ state, messageKey, msg, reply, queuePayload, reviewSource, send, history, historyUser }) {
  if (!reply) return false;
  reply = sanitizeReplyAddressees(reply, [msg?.sender]);

  if (CONFIG.pendingReviewMode) {
    queuePendingReply(state, messageKey, {
      ...queuePayload,
      reason: queuePayload.reason || '本地规则判断可回复；待Codex审核是否发送及重写最终话术。',
      deepseekSuggestion: reply,
      deepseekDecision: queuePayload.deepseekDecision || 'local_rule',
    });
    return true;
  }

  const now = Date.now();
  const lastReply = getConversationLastReply(state, queuePayload.targetType || 'group', queuePayload.conversationId);
  if (now - lastReply < CONFIG.rateLimitSec * 1000) {
    console.log(`  [限频] ${Math.round((now-lastReply)/1000)}秒前刚回复过，跳过 [${msg.sender || ''}]`);
    markCooldown(state, messageKey, CONFIG.rateLimitSec * 1000, 'deferred');
    return true;
  }

  console.log(`  本地规则回复 [${msg.sender || ''}]: ${reply.slice(0, 150)}`);

  if (CONFIG.semiAutoMode) {
    appendReviewQueue({
      source: reviewSource,
      title: queuePayload.title || '',
      sender: msg.sender || '',
      content: msg.content || '',
      reason: queuePayload.reason || '本地规则判断可以回复，但半自动模式不直接发送钉钉。',
      suggestion: reply,
    });
    markCooldown(state, messageKey, CONFIG.skipCooldownMs, 'deferred');
    saveState(state);
    console.log('  [半自动] 已记录本地规则建议回复，未发送钉钉');
    return true;
  }

  const sendResult = send();
  if (sendResult?.success) {
    maybeSendReferencedFiles(msg, reply);
    markReplied(state, messageKey);
    markConversationReply(state, queuePayload.targetType || 'group', queuePayload.conversationId);
    saveState(state);
    if (history && historyUser) {
      history.push({ user: historyUser.slice(0, 500), reply });
      saveHistory(history);
    }
    console.log(`  本地规则发送成功 ✓`);
  } else {
    markCooldown(state, messageKey, CONFIG.rateLimitSec * 1000, 'deferred');
    saveState(state);
    console.log(`  本地规则发送失败: ${JSON.stringify(sendResult)?.slice(0, 150)}`);
  }
  return true;
}

// ====== 格式化消息 ======
// 生成稳定消息 ID（openMessageId 在不同 API 中可能不一致）
function msgKey(msg) {
  const sender = msg.sender || msg.senderName || '';
  const time = msg.createTime || msg.createdAt || '';
  const content = typeof msg.content === 'string' ? msg.content : '';
  return (msg.openMessageId || msg.msgId || '') + '|' + sender.slice(0,10) + '|' + time + '|' + content.slice(0,30);
}

function fmtMsg(msg) {
  const sender = msg.sender || msg.senderName || '未知';
  const content = typeof msg.content === 'string'
    ? msg.content
    : (msg.content?.text || msg.text?.content || msg.text || '[非文本]');
  const time = msg.createTime || msg.createdAt || '';
  return {
    sender,
    content,
    time,
    id: msgKey(msg),
    senderOpenDingTalkId: msg.senderOpenDingTalkId || '',
    senderUserId: msg.senderStaffId || msg.senderUserId || msg.userId || '',
  };
}

function looksLikeProductQuestion(text) {
  const source = String(text || '').trim();
  if (!source) return false;
  if (looksLikeDesignOrImageRequiredQuestion(source)) return false;
  if (looksLikeProductExchangeAfterSalesQuestion(source)) return false;
  if (looksLikeAfterSalesInstallAbnormalQuestion(source)) return false;

  if (/新品|品类|类别|轨道|抽屉|拉篮|柜|安装|尺寸|材质|高度|宽度|深度|升降|升降机|云梯|云狐|云阁|云曦|中枢阁|翼枢阁|展翼阁|巧翼阁|旋翼阁|之行阁|炊宝阁|百纳阁|倾松抽|停机坪|挂门宝|小怪物|Mate2\.0|运行|停止|不动|故障|限位|感应|遇阻|防夹|分隔|门板|垫块|挂盒|魔法|尚酷|定制|连门|开门|系列|型号|配件|收纳|消毒柜|替换抽|图片|照片|图纸|孔位图|说明书|谷物盒|谷物抽|米箱|插碗架|洞洞板/i.test(source)) {
    return true;
  }

  const visualMatches = matchProductFromVisualKB(source);
  return Boolean(visualMatches?.[0]?.score >= 12);
}

// “这个/构件/安装在哪里”必须先在同一会话里定位到具体产品或型号。
// 抽中抽、抽屉、配件等只是结构大类，不能据此臆测某一个零件或安装视频。
function getSpecificProductAnchors(text) {
  const source = stripMediaMarkers(String(text || '')).replace(/\s+/g, '');
  const pattern = /魔法(?:空)?抽|尚酷(?:抽)?|云狐|云梯|云阁|云曦|中枢阁|翼枢阁|展翼阁|巧翼阁|旋翼阁|蝶翼阁|之行阁|炊宝阁|大嘴阁|百纳阁|挂门宝|停机坪|倾松抽|水槽侧拉|灵动衣架|易酷调料抽|谷物抽|碗碟(?:半)?抽|鞋(?:薄)?抽|内衣抽|(?:70H|130H|140H|180H)?(?:横向|纵向)?分隔抽|工具抽|锅具抽|衣帽抽|[A-Z]\d{2}\.\d{3}[A-Z]?/gi;
  return [...new Set((source.match(pattern) || []).map(item => item.toLowerCase()))];
}

function assessContextResolution(currentText, contextText = '', imageContext = '') {
  const current = stripMediaMarkers(String(currentText || '')).replace(/\s+/g, '');
  const combined = `${contextText || ''}\n${imageContext || ''}`;
  const referenceCue = /^(?:还有)?(?:这个|这款|该|此|那个|那款|图里(?:的)?|上面(?:的)?)|(?:这个|这款|该|此|那个|那款)(?:构件|配件|横条|有)?(?:是通用|能通用|有安装视频|安装视频|安装在哪|安装在哪里|怎么安装|能拆|可以拆|什么尺寸|什么材质|能定制|是标品)|^(?:安装在哪|安装在哪里|这个有安装视频吗?)/;
  const genericPartCue = /抽中抽.*(?:构件|配件)|(?:构件|配件|横条).*(?:通用|安装|视频|拆)|(?:安装在哪|安装在哪里)|安装视频/;
  const implicitProductCue = /(?:\d{3,4}柜|单开门|双开门|无门|柜内净宽|柜内深度|轨道|抽屉).*(?:可以吗|能不能|能否|定制|标品|尺寸|安装|适配)|(?:尺寸|深度|宽度|高度|材质).*(?:在哪里|多少|可以吗|能不能|能否|定制)/;
  const currentAnchors = getSpecificProductAnchors(current);
  const needsContext = (referenceCue.test(current) || genericPartCue.test(current) || implicitProductCue.test(current)) && currentAnchors.length === 0;
  if (!needsContext) return { needsContext: false, resolved: true, anchors: currentAnchors };

  const anchors = getSpecificProductAnchors(combined);
  return { needsContext: true, resolved: anchors.length === 1, anchors };
}

// “这个装不下/能否往后装”属于安装冲突描述，不是抽屉分类锚点。
// 只有柜深和铰链、却没有具体产品时，必须转人工；若上文已有具体产品，
// 则交给带上下文的产品知识检索，禁止在本地误套通用抽屉深度公式。
function needsProductConfirmationForCabinetDepthInstallation(currentText, contextText = '') {
  const current = stripMediaMarkers(String(currentText || '')).replace(/\s+/g, '');
  const combined = `${current}\n${contextText || ''}`;
  const hasCabinetDepth = /(?:柜内(?:净)?深|柜体(?:内)?深|柜深|深度)\d{3,4}/.test(current);
  const hasInstallationConflict = /平开门|铰链|装不下|往后装|往后安|能否后装|还能装/.test(current);
  if (!hasCabinetDepth || !hasInstallationConflict) return false;

  return getSpecificProductAnchors(combined).length === 0;
}

function looksLikeProductPlatformOperationQuestion(text) {
  const source = String(text || '').replace(/\s+/g, '');
  const platform = /Mate2\.0|Mate|设计软件|系统|后台|配置页面|产品库/i.test(source);
  const operation = /找不到|没有显示|只显示|怎么切换|如何切换|手动切换|在哪里选|不能选|选不了|无法选择|怎么配置|如何配置|上架|下架/.test(source);
  return platform && operation;
}

function hasExplicitDimensions(text) {
  const source = String(text || '');
  return /\d+\s*(mm|毫米|cm|厘米|m|米)/i.test(source) ||
    /(宽|深|高|净宽|净深|净高|柜宽|柜深|柜高|内宽|内深|内高|W|D|H)\s*[:：]?\s*\d{2,4}/i.test(source) ||
    /\d{2,4}\s*(宽|深|高|柜|柜体|净宽|净深|净高|内宽|内深|内高)/.test(source) ||
    /\b\d{3,4}\b\s*(柜|宽|深|高|尺寸)/.test(source) ||
    /(柜|宽|深|高|尺寸)\D{0,8}\d{2,4}/.test(source);
}

function looksLikeDesignOrImageRequiredQuestion(text) {
  const source = stripMediaMarkers(String(text || '')).trim();
  if (!source) return false;
  const target = /转角柜|转角|拐角|死角|柜体|柜子|橱柜|高柜|地柜|吊柜|空间|位置|调料拉篮|拉篮|抽屉|模块|盒子/.test(source);
  if (!target) return false;
  const solutionCue = /方案|解决办法|解决方案|有什么好的|怎么解决|如何解决|怎么放|怎么配/.test(source);
  const siteCue = /客户家|家里|现场|这两个位置|这个位置|那个位置|这些位置|这边|那边|图里|图中|看图/.test(source);
  if (solutionCue && siteCue) return true;
  if (hasExplicitDimensions(source)) return false;
  return /这两个位置|这个位置|那个位置|这些位置|这边|那边|这种|这个|现场|图片|照片|图里|图中|看图|空间|方案|解决办法|解决方案|有什么好的|怎么解决|如何解决|怎么放|怎么配|能不能装|能装吗|能不能安装|不能安装|可以安装吗|可不可以装|适不适合|很深|太深|死角|拐角/.test(source);
}

function shouldForceReviewOnSkip(text) {
  const source = String(text || '').trim();
  if (!source) return false;

  if (looksLikeDrawerWidthCalculationQuestion(source)) return true;
  if (!/[?？]/.test(source)) return false;

  const productTerms = /中枢阁|翼枢阁|挂门宝|展序阁|云梯|云狐|云阁|灵动衣架|尚酷|魔法抽|倾松抽|子母抽/;
  const dimensionTerms = /宽度|高度|深度|尺寸|净宽|柜宽|柜体|含轨道|算轨道|带轨道|是不是.*含|是否.*含/;

  return productTerms.test(source) && dimensionTerms.test(source);
}

function looksLikeCustomerServiceQuestion(text) {
  const source = text || '';
  return /订单|下单|发货|物流|快递|单号|售后|退款|退货|换货|退换|换新|调换|置换|补发|地址|收货|联系人|电话|开票|发票|对账|财务|赔付|投诉|审批|催单|加急|价格|报价|多少钱|费用|运费|折扣|打折|几折|优惠|活动|促销|(?:打)?[一二三四五六七八九十\d]+折/.test(source) ||
    looksLikeProductExchangeAfterSalesQuestion(source) ||
    looksLikeAfterSalesInstallAbnormalQuestion(source);
}

function isMediaMessage(text) {
  return /\[图片消息\]|\[语音消息\]|\[视频消息\]|\[文件消息\]|\[位置消息\]|mediaId=/.test(text || '');
}

function isVideoLikeMessage(text) {
  return /\[视频消息\]|\[视频\]|\[文件\][^\n]*(?:\.mp4|\.mov|\.m4v|\.avi)|fileName=[^\s\n]*(?:\.mp4|\.mov|\.m4v|\.avi)|\.(?:mp4|mov|m4v|avi)\b/i.test(text || '');
}

function hasAssociatedVideoContext(messages, targetMessage, windowMs = 2 * 60 * 1000) {
  const list = Array.isArray(messages) ? messages : [];
  const targetKey = messageKeyOf(targetMessage);
  const targetIndex = list.findIndex(m => m === targetMessage || messageKeyOf(m) === targetKey);
  if (targetIndex < 0) return isVideoLikeMessage(targetMessage?.content || '');

  const target = list[targetIndex] || {};
  if (isVideoLikeMessage(target.content || '')) return true;

  const targetTime = new Date(target.time || target.createTime || target.createdAt || '').getTime();
  const targetSender = target.sender || '';
  for (const offset of [-2, -1, 1, 2]) {
    const other = list[targetIndex + offset];
    if (!other || (other.sender || '') !== targetSender) continue;
    if (!isVideoLikeMessage(other.content || '')) continue;
    const otherTime = new Date(other.time || other.createTime || other.createdAt || '').getTime();
    if (!Number.isFinite(targetTime) || !Number.isFinite(otherTime) || Math.abs(targetTime - otherTime) <= windowMs) return true;
  }
  return false;
}

// 提取 mediaId 列表
function extractMediaIds(text) {
  const ids = [];
  const re = /mediaId=([@$])([^\s)\]）]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    ids.push(m[1] + m[2]);
  }
  return ids;
}

function firstNonEmptyValue(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

// 钉钉机器人回调的原图只能由 downloadCode + robotCode 获取。
// mediaId 是桌面端/历史导出中的展示标识，不能用来猜图或回退到缩略图。
function extractOriginalImageReferences(messageOrContent) {
  const message = messageOrContent && typeof messageOrContent === 'object'
    ? messageOrContent
    : { content: String(messageOrContent || '') };
  const raw = message.raw && typeof message.raw === 'object' ? message.raw : {};
  const contentObject = raw.content && typeof raw.content === 'object' ? raw.content : {};
  const messageObject = raw.message && typeof raw.message === 'object' ? raw.message : {};
  const content = typeof message.content === 'string' ? message.content : '';
  const codes = [
    message.downloadCode,
    message.pictureDownloadCode,
    raw.downloadCode,
    raw.pictureDownloadCode,
    contentObject.downloadCode,
    contentObject.pictureDownloadCode,
    messageObject.downloadCode,
    messageObject.pictureDownloadCode,
  ].flatMap(value => Array.isArray(value) ? value : [value])
    .filter(value => typeof value === 'string' && value.trim())
    .map(value => value.trim());
  const uniqueCodes = [...new Set(codes)];
  const robotCode = firstNonEmptyValue([
    message.robotCode,
    raw.robotCode,
    raw.chatbotCode,
    raw.chatbotUserId,
  ]);
  const mediaIds = extractMediaIds(content);
  const hasImageMarker = /\[图片消息\]|mediaId=/.test(content) || uniqueCodes.length > 0;
  return {
    content,
    mediaIds,
    downloadCodes: uniqueCodes,
    robotCode,
    hasImageMarker,
  };
}

// 去掉 [图片消息](mediaId=...) 标记及钉钉附加的下载提示，保留纯文本
function stripMediaMarkers(text) {
  return (text || '')
    .replace(/\[图片消息\]\(mediaId=[^)]+\)/g, '')
    .replace(/注意：如需下载使用dws chat message download-media命令下载，请使用@开头的mediaId/g, '')
    .replace(/注意：如需下载使用dws chat message download-media命令下载，请使用\$开头的mediaId/g, '')
    .trim();
}

// ====== 图片识别：DingTalk 本地缓存 + Doubao Vision ======
const os = require('os');
const DOUBAO_CONFIG_PATH = path.join(os.homedir(), '.claude', 'doubao-vision-config.json');
let visionConfigWarned = false;

function boolFromEnv(value, defaultValue = true) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return !/^(false|0|no|off)$/i.test(String(value).trim());
}

function normalizeVisionBaseUrl(baseUrl) {
  return String(baseUrl || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, '');
}

function loadDoubaoVisionConfig() {
  const envConfig = {
    enabled: boolFromEnv(process.env.ENABLE_VISION_RECOGNITION ?? process.env.DOUBAO_VISION_ENABLED, true),
    apiKey: process.env.DOUBAO_VISION_API_KEY || process.env.ARK_API_KEY || process.env.VOLCENGINE_API_KEY || '',
    baseUrl: normalizeVisionBaseUrl(process.env.DOUBAO_VISION_BASE_URL || process.env.ARK_BASE_URL),
    model: process.env.DOUBAO_VISION_MODEL || process.env.ARK_VISION_MODEL || '',
    maxTokens: parseInt(process.env.DOUBAO_VISION_MAX_TOKENS || '800', 10),
    timeoutMs: parseInt(process.env.DOUBAO_VISION_TIMEOUT_SEC || '60', 10) * 1000,
  };
  if (envConfig.apiKey || envConfig.model || process.env.DOUBAO_VISION_BASE_URL || process.env.ARK_BASE_URL) {
    envConfig.model = envConfig.model || 'doubao-seed-1-6-vision-250815';
    return envConfig;
  }

  try {
    const legacy = JSON.parse(fs.readFileSync(DOUBAO_CONFIG_PATH, 'utf-8'));
    return {
      enabled: legacy.enabled !== false,
      apiKey: legacy.apiKey || legacy.api_key || '',
      baseUrl: normalizeVisionBaseUrl(legacy.baseUrl || legacy.base_url),
      model: legacy.model || 'doubao-seed-1-6-vision-250815',
      maxTokens: parseInt(legacy.maxTokens || legacy.max_tokens || '800', 10),
      timeoutMs: parseInt(legacy.timeoutSec || legacy.timeout_sec || '60', 10) * 1000,
    };
  } catch {
    return null;
  }
}

const DOUBAO_CONFIG = loadDoubaoVisionConfig();

function isDoubaoVisionReady() {
  return !!(DOUBAO_CONFIG && DOUBAO_CONFIG.enabled !== false && DOUBAO_CONFIG.apiKey && DOUBAO_CONFIG.model && DOUBAO_CONFIG.baseUrl);
}

// 查找 DingTalk 缓存的图片文件（按时间匹配，mediaId 和缓存文件名不同）
function findCachedImage(mediaId, msgTime) {
  try {
    const dtDir = path.join(os.homedir(), 'AppData/Roaming/DingTalk');
    const profiles = fs.readdirSync(dtDir).filter(d => /^\d{2,}/.test(d) && fs.statSync(path.join(dtDir, d)).isDirectory());
    // 用消息时间作为窗口中心
    const msgTs = msgTime ? new Date(msgTime).getTime() : Date.now();
    const windowStart = msgTs - 2 * 60 * 1000;  // 消息前2分钟
    const windowEnd = msgTs + 3 * 60 * 1000;    // 消息后3分钟

    for (const profile of profiles) {
      const imgDir = path.join(dtDir, profile, 'ImageFiles');
      if (!fs.existsSync(imgDir)) continue;
      const subdirs = fs.readdirSync(imgDir).filter(d => {
        const p = path.join(imgDir, d);
        return fs.statSync(p).isDirectory();
      });
      for (const sd of subdirs) {
        const sdPath = path.join(imgDir, sd);
        let files;
        try { files = fs.readdirSync(sdPath); } catch { continue; }
        for (const f of files) {
          if (!/\.(webp|png|jpg|jpeg)$/i.test(f)) continue;
          const fp = path.join(sdPath, f);
          const mtime = fs.statSync(fp).mtimeMs;
          if (mtime >= windowStart && mtime <= windowEnd) {
            return fp;
          }
        }
      }
    }
  } catch (e) {}
  return null;
}

// 调用 Doubao Vision API 识别图片
function recognizeImage(imagePath) {
  return new Promise((resolve) => {
    if (!isDoubaoVisionReady()) {
      if (!visionConfigWarned) {
        console.log('[图片识别] 未启用：缺少 Doubao/Ark 视觉模型配置或已关闭 ENABLE_VISION_RECOGNITION。');
        visionConfigWarned = true;
      }
      resolve(null);
      return;
    }
    try {
      const buffer = fs.readFileSync(imagePath);
      if (buffer.length < 100) { resolve(null); return; }
      const base64 = buffer.toString('base64');
      let mimeType = 'image/webp';
      if (buffer[0] === 0xFF && buffer[1] === 0xD8) mimeType = 'image/jpeg';
      else if (buffer[0] === 0x89 && buffer[1] === 0x50) mimeType = 'image/png';
      else if (buffer[0] === 0x47 && buffer[1] === 0x49) mimeType = 'image/gif';

      const body = JSON.stringify({
        model: DOUBAO_CONFIG.model,
        messages: [{ role: 'user', content: [
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
          { type: 'text', text: '请详细描述这张图片中的所有内容。如果是产品相关图片（抽屉、拉篮、柜体、订单、尺寸表等），请尽可能详细地提取所有文字、数字、型号、尺寸信息。如果只是普通照片，简要描述画面内容即可。' },
        ]}],
        max_tokens: DOUBAO_CONFIG.maxTokens || 800,
      });

      const u = new (require('url').URL)(DOUBAO_CONFIG.baseUrl + '/chat/completions');
      const req = https.request({
        hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DOUBAO_CONFIG.apiKey}` },
        timeout: DOUBAO_CONFIG.timeoutMs || 60000,
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(d); } catch {}
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const err = parsed?.error || {};
            console.log(`[图片识别] Doubao API 失败 status=${res.statusCode} code=${err.code || ''} message=${err.message || String(d).slice(0, 160)}`);
            resolve(null);
            return;
          }
          resolve(parsed?.choices?.[0]?.message?.content?.trim() || null);
        });
      });
      req.on('timeout', () => req.destroy(new Error('vision request timeout')));
      req.on('error', (e) => {
        console.log(`[图片识别] Doubao 请求失败: ${e.message}`);
        resolve(null);
      });
      req.write(body);
      req.end();
    } catch (e) {
      console.log(`[图片识别] 本地处理失败: ${e.message}`);
      resolve(null);
    }
  });
}

// 处理消息中的图片：只下载钉钉原图并识别。
// 禁止用本地缓存、缩略图或按时间匹配到的文件代替原图。
async function processMessageImages(messageOrContent, msgTime) {
  const refs = extractOriginalImageReferences(messageOrContent);
  const { content: msgContent, mediaIds, downloadCodes, robotCode, hasImageMarker } = refs;
  if (!hasImageMarker) {
    return {
      recognizedTexts: [],
      remainingContent: msgContent,
      hadMedia: false,
      originalMediaReady: true,
      originalMediaFailures: [],
      recognitionFailures: [],
    };
  }
  if (!downloadCodes.length) {
    return {
      recognizedTexts: [],
      remainingContent: stripMediaMarkers(msgContent),
      hadMedia: true,
      originalMediaReady: false,
      originalMediaFailures: ['图片消息未携带钉钉原图下载码，禁止使用缩略图、缓存或历史媒体标识猜测'],
      recognitionFailures: [],
    };
  }

  const recognized = [];
  const originalMediaFailures = [];
  const recognitionFailures = [];
  for (const [index, downloadCode] of downloadCodes.entries()) {
    try {
      const original = await downloadOriginalMedia({
        downloadCode,
        robotCode,
        mediaId: mediaIds[index] || '',
      });
      console.log(`  [图片识别] 已下载钉钉原图 #${index + 1} (${Math.round(original.buffer.length / 1024)}KB)`);
      const result = await recognizeOriginalImage(original.buffer);
      if (result) {
        console.log(`  [图片识别] 原图识别结果: ${result.slice(0, 100)}...`);
        // 匹配图文知识库
        if (visualKnowledgeBase) {
          const matches = matchProductFromVisualKB(result);
          if (matches.length > 0) {
            const top = matches[0];
            const productInfo = [
              `匹配产品: ${top.product.name}`,
              `系列: ${top.product.series || '未知'}`,
              `结构类型: ${top.product.structuralType || '未知'}`,
              `结构特点: ${top.product.tableFields?.['结构特点'] || '无'}`,
              `规格: ${top.product.tableFields?.['高度'] ? '高度' + top.product.tableFields['高度'] : ''}${top.product.tableFields?.['SKU 参考'] && top.product.tableFields['SKU 参考'] !== '—' ? ' / SKU: ' + top.product.tableFields['SKU 参考'] : ''}`,
              top.score >= 20 ? `(置信度: 高)` : top.score >= 10 ? `(置信度: 中)` : `(置信度: 低)`,
            ].filter(Boolean).join(' / ');
            console.log(`  [产品匹配] ${productInfo}`);
            recognized.push(`[图片识别+产品匹配]\n${result}\n${productInfo}${matches.length > 1 ? '\n其他可能: ' + matches.slice(1).map(m => m.product.name).join(', ') : ''}`);
            continue;
          }
        }
        recognized.push(result);
      } else {
        recognitionFailures.push(`原图 #${index + 1}：视觉识别未返回结果`);
      }
    } catch (e) {
      const reason = e?.message || '未知下载错误';
      originalMediaFailures.push(`原图 #${index + 1}：${reason}`);
      console.log(`  [图片识别] 原图下载失败 #${index + 1}: ${reason}`);
    }
  }

  const remainingContent = stripMediaMarkers(msgContent);
  return {
    recognizedTexts: recognized,
    remainingContent,
    hadMedia: true,
    originalMediaReady: originalMediaFailures.length === 0,
    originalMediaFailures,
    recognitionFailures,
  };
}

function looksLikeShortContextQuestion(text) {
  const plain = stripMediaMarkers(String(text || ''))
    .replace(/\[图片识别结果\][\s\S]*/g, '')
    .replace(/\[上文图片识别结果\][\s\S]*/g, '')
    .trim();
  const compact = plain.replace(/[^\p{Script=Han}\p{Letter}\p{Number}]+/gu, '');
  return compact.length <= 80 && /(能否|能不能|可不可以|可以吗|能装|能安装|连门安装|安装吗|行吗|这个|这种|这款|这里|然后|不影响|对吗|对吧|会发|配件|挂钩|组合|细节尺寸|在哪里|哪里看|付款|支付|下单|页面|截图|图片|图里|上面|刚才)/.test(plain);
}

function messageTimeOf(msg) {
  return msg?.time || msg?.createTime || msg?.createdAt || '';
}

function messageKeyOf(msg) {
  return msg?.id || msgKey(msg || {});
}

async function buildPriorImageContextForShortQuestion(messages, targetMessage, limit = 5) {
  if (!looksLikeShortContextQuestion(targetMessage?.content || '')) {
    return { text: '', hasPriorImage: false, originalMediaReady: true, recognitionReady: true };
  }
  const recognized = [];
  let hasPriorImage = false;
  const originalMediaFailures = [];
  const recognitionFailures = [];
  const prior = selectRecentContextMessages(messages, targetMessage, limit + 1).slice(0, -1);
  for (const msg of prior) {
    const content = msg?.content || '';
    if (!/\[图片消息\]|mediaId=/.test(content)) continue;
    hasPriorImage = true;
    try {
      const result = await processMessageImages(msg, messageTimeOf(msg));
      if (!result.originalMediaReady) {
        originalMediaFailures.push(...result.originalMediaFailures);
        continue;
      }
      if (result.recognitionFailures.length) recognitionFailures.push(...result.recognitionFailures);
      if (result.recognizedTexts.length > 0) {
        recognized.push(`[上文图片 ${messageTimeOf(msg)} ${msg.sender || ''}]\n${result.recognizedTexts.join('\n---\n')}`);
      }
    } catch (e) {
      originalMediaFailures.push(e?.message || '上文原图处理失败');
    }
  }
  return {
    text: recognized.join('\n---\n'),
    hasPriorImage,
    originalMediaReady: originalMediaFailures.length === 0,
    recognitionReady: recognitionFailures.length === 0 && (!hasPriorImage || recognized.length > 0),
    originalMediaFailures,
    recognitionFailures,
  };
}

function isTrivialReply(text) {
  const source = (text || '').trim();
  if (/^注意：如需下载使用dws chat message download-media命令下载/.test(source)) return true;
  return /^(好的|收到|谢谢|OK|ok|嗯嗯|收到啦|知道了|是的|对|好)\s*[!！。.]?$/.test(source);
}

function buildBusinessGreetingReply(text) {
  const source = stripMediaMarkers(String(text || '')).trim();
  if (!source || source.length > 32) return '';
  const normalized = source.replace(/[\s，,。.!！?？、~～]/g, '');
  if (!/^(你好|你好呀|您好|您好呀|嗨|嗨呀|哈喽|hello|hi|早上好|上午好|中午好|下午好|晚上好|在吗)$/i.test(normalized)) {
    return '';
  }
  return '你好，我可以帮你解答酷太产品的尺寸、安装、适配、材质等问题，并发送相关产品或安装示意图。请直接告诉我产品名称和需要了解的问题。';
}

function isDirectConversationAllowed(title, msg) {
  const text = (msg.content || '').trim();
  const sender = msg.sender || '';
  const blockedTitles = ['钉钉文档自动化助手', '艺想'];
  if (blockedTitles.some(name => (title || '').includes(name))) return false;
  if (/助手|机器人|自动化|直播数据/.test(title || '')) return false;
  if (/助手|机器人|自动化/.test(sender)) return false;
  if (isVideoLikeMessage(text)) return false;
  const plainText = isMediaMessage(text) ? stripMediaMarkers(text) : text;
  if (looksLikeDesignOrImageRequiredQuestion(plainText)) return false;
  // 图片消息：有文字+图片 → 允许；纯图片 → 允许（等识别）
  if (isMediaMessage(text)) {
    const stripped = stripMediaMarkers(text);
    if (stripped.length >= 8) {
      if (looksLikeDesignOrImageRequiredQuestion(stripped)) return false;
      msg._originalContentWithMedia = text;
      msg.content = stripped;
      msg._hadImage = true;
      return true;
    }
    // 纯图片也放行
    msg._pureImage = true;
    return true;
  }
  if (shouldBlock(text) && !looksLikeCustomerServiceQuestion(text)) return false;
  if (!looksLikeProductQuestion(text) && !looksLikeCustomerServiceQuestion(text)) return false;
  return true;
}

let drawerWidthFormulaCache = null;

function looksLikeDrawerWidthCalculationQuestion(text, context = '') {
  const current = stripMediaMarkers(String(text || '')).replace(/\s+/g, '');
  const source = stripMediaMarkers(`${context || ''}\n${text || ''}`).replace(/\s+/g, '');
  if (!source || /尚酷|内部可用宽|内部净宽|抽屉内宽|模块宽|配件宽/.test(source)) return false;
  const hasCabinetWidth = /(?:柜宽|柜体宽|柜子宽|宽度)\D{0,8}\d{3,4}|\d{3,4}(?:mm)?柜|\d{3,4}\D{0,8}(?:柜宽|柜体宽|柜子宽)/.test(source);
  const asksDrawerWidth = /抽屉.{0,10}(?:多宽|宽度|定制宽|做多宽|下单宽)|(?:多宽|定制宽度|定制尺寸|做多宽).{0,8}抽屉/.test(source);
  const resolvedMagicDrawerFollowUp = /(?:魔法抽|魔法空抽)/.test(source) && /(?:单开门|双开门|连门)/.test(source) && /定制|范畴|尺寸|标准|标品|有没有|没有|要定制|可以吗/.test(current);
  return hasCabinetWidth && (asksDrawerWidth || resolvedMagicDrawerFollowUp);
}

function loadDrawerWidthFormulaFromKnowledge() {
  if (drawerWidthFormulaCache) return drawerWidthFormulaCache;
  const candidates = [
    // 当前 Obsidian 矩阵：产品结构/尺寸事实的唯一优先来源。
    path.join(CURRENT_PRODUCT_KB_ROOT, '01_MD章节矩阵', '10-尺寸体系与安装.md'),
    path.join(AI_PLANNER_SOURCE_DIR, '01_MD章节矩阵', '10-尺寸体系与安装.md'),
    path.join(CURRENT_PRODUCT_KB_ROOT, '_Dify上传合集', '06_尺寸安装与极限安装.md'),
    path.join(CURRENT_PRODUCT_KB_ROOT, '06_尺寸安装与极限安装.md'),
    path.join(AI_PLANNER_SOURCE_DIR, '_Dify上传合集', '06_尺寸安装与极限安装.md'),
    path.join(AI_PLANNER_SOURCE_DIR, '06_尺寸安装与极限安装.md'),
  ];
  for (const file of candidates) {
    const text = readExistingText(file);
    if (!text) continue;
    const formulas = {};
    for (const type of ['连门', '双开门', '单开门']) {
      const escaped = type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = text.match(new RegExp(`\\|\\s*${escaped}\\s*\\|[^\\n]*\\|\\s*W\\s*-\\s*(\\d+(?:\\.\\d+)?)mm\\s*\\|`));
      if (match) formulas[type] = Number(match[1]);

      // Obsidian 当前矩阵以“800 - 18×2 - …”保存公式，不再使用旧 Dify 的 “W - 扣尺” 格式。
      // 这里仅解析知识卡中的算式为扣尺；具体数值仍完全由产品知识卡维护。
      if (!formulas[type]) {
        const row = text.match(new RegExp(`^\\|\\s*魔法抽\\s*\\|\\s*${escaped}\\s*\\|\\s*([^|]+?)\\s*\\|`, 'm'));
        if (row) {
          const terms = [...row[1].matchAll(/-\s*(\d+(?:\.\d+)?)(?:\s*[×x*]\s*(\d+(?:\.\d+)?))?/g)];
          const deduction = terms.reduce((total, term) => total + Number(term[1]) * Number(term[2] || 1), 0);
          if (deduction > 0) formulas[type] = deduction;
        }
      }
    }
    if (formulas['连门'] && formulas['双开门'] && formulas['单开门']) {
      drawerWidthFormulaCache = { file, formulas };
      return drawerWidthFormulaCache;
    }
  }
  return null;
}

function extractCabinetWidth(text) {
  const source = String(text || '').replace(/\s+/g, '');
  const before = source.match(/(?:柜宽|柜体宽|柜子宽|宽度)\D{0,8}(\d{3,4})/);
  if (before) return Number(before[1]);
  const labeledCabinet = source.match(/(\d{3,4})(?:mm)?柜/);
  if (labeledCabinet) return Number(labeledCabinet[1]);
  const after = source.match(/(\d{3,4})\D{0,8}(?:柜宽|柜体宽|柜子宽)/);
  return after ? Number(after[1]) : 0;
}

function buildDrawerWidthRuleReply(text, context = '') {
  if (!looksLikeDrawerWidthCalculationQuestion(text, context)) return '';
  const combined = `${context || ''}\n${text || ''}`;
  const width = extractCabinetWidth(combined);
  const knowledge = loadDrawerWidthFormulaFromKnowledge();
  if (!width || !knowledge) return '';

  const result = type => Math.round((width - knowledge.formulas[type]) * 10) / 10;
  if (Math.min(result('连门'), result('单开门'), result('双开门')) <= 0) return '';

  const source = String(combined || '').replace(/\s+/g, '');
  if (/连门式|连门款|连门安装|连门/.test(source)) {
    return `如果按魔法抽连门式计算，${width}mm 柜宽对应抽屉定制外宽 ${result('连门')}mm。`;
  }
  if (/双开门|双开/.test(source)) {
    return `如果按魔法抽双开门计算，${width}mm 柜宽对应抽屉定制外宽 ${result('双开门')}mm。`;
  }
  if (/单开门|单开/.test(source)) {
    return `魔法抽${width}柜单开门按现有宽度公式计算：${width}-18×2（两侧柜板）-11×2（两侧轨道间隙）-25（单边避铰链轨道垫块）=${result('单开门')}mm，因此抽屉定制外宽为${result('单开门')}mm。${width >= 600 ? `${width}柜单开门没有标品，需要走定制。` : ''}`;
  }
  if (/开门式|开门款|开门安装|开门/.test(source)) {
    return `如果按魔法抽计算，${width}mm 柜宽对应单开门 ${result('单开门')}mm、双开门 ${result('双开门')}mm。需要再确认是单开门还是双开门；尚酷抽扣尺不同，也需要另行确认系列。`;
  }
  return `如果按魔法抽计算，${width}mm 柜宽对应连门 ${result('连门')}mm、单开门 ${result('单开门')}mm、双开门 ${result('双开门')}mm。具体下单宽度要看连门还是开门；如果是尚酷抽，扣尺不同，需要再确认产品系列和门型。`;
}

function installationKnowledgeCandidates() {
  return [
    path.join(CURRENT_PRODUCT_KB_ROOT, '_Dify上传合集', '06_尺寸安装与极限安装.md'),
    path.join(CURRENT_PRODUCT_KB_ROOT, '06_尺寸安装与极限安装.md'),
    path.join(AI_PLANNER_SOURCE_DIR, '_Dify上传合集', '06_尺寸安装与极限安装.md'),
    path.join(AI_PLANNER_SOURCE_DIR, '06_尺寸安装与极限安装.md'),
  ];
}

function looksLikeDirectInstallationDimensionLookup(text) {
  const source = stripMediaMarkers(String(text || '')).replace(/\s+/g, '');
  return /(安装尺寸|极限安装尺寸|极限尺寸|安装宽度|安装深度|安装高度|产品尺寸)/.test(source);
}

function buildInstallationDimensionsReplyFromKnowledge(text) {
  if (!looksLikeDirectInstallationDimensionLookup(text)) return '';
  const imagePaths = findInstallationReferenceImages(text, '', '', 3);
  if (imagePaths.length !== 1) return '';
  const imageName = path.basename(imagePaths[0]);
  const escapedName = imageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  for (const file of installationKnowledgeCandidates()) {
    const knowledge = readExistingText(file);
    if (!knowledge) continue;
    const imageMatch = new RegExp(`!\\[[^\\]]*\\]\\([^\\n)]*${escapedName}\\)`).exec(knowledge);
    if (!imageMatch) continue;

    const before = knowledge.slice(Math.max(0, imageMatch.index - 600), imageMatch.index);
    const titles = [...before.matchAll(/^###\s+(.+)$/gm)];
    const title = String(titles.at(-1)?.[1] || path.parse(imageName).name).trim();
    const tail = knowledge.slice(imageMatch.index + imageMatch[0].length);
    const endIndex = tail.search(/\n## 自动回复边界/);
    const section = endIndex >= 0 ? tail.slice(0, endIndex) : tail.slice(0, 3000);
    const rows = [];
    for (const match of section.matchAll(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/gm)) {
      const group = match[1].trim();
      const parameter = match[2].trim();
      const value = match[3].trim();
      if (/^(分组|-+)$/.test(group) || /^(参数|-+)$/.test(parameter) || /^-+$/.test(value)) continue;
      rows.push({ group, parameter, value });
    }
    if (!rows.length) continue;

    const lines = [`${title}尺寸如下：`];
    let currentGroup = '';
    for (const row of rows) {
      if (row.group !== currentGroup) {
        currentGroup = row.group;
        lines.push(`${currentGroup}：`);
      }
      lines.push(`${row.parameter}：${row.value}`);
    }
    lines.push('对应安装尺寸示意图也一起发你。');
    return lines.join('\n');
  }
  return '';
}

function spiceDrawerInstallationKnowledgeCandidates() {
  const fileName = '0079_尺寸与安装_安装要求.md';
  return [
    path.join(AI_PLANNER_SOURCE_DIR, '基础产品知识卡', fileName),
    path.join(CURRENT_PRODUCT_KB_ROOT, '基础产品知识卡', fileName),
  ];
}

function buildSpiceDrawerInstallationReplyFromKnowledge(text) {
  const source = stripMediaMarkers(String(text || '')).replace(/\s+/g, '');
  if (!/调料整抽/.test(source) || !/(多高.*(?:柜|装)|柜.*多高|柜内.*(?:高|净高)|净高|安装.*高|能装|可以装|装得下)/.test(source)) {
    return '';
  }

  for (const file of spiceDrawerInstallationKnowledgeCandidates()) {
    const knowledge = readExistingText(file);
    if (!knowledge) continue;
    const height = knowledge.match(/^\|\s*柜内净高\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/m);
    const depth = knowledge.match(/^\|\s*柜内净深\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/m);
    if (!height) continue;

    const lines = [
      `550H 调料整抽的柜内净高至少要 ${height[1].trim()}（${height[2].trim()}）。`,
    ];
    if (depth) lines.push(`柜内净深至少要 ${depth[1].trim()}（${depth[2].trim()}）。`);
    lines.push('还需要结合柜内净宽和连门/开门方式确认对应规格；300 柜规格仅支持连门式。');
    return lines.join('\n');
  }
  return '';
}

function buildKnownInstallationCardReplyFromKnowledge(text) {
  const source = stripMediaMarkers(String(text || '')).replace(/\s+|的/g, '');
  const rules = [
    { terms: ['翼枢阁7层', '翼枢阁七层'], file: '0278_极限安装_翼枢阁7层.md' },
    { terms: ['中枢阁水槽款', '水槽中枢阁', '水槽侧拉'], file: '0267_极限安装_中枢阁水槽款（水槽侧拉_水槽侧拉架_水槽中枢阁_中枢阁（水槽款）_中枢阁2层水槽侧拉架）.md' },
  ];
  const rule = rules.find(item => item.terms.some(term => source.includes(term)));
  if (!rule || !/(安装|尺寸|多高|柜|能装|可以装|极限|宽|深|高)/.test(source)) return '';
  const files = [
    path.join(AI_PLANNER_SOURCE_DIR, '基础产品知识卡', rule.file),
    path.join(CURRENT_PRODUCT_KB_ROOT, '基础产品知识卡', rule.file),
  ];
  const knowledge = files.map(readExistingText).find(Boolean);
  if (!knowledge) return '';
  const title = (knowledge.match(/^#\s+(.+)$/m) || [])[1] || rule.terms[0];
  const rows = [...knowledge.matchAll(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/gm)]
    .map(match => ({ group: match[1].trim(), parameter: match[2].trim(), value: match[3].trim() }))
    .filter(row => row.group !== '分组' && row.parameter !== '参数' && !/^[-—]+$/.test(row.group));
  if (!rows.length) return '';
  const lines = [`${title}安装尺寸如下：`];
  for (const row of rows) lines.push(`${row.parameter}：${row.value}`);
  if (/中枢阁水槽款/.test(title)) lines.push('该款不支持连门安装。');
  lines.push('对应安装尺寸示意图也一起发你。');
  return lines.join('\n');
}

function buildRailSpecificationReplyFromKnowledge(text) {
  if (!looksLikeRailSpecificationQuestion(text)) return '';
  const file = path.join(AI_PLANNER_SOURCE_DIR, '基础产品知识卡', '0235_尺寸与安装_轨道角码与抽屉深度定制范围.md');
  const knowledge = readExistingText(file);
  const row = knowledge.match(/^\|\s*Quadro YOU\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/m);
  if (!row || !/(^|、)250(?:、|$)/.test(row[1])) return '';
  return `有，250mm 是 ${'Quadro YOU'} 的标准轨道规格之一（${row[1].trim()}）。`;
}

function replyDeniesAvailableInstallationInfo(question, reply) {
  if (!looksLikeInstallationRelatedQuestion(question)) return false;
  const denial = /(目前|暂时|现在)?没有.{0,12}(安装|尺寸|资料|信息|数据)|暂无.{0,12}(安装|尺寸|资料|信息|数据)|未找到.{0,12}(安装|尺寸|资料|信息|数据)|查阅产品说明书|联系官方客服确认/.test(String(reply || ''));
  if (!denial) return false;
  return findInstallationReferenceImages(question, '', reply, 3).length > 0;
}

function buildClarifyReply(text, context = '') {
  if (/(支持图片吗|可以发图片吗|能看图片吗|图片支持吗|图片可以吗)/.test(text)) {
    if (/新品|上架|哪一款|灵动衣架|云曦|云阁|展序阁|万象阁/.test(context)) {
      return '我理解一下，你这边是想看刚才提到的这次新品图片，对吗？我先跟你确认一下具体需求：你是想看这次新品的整套图片，还是想先看其中某一款？目前提到的有灵动衣架、云曦、云阁、展序阁、万象阁。你告诉我想看哪一款，我再按产品给你对应。';
    }
    return '支持图片的。产品图片、产品截图可以发；如果是安装现场、空间方案或能不能装这类问题，需要同时带上柜体尺寸、开门方向、深度高度等关键条件。只凭现场图信息不够时，不会直接下结论，会先让人工确认或补充信息。';
  }
  if (/消毒柜/.test(text) && /怎么改|如何改|咋改|改什么/.test(text)) {
    return '如果是把老旧消毒柜位改成收纳抽，目前按消毒柜替换抽来做。现有常见应用主要有3种：消毒柜碗碟抽半抽（230H）、消毒柜竖插锅具抽（230H）、消毒柜西餐碗碟抽（230H）。先看这个位置改完后主要想放什么：放碗碟，可看碗碟抽半抽或西餐碗碟抽；放锅具，可看竖插锅具抽。你把想放的物品类型、柜体宽度、还有连门/开门方式发我，我再帮你对应更具体的款式。';
  }
  if (/云梯|升降机/.test(text) && /运行|停止|不动|卡住|故障|下降|上升|限位/.test(text)) {
    return '云梯运行过程中停止不动，通常先按这几项排查：一是看底板下方或上表面有没有碰到异物，云梯有遇阻即停和防夹逻辑，碰到东西会自动停；二是看柜内背板、灯带、插座或层板有没有干涉运行轨迹；三是确认安装时背板左右是否各预留 1-2cm、感应线有没有漏接；四是到货安装后需要重新设置上下限位，限位没设好也可能运行到一半停住。以上都排除后，建议让门店拍一段完整运行视频给技术判断。';
  }
  return null;
}

// ====== 处理单个群 ======
async function processGroup(conv, state) {
  const cid = conv.openConversationId;
  const title = conv.title || '未命名群';

  if (state.groupConfig?.[cid]?.disabled) return null;
  if (isDwsAuthGroupBlocked(state, cid, title)) return null;

  // 屏蔽指定群
  const BLOCK_TITLES = ['钉钉文档自动化助手', '工作通知', '酷佳数字科技', 'GC-酷太&悟空沟通', '【集团】江苏酷太全员群', '上饶酷太', '【酷太服务商】总群'];
  if (BLOCK_TITLES.some(t => title.includes(t))) return null;

  const today = new Date().toISOString().slice(0, 10);
  const msgsResult = dws(`chat message list --group "${cid}" --time "${today} 00:00:00" --limit 20`);
  if (!msgsResult && isDwsAuthorizationPromptError(lastDwsErrorText)) {
    pauseDwsScan(state, 'group', lastDwsErrorText);
    blockDwsAuthGroup(state, cid, title, lastDwsErrorText);
    return null;
  }
  const messages = msgsResult?.result?.messages || [];
  if (!messages.length) return null;

  // 格式化并过滤
  const formatted = messages.map(fmtMsg).reverse(); // 正序（时间从早到晚）

  // 过滤已回复、自己发的
  let unhandled = formatted.filter(m => {
    if (!m.id) return false;
    const record = getMessageRecord(state, m.id);
    if (record) {
      if (record.status === 'replied') {
        console.log(`  [重复] 跳过已回复消息: ${m.sender}: ${m.content.slice(0, 40)}`);
        return false;
      }

      if (record.status === 'queued') {
        console.log(`  [重复] 跳过已入待回复队列消息: ${m.sender}: ${m.content.slice(0, 40)}`);
        return false;
      }

      if ((record.status === 'skipped' || record.status === 'deferred') && record.expiresAt > Date.now()) {
        return false;
      }

      delete state.repliedMsgs[m.id];
    }
    if (CONFIG.skipSelf && currentUserName && m.sender.includes(currentUserName)) return false;
    // 默认不再按员工/HQ名单过滤；只有显式打开 FILTER_* 开关时才跳过人员。
    if (CONFIG.filterEmployeeSenders && isEmployeeSender(m.sender, m.senderUserId)) return false;
    if (CONFIG.filterHQSenders && CONFIG.skipSenders.length && CONFIG.skipSenders.some(name => m.sender.includes(name))) {
      // 例外：总部人员 @我 的消息仍需回复
      if (!currentUserName) return false;
      const atMe = new RegExp(`@${currentUserName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\(（]`);
      if (!atMe.test(m.content)) return false;
    }
    // 跳过只有 @ 的纯提及消息
    const pureAt = /^@[一-龥\w()（）]+[\s]*$/.test(m.content.trim());
    if (pureAt) return false;
    if (hasAssociatedVideoContext(formatted, m)) {
      console.log(`  [跳过] 视频关联问题: ${m.sender}: ${m.content.slice(0, 60)}`);
      markCooldown(state, m.id, CONFIG.skipCooldownMs, 'skipped');
      return false;
    }
    if (looksLikeAfterSalesInstallAbnormalQuestion(m.content, buildReviewContext(formatted, m))) {
      console.log(`  [跳过] 售后/现场安装异常类问题: ${m.sender}: ${m.content.slice(0, 60)}`);
      markCooldown(state, m.id, CONFIG.skipCooldownMs, 'skipped');
      return false;
    }
    // AI 前关键词过滤：命中直接 SKIP，不送 AI
    if (shouldBlock(m.content)) {
      if (shouldSkipReviewQueueForBlocked(m.content)) {
        console.log(`  [跳过不入待确认] 订单/物流/售后系统类: ${m.sender}: ${m.content.slice(0, 60)}`);
        markCooldown(state, m.id, CONFIG.skipCooldownMs, 'skipped');
      } else if (looksLikeCustomerServiceQuestion(m.content)) {
        appendReviewQueue({
          source: '群聊',
          title,
          sender: m.sender,
          content: m.content,
          reason: '非产品客服流程问题，当前规则要求先由大和确认是否允许自动回复。',
          context: buildReviewContext(formatted, m),
          suggestion: '如确认可回复，请提供标准话术并同步到客服知识库。',
        });
        markCooldown(state, m.id, CONFIG.skipCooldownMs, 'skipped');
      }
      console.log(`  [拦截] 命中屏蔽词: ${m.sender}: ${m.content.slice(0, 60)}`);
      return false;
    }
    const plainContent = isMediaMessage(m.content) ? stripMediaMarkers(m.content) : m.content;
    if (looksLikeDesignOrImageRequiredQuestion(plainContent)) {
      console.log(`  [跳过] 设计/现场图片类问题: ${m.sender}: ${plainContent.slice(0, 60)}`);
      markCooldown(state, m.id, CONFIG.skipCooldownMs, 'skipped');
      return false;
    }
    if (!isMediaMessage(m.content) && !looksLikeProductQuestion(m.content) && !looksLikeCustomerServiceQuestion(m.content)) {
      return false;
    }
    // 长消息但不含产品关键词且无问号 → 大概率是分享/故事/通知，直接跳过
    if (m.content.length > 80 && !/[?？]/.test(m.content) && !/抽屉|抽|轨道|柜|安装|尺寸|材质|高度|宽度|深度|升降|分隔|门板|垫块|挂盒|魔法|尚酷|定制|连门|开门/.test(m.content)) {
      return false;
    }
    // 图片消息：有文字+图片 → 去掉图片标记后保留文字；纯图片 → 请求图片识别
    if (isMediaMessage(m.content)) {
      const stripped = stripMediaMarkers(m.content);
      if (stripped.length >= 8) {
        if (looksLikeDesignOrImageRequiredQuestion(stripped)) {
          console.log(`  [跳过] 设计/现场图片类问题: ${m.sender}: ${stripped.slice(0, 60)}`);
          markCooldown(state, m.id, CONFIG.skipCooldownMs, 'skipped');
          return false;
        }
        m._originalContentWithMedia = m.content;
        m.content = stripped; // 保留文字部分
        m._hadImage = true;
        return true;
      }
      // 纯图片消息 → 尝试本地缓存识别
      m._pureImage = true;
      return true; // 交给后续 processMessageImages 处理
    }
    // 时间过滤：只回复最近窗口内的消息
    if (m.time) {
      const msgTime = new Date(m.time).getTime();
      if (Date.now() - msgTime > CONFIG.recentMessageWindowMs) return false;
    }
    return true;
  });

  if (!unhandled.length) return null;

  // 过滤已被 HQ 回复过的问题
  const trulyUnhandled = unhandled.filter(m => {
    const msgIdx = formatted.findIndex(item => item.id === m.id);
    if (msgIdx < 0) return true;
    // 用正序消息检查后续是否已有 HQ 的实质性回复
    for (let j = 1; j <= 5 && msgIdx + j < formatted.length; j++) {
      const next = formatted[msgIdx + j];
      const nextSender = next.sender || '';
      const nextContent = (typeof next.content === 'string' ? next.content : '').trim();
      if (nextContent.length < 10 || /^(好的|收到|谢谢|OK|嗯嗯)/.test(nextContent)) continue;
      if (CONFIG.filterEmployeeSenders && isEmployeeSender(nextSender, next.senderUserId)) {
        console.log(`  [跳过] 员工已回复: ${m.sender}: ${m.content.slice(0, 50)}`);
        return false;
      }
      if ((!CONFIG.filterEmployeeSenders || !isEmployeeSender(nextSender, next.senderUserId)) && nextContent.length > 10) break;
    }
    return true;
  });

  if (!trulyUnhandled.length) return null;
  unhandled = trulyUnhandled;

  // 详细日志
  console.log(`\n[${title}] ${messages.length}条消息, ${unhandled.length}条待处理`);

  const contextStr = formatted.map(m => `[${m.time}] ${m.sender}: ${m.content}`).join('\n');
  const history = loadHistory();

  // 逐条处理未回复消息
  for (const msg of unhandled) {
    let single = `[${msg.time}] ${msg.sender}: ${msg.content}`;

    // 图片识别：处理消息中的图片
    let imageContext = '';
    const hasImage = isMediaMessage(msg.content) || msg._hadImage || msg._pureImage;
    if (hasImage) {
      try {
        const sourceContent = msg._originalContentWithMedia || msg.content;
        const imageResult = await processMessageImages({ ...msg, content: sourceContent }, msg.time);
        const { recognizedTexts, remainingContent } = imageResult;
        if (!imageResult.originalMediaReady) {
          console.log(`  [跳过] 群内原图未获取: ${msg.sender}: ${(msg.content || '').slice(0, 60)}`);
          markCooldown(state, msg.id, CONFIG.skipCooldownMs, 'skipped');
          continue;
        }
        if (recognizedTexts.length > 0) {
          imageContext = '\n[图片识别结果]\n' + recognizedTexts.join('\n---\n');
          msg.content = (remainingContent || '图片') + imageContext;
          single = `[${msg.time}] ${msg.sender}: ${msg.content}`;
        } else {
          console.log(`  [跳过] 带图消息未取得识别结果: ${msg.sender}: ${(msg.content || '').slice(0, 60)}`);
          markCooldown(state, msg.id, CONFIG.skipCooldownMs, 'skipped');
          continue;
        }
      } catch (e) {
        console.log(`  [跳过] 图片识别异常: ${msg.sender}: ${e.message}`);
        markCooldown(state, msg.id, CONFIG.skipCooldownMs, 'skipped');
        continue;
      }
    }
    const priorImageResult = await buildPriorImageContextForShortQuestion(formatted, msg);
    if (!priorImageResult.originalMediaReady || (priorImageResult.hasPriorImage && !priorImageResult.recognitionReady)) {
      console.log(`  [跳过] 上文原图未获取或识别失败: ${msg.sender}: ${(msg.content || '').slice(0, 60)}`);
      markCooldown(state, msg.id, CONFIG.skipCooldownMs, 'skipped');
      continue;
    }
    if (priorImageResult.text) {
      imageContext += '\n[上文图片识别结果]\n' + priorImageResult.text;
      msg.content = `${msg.content}\n[上文图片识别结果]\n${priorImageResult.text}`;
      single = `[${msg.time}] ${msg.sender}: ${msg.content}`;
    }

    const imageRuleReply = buildProductImageRuleReply(msg.content, contextStr);
    if (imageRuleReply) {
      handlePreparedRuleReply({
        state,
        messageKey: msg.id,
        msg,
        reply: imageRuleReply,
        reviewSource: '群聊-产品图片规则',
        queuePayload: {
          source: '群聊-产品图片规则',
          targetType: 'group',
          title,
          conversationId: cid,
          sender: msg.sender,
          senderUserId: msg.senderUserId,
          senderOpenDingTalkId: msg.senderOpenDingTalkId,
          messageTime: msg.time,
          content: msg.content,
          context: buildReviewContext(formatted, msg),
          reason: '产品图片规则：对方明确要实物图/产品图/参考图，资料库已有图片，直接发送图片文件。',
          deepseekDecision: 'local_product_image_rule',
        },
        send: () => sendReply(cid, imageRuleReply),
        history,
        historyUser: single,
      });
      continue;
    }

    const installRuleReply = buildInstallTutorialRuleReply(msg.content, contextStr);
    if (installRuleReply) {
      handlePreparedRuleReply({
        state,
        messageKey: msg.id,
        msg,
        reply: installRuleReply,
        reviewSource: '群聊-安装教程规则',
        queuePayload: {
          source: '群聊-安装教程规则',
          targetType: 'group',
          title,
          conversationId: cid,
          sender: msg.sender,
          senderUserId: msg.senderUserId,
          senderOpenDingTalkId: msg.senderOpenDingTalkId,
          messageTime: msg.time,
          content: msg.content,
          context: buildReviewContext(formatted, msg),
          reason: '安装教程规则：有明确安装说明书则发送资料；没有明确安装说明书则发送微信视频号口径。',
          deepseekDecision: 'local_install_tutorial_rule',
        },
        send: () => sendReply(cid, installRuleReply),
        history,
        historyUser: single,
      });
      continue;
    }

    if (looksLikeDesignOrImageRequiredQuestion(msg.content)) {
      console.log(`  [跳过] 设计/现场图片类问题: ${msg.sender}: ${(msg.content || '').slice(0, 60)}`);
      markCooldown(state, msg.id, CONFIG.skipCooldownMs, 'skipped');
      continue;
    }

    const systemPrompt = `你是大和，酷太用户体验部成员。在钉钉群「${title}」回复消息。

回复规则：
1. 先通读所有消息理解整体话题
2. 你现在只需要回复下面这一条消息，不要重复回答之前的其他问题
3. 回复自然清晰，讲清楚，不限句数。**必须用纯文本，禁止使用 Markdown 格式**（不要用表格/加粗/代码块/标题符号）
4. 禁止在回复中称呼、复述或@任何人的姓名、昵称、手机号或门店名；直接从结论开始
5. 只回复和酷太产品相关的问题：产品结构、尺寸、选型、安装、材质、承重、适配、资料发送等
6. **必须有100%把握且产品知识库里有明确、直接答案才可以回复**。需要推理、猜测、类比、现场责任判断、设计方案、现场照片判断、已安装后的现场异常/摩擦柜门/运行卡滞/左右微调、没有明确尺寸的空间适配、订单/物流/退款/财务/售后流程的问题一律不要直接回复
7. 消息含语音/视频等非文本 → SKIP（图片已自动识别为文字，但仍要按第6条判断）
8. 对方在跟其他人对话、纯闲聊、纯@提及 → SKIP
9. 与产品无关的内容（音乐分享、情感表达、生活话题等）→ SKIP
10. 对“能否连门安装/这个能装吗/可以吗”这类短问，必须结合上文图片、上一条产品名称、型号或尺寸判断具体产品；如果上文能确认是水槽中枢阁/水槽侧拉中枢阁，回复不能连门安装；如果无法确认具体产品，只回 REVIEW 或 SKIP，禁止泛泛套用普通门板/反弹器口径
11. 明确问“极限安装/极限尺寸/安装宽度/安装深度/安装高度/安装孔位/孔位”的，优先引用 10A-极限安装.md；回复要给对应极限安装示意图文件名、孔位/极限尺寸 PDF 文件名和完整尺寸数据。若同一产品名有多套规格但问题未说明层数/规格，列出可能项让对方确认，不要只回泛泛口径
12. 问“实物图/产品图/参考图/效果图/有没有图片”的，优先发送产品图片；资料库已有图片时不要改成产品功能解释
13. 问“怎么安装/如何安装/安装教程/安装说明书/安装视频”的，优先发送对应安装说明书；如果没有明确安装说明书，只回复“安装教程在微信视频号搜：酷太新零售哦”
${imageContext ? '14. 对方发了图片，识别结果在消息中。只有当图片识别结果和文字里已有明确产品型号/尺寸/安装条件，且知识库有直接答案时才回复；现场方案、仅凭图片判断、没有尺寸的空间适配问题一律 SKIP 或 REVIEW，不要泛泛回复。' : ''}
不需要回复时只回SKIP。拿不准、知识库依据不足、可能讲错、需要大和确认时，只回 REVIEW: 原因: ... 建议: ...，系统会记录给大和确认，禁止发送给钉钉。
禁止说"我帮你查/稍后发"。具体订单、物流、退款、财务、赔付、补发、换货结果不能承诺。

===== 客服自动回复知识库 =====

${customerServiceKnowledge}

===== 产品知识库 =====

${buildPromptProductKnowledge(`${single}\n${contextStr}`)}`;

    const userPrompt = `群聊上下文:\n${contextStr.slice(-800)}\n\n请回复这条消息:\n${single}`;

    let reply = await callAI(systemPrompt, userPrompt);
    reply = sanitizeReplyAddressees(reply, formatted.map(item => item.sender));

    const invalidReply = /^(不需要回复|无需回复|SKIP|没有需要)/i;
    const review = parseReviewReply(reply);
    if (review) {
      let queuedForPendingReview = false;
      if (shouldSkipReviewQueueForReview(msg.content, review.reason, review.suggestion)) {
        console.log(`  [REVIEW转跳过] 群聊订单/物流/售后系统类: ${msg.sender}: ${msg.content.slice(0, 60)}`);
      } else if (CONFIG.pendingReviewMode) {
        queuePendingReply(state, msg.id, {
          source: '群聊-DeepSeek待确认',
          targetType: 'group',
          title,
          conversationId: cid,
          sender: msg.sender,
          senderUserId: msg.senderUserId,
          senderOpenDingTalkId: msg.senderOpenDingTalkId,
          messageTime: msg.time,
          content: msg.content,
          context: buildReviewContext(formatted, msg),
          reason: `DeepSeek返回 REVIEW：${review.reason}`,
          deepseekSuggestion: review.suggestion,
          deepseekDecision: 'review',
        });
        queuedForPendingReview = true;
      } else {
        appendReviewQueue({
          source: '群聊',
          title,
          sender: msg.sender,
          content: msg.content,
          reason: review.reason,
          context: buildReviewContext(formatted, msg),
          suggestion: review.suggestion,
        });
      }
      if (!queuedForPendingReview) {
        markCooldown(state, msg.id, CONFIG.skipCooldownMs, 'skipped');
      }
      continue;
    }

    if (!reply || reply === 'SKIP' || reply.trim().length < 2 || invalidReply.test(reply.trim())) {
      if (shouldForceReviewOnSkip(msg.content)) {
        const reviewItem = {
          source: '群聊',
          title,
          sender: msg.sender,
          content: msg.content,
          reason: '产品尺寸/结构确认类问题被AI判成SKIP。该类问题不允许静默跳过，需由大和确认是否可直接形成标准口径。',
          context: buildReviewContext(formatted, msg),
          suggestion: '请确认这条尺寸/结构问题的标准回复口径；如知识库已有明确答案，后续应直接自动回复；如暂无明确数据，也至少保留到待确认。',
        };
        if (CONFIG.pendingReviewMode) {
          queuePendingReply(state, msg.id, {
            ...reviewItem,
            source: '群聊-DeepSeek跳过待审',
            targetType: 'group',
            conversationId: cid,
            senderUserId: msg.senderUserId,
            senderOpenDingTalkId: msg.senderOpenDingTalkId,
            messageTime: msg.time,
            deepseekSuggestion: '',
            deepseekDecision: 'skip_force_review',
          });
        } else {
          appendReviewQueue(reviewItem);
          markCooldown(state, msg.id, CONFIG.skipCooldownMs, 'skipped');
        }
        continue;
      }
      console.log(`  SKIP [${msg.sender}]: ${msg.content.slice(0, 60)}`);
      markCooldown(state, msg.id, CONFIG.skipCooldownMs, 'skipped');
      continue;
    }

    if (replyLooksBad(reply)) {
      console.log(`  [拦截] 回复质量不合格: ${reply.slice(0, 80)}`);
      if (CONFIG.pendingReviewMode) {
        queuePendingReply(state, msg.id, {
          source: '群聊-DeepSeek回复待修',
          targetType: 'group',
          title,
          conversationId: cid,
          sender: msg.sender,
          senderUserId: msg.senderUserId,
          senderOpenDingTalkId: msg.senderOpenDingTalkId,
          messageTime: msg.time,
          content: msg.content,
          context: buildReviewContext(formatted, msg),
          reason: 'DeepSeek给出了候选回复，但命中质量拦截，需要Codex重写后再决定是否发送。',
          deepseekSuggestion: reply,
          deepseekDecision: 'bad_reply',
        });
        continue;
      }
      markCooldown(state, msg.id, CONFIG.skipCooldownMs, 'skipped');
      continue;
    }

    if (CONFIG.pendingReviewMode) {
      queuePendingReply(state, msg.id, {
        source: '群聊-DeepSeek候选',
        targetType: 'group',
        title,
        conversationId: cid,
        sender: msg.sender,
        senderUserId: msg.senderUserId,
        senderOpenDingTalkId: msg.senderOpenDingTalkId,
        messageTime: msg.time,
        content: msg.content,
        context: buildReviewContext(formatted, msg),
        reason: 'DeepSeek判断可回复；待Codex审核是否发送及重写最终话术。',
        deepseekSuggestion: reply,
        deepseekDecision: 'reply',
      });
      continue;
    }

    const now = Date.now();
    const lastReply = getConversationLastReply(state, 'group', cid);
    if (now - lastReply < CONFIG.rateLimitSec * 1000) {
      console.log(`  [限频] ${Math.round((now-lastReply)/1000)}秒前刚回复过，跳过 [${msg.sender}]`);
      markCooldown(state, msg.id, CONFIG.rateLimitSec * 1000, 'deferred');
      continue;
    }

    console.log(`  消息 [${msg.sender}]: ${msg.content.slice(0, 120)}`);
    console.log(`  AI 回复: ${reply.slice(0, 150)}`);

    if (CONFIG.semiAutoMode) {
      appendReviewQueue({
        source: '群聊-半自动',
        title,
        sender: msg.sender,
        content: msg.content,
        reason: '半自动模式：系统判断可以回复，但不自动发送钉钉，等待大和确认。',
        suggestion: reply,
      });
      markCooldown(state, msg.id, CONFIG.skipCooldownMs, 'deferred');
      saveState(state);
      console.log('  [半自动] 已记录建议回复，未发送钉钉');
      continue;
    }

    const sendResult = sendReply(cid, reply);
    if (sendResult?.success) {
      maybeSendReferencedFiles(msg, reply);
      markReplied(state, msg.id);
      markConversationReply(state, 'group', cid);
      saveState(state);
      history.push({ user: single.slice(0, 500), reply });
      saveHistory(history);
      console.log(`  发送成功 ✓`);
    } else {
      markCooldown(state, msg.id, CONFIG.rateLimitSec * 1000, 'deferred');
      saveState(state);
      console.log(`  发送失败: ${JSON.stringify(sendResult)?.slice(0, 150)}`);
    }

    await new Promise(r => setTimeout(r, 3000));
  }

  return null;
}

// ====== 主轮询 ======
async function poll() {
  const state = loadState();
  let conversations = [];

  if (CONFIG.enableGroupReplies) {
    if (isDwsScanPaused(state, 'group')) {
      conversations = [];
    } else {
      const unreadResult = dws('chat message list-unread-conversations');
      if (!unreadResult && isDwsAuthorizationPromptError(lastDwsErrorText)) {
        pauseDwsScan(state, 'group', lastDwsErrorText);
      }
      conversations = unreadResult?.result?.conversations || [];
    }

    if (conversations.length) {
      conversations.sort((a, b) => (b.lastMsgCreateAt || 0) - (a.lastMsgCreateAt || 0));
      const batchSize = Math.max(1, CONFIG.maxGroupsPerPoll);
      const cursor = state.lastConversationCursor || 0;
      const toProcess = [];

      for (let i = 0; i < Math.min(batchSize, conversations.length); i++) {
        const idx = (cursor + i) % conversations.length;
        toProcess.push(conversations[idx]);
      }

      state.lastConversationCursor = (cursor + toProcess.length) % conversations.length;

      console.log(`\n[${new Date().toLocaleTimeString('zh-CN')}] ${conversations.length} 个未读群，处理 ${toProcess.length} 个`);

      for (const conv of toProcess) {
        if (isDwsScanPaused(state, 'group')) break;
        await processGroup(conv, state);
        if (isDwsScanPaused(state, 'group')) break;
        await new Promise(r => setTimeout(r, 2000));
      }
    } else {
      console.log(`[${new Date().toLocaleTimeString('zh-CN')}] 无未读群消息`);
    }
  } else {
    console.log(`[${new Date().toLocaleTimeString('zh-CN')}] 群回复已关闭`);
  }

  if (CONFIG.enableDirectReplies) {
    await processDirectMessages(state);
  } else {
    console.log('[私聊] 私信回复已关闭');
  }

  saveState(state);
}

// ====== 处理私聊消息 ======
async function processDirectMessages(state) {
  if (isDwsScanPaused(state, 'direct')) return;

  const now = new Date();
  const recentWindowStart = new Date(now - CONFIG.recentMessageWindowMs);
  const fmtLocal = d => {
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  const allResult = dws(`chat message list-all --start "${fmtLocal(recentWindowStart)}" --end "${fmtLocal(now)}" --limit 100`);
  if (!allResult && isDwsAuthorizationPromptError(lastDwsErrorText)) {
    pauseDwsScan(state, 'direct', lastDwsErrorText);
    return;
  }
  const convoList = allResult?.result?.conversationMessagesList || [];
  const singleCount = convoList.filter(c => c.singleChat).length;
  if (singleCount > 0) console.log(`[私聊扫描] 共${convoList.length}会话, ${singleCount}个私聊`);

  for (const convo of convoList) {
    if (!convo.singleChat) continue;  // 只处理私聊
    const msgs = (convo.messages || []).reverse();
    if (!msgs.length) continue;
    const title = convo.title || '私聊';

    const filtered = msgs.filter(m => {
      const sender = m.sender || '';
      if (sender.includes(currentUserName)) return false;
      const c = (m.content || '').trim();
      if (c.length < 4) return false;
      if (isTrivialReply(c)) return false;
      const record = getMessageRecord(state, msgKey(m));
      if (record) {
        if (record.status === 'replied') return false;
        if (record.status === 'queued') return false;
        if ((record.status === 'skipped' || record.status === 'deferred') && record.expiresAt > Date.now()) return false;
        delete state.repliedMsgs[msgKey(m)];
      }
      const msgTime = new Date(m.createTime || m.createdAt || '').getTime();
      if (Number.isFinite(msgTime) && Date.now() - msgTime > CONFIG.recentMessageWindowMs) return false;
      if (hasAssociatedVideoContext(msgs, m)) {
        console.log(`  [跳过] 私聊视频关联问题: ${sender}: ${c.slice(0, 60)}`);
        markCooldown(state, msgKey(m), CONFIG.skipCooldownMs, 'skipped');
        return false;
      }
      if (!isDirectConversationAllowed(title, m)) return false;
      return true;
    });
    if (!filtered.length) continue;

    const cid = convo.openConversationId;
    const contextStr = msgs.map(m => `[${m.createTime}] ${(m.sender||'')}: ${(m.content||'')}`).join('\n');

    console.log(`\n[${title}] 私聊, ${filtered.length}条待处理`);

    // 逐条处理
    for (const msg of filtered) {
      const directMessageKey = msgKey(msg);
      if (looksLikeAfterSalesInstallAbnormalQuestion(msg.content || '', contextStr)) {
        console.log(`  [跳过] 售后/现场安装异常类问题: ${msg.sender}: ${(msg.content || '').slice(0, 60)}`);
        markCooldown(state, directMessageKey, CONFIG.skipCooldownMs, 'skipped');
        continue;
      }
      if (shouldBlock(msg.content || '') && shouldSkipReviewQueueForBlocked(msg.content || '')) {
        console.log(`  [跳过不入待确认] 私聊订单/物流/售后系统类: ${msg.sender}: ${(msg.content || '').slice(0, 60)}`);
        markCooldown(state, directMessageKey, CONFIG.skipCooldownMs, 'skipped');
        continue;
      }

      let single = `[${msg.createTime}] ${msg.sender}: ${msg.content}`;

      // 图片识别
      let imageContext = '';
      const hasImage = isMediaMessage(msg.content) || msg._hadImage || msg._pureImage;
      if (hasImage) {
        try {
          const sourceContent = msg._originalContentWithMedia || msg.content;
          const imageResult = await processMessageImages({ ...msg, content: sourceContent }, msg.createTime);
          const { recognizedTexts, remainingContent } = imageResult;
          if (!imageResult.originalMediaReady) {
            console.log(`  [跳过] 私聊原图未获取: ${msg.sender}: ${(msg.content || '').slice(0, 60)}`);
            markCooldown(state, directMessageKey, CONFIG.skipCooldownMs, 'skipped');
            continue;
          }
          if (recognizedTexts.length > 0) {
            imageContext = '\n[图片识别结果]\n' + recognizedTexts.join('\n---\n');
            msg.content = (remainingContent || '图片') + imageContext;
            single = `[${msg.createTime}] ${msg.sender}: ${msg.content}`;
          } else {
            console.log(`  [跳过] 私聊带图消息未取得识别结果: ${msg.sender}: ${(msg.content || '').slice(0, 60)}`);
            markCooldown(state, directMessageKey, CONFIG.skipCooldownMs, 'skipped');
            continue;
          }
        } catch (e) {
          console.log(`  [跳过] 私聊图片识别异常: ${msg.sender}: ${e.message}`);
          markCooldown(state, directMessageKey, CONFIG.skipCooldownMs, 'skipped');
          continue;
        }
      }
      const priorImageResult = await buildPriorImageContextForShortQuestion(msgs, msg);
      if (!priorImageResult.originalMediaReady || (priorImageResult.hasPriorImage && !priorImageResult.recognitionReady)) {
        console.log(`  [跳过] 私聊上文原图未获取或识别失败: ${msg.sender}: ${(msg.content || '').slice(0, 60)}`);
        markCooldown(state, directMessageKey, CONFIG.skipCooldownMs, 'skipped');
        continue;
      }
      if (priorImageResult.text) {
        imageContext += '\n[上文图片识别结果]\n' + priorImageResult.text;
        msg.content = `${msg.content}\n[上文图片识别结果]\n${priorImageResult.text}`;
        single = `[${msg.createTime}] ${msg.sender}: ${msg.content}`;
      }

      const imageRuleReply = buildProductImageRuleReply(msg.content, contextStr);
      if (imageRuleReply) {
        handlePreparedRuleReply({
          state,
          messageKey: directMessageKey,
          msg,
          reply: imageRuleReply,
          reviewSource: '私聊-产品图片规则',
          queuePayload: {
            source: '私聊-产品图片规则',
            targetType: 'direct',
            title,
            conversationId: cid,
            sender: msg.sender,
            senderUserId: msg.senderStaffId || msg.senderUserId || msg.userId || '',
            senderOpenDingTalkId: msg.senderOpenDingTalkId || '',
            messageTime: msg.createTime || msg.createdAt || '',
            content: msg.content,
            context: buildReviewContext(msgs, msg),
            reason: '产品图片规则：对方明确要实物图/产品图/参考图，资料库已有图片，直接发送图片文件。',
            deepseekDecision: 'local_product_image_rule',
          },
          send: () => sendDirectReply(msg, imageRuleReply),
        });
        continue;
      }

      const installRuleReply = buildInstallTutorialRuleReply(msg.content, contextStr);
      if (installRuleReply) {
        handlePreparedRuleReply({
          state,
          messageKey: directMessageKey,
          msg,
          reply: installRuleReply,
          reviewSource: '私聊-安装教程规则',
          queuePayload: {
            source: '私聊-安装教程规则',
            targetType: 'direct',
            title,
            conversationId: cid,
            sender: msg.sender,
            senderUserId: msg.senderStaffId || msg.senderUserId || msg.userId || '',
            senderOpenDingTalkId: msg.senderOpenDingTalkId || '',
            messageTime: msg.createTime || msg.createdAt || '',
            content: msg.content,
            context: buildReviewContext(msgs, msg),
            reason: '安装教程规则：有明确安装说明书则发送资料；没有明确安装说明书则发送微信视频号口径。',
            deepseekDecision: 'local_install_tutorial_rule',
          },
          send: () => sendDirectReply(msg, installRuleReply),
        });
        continue;
      }

      if (looksLikeDesignOrImageRequiredQuestion(msg.content)) {
        console.log(`  [跳过] 私聊设计/现场图片类问题: ${msg.sender}: ${(msg.content || '').slice(0, 60)}`);
        markCooldown(state, directMessageKey, CONFIG.skipCooldownMs, 'skipped');
        continue;
      }

      const hasImageRecognition = single.includes('[图片识别结果]') || single.includes('[上文图片识别结果]');
    const directReplyRule = CONFIG.relaxedDirectReplies
      ? '私聊口径可以放宽：只要问题明确指向酷太产品，且结合知识库、上下文、已有规则或常见产品逻辑基本可以判断，就直接回复，不用等到100%逐字命中知识库。优先把话说明白、把对方当前问题接住。只有在产品型号、尺寸、配件、兼容性、安装条件等确实拿不准，或者可能误导对方时，才返回 REVIEW。'
      : '必须有100%把握且产品知识库里有明确、直接答案才可以回复。拿不准、知识库依据不足、可能讲错、需要大和确认时，只回 REVIEW: 原因: ... 建议: ...，系统会记录给大和确认，禁止发送给钉钉。';

    const systemPrompt = `你是大和，酷太用户体验部成员。在钉钉私聊中回复消息。

只回复和酷太产品相关的问题：产品结构、尺寸、选型、安装、材质、承重、适配、资料发送等。尺寸、安装、极限、产品结构问题只能依据结构化产品事实与安装规则判断；营销话术、设计建议和空间方案只能在事实结论确定后做语气润色，禁止参与事实判断。
先通读所有消息理解话题。你现在只需要回复下面这一条消息，不要叠加重复回答旧问题。回复讲清楚，不限句数。**必须用纯文本，禁止 Markdown 格式**。禁止在回复中称呼、复述或@任何人的姓名、昵称、手机号或门店名；直接从结论开始。
${directReplyRule}
订单、物流、退款、财务、赔付、补发、换货结果、售后责任判断、设计方案、现场照片判断、已安装后的现场异常/摩擦柜门/运行卡滞/左右微调、没有明确尺寸的空间适配等非产品知识问题，不自动回复；如你认为后续可以建立规则，也返回 REVIEW 等待大和确认。
对“能否连门安装/这个能装吗/可以吗”这类短问，必须结合上文图片、上一条产品名称、型号或尺寸判断具体产品；如果上文能确认是水槽中枢阁/水槽侧拉中枢阁，回复不能连门安装；如果无法确认具体产品，只回 REVIEW 或 SKIP，禁止泛泛套用普通门板/反弹器口径。
明确问“极限安装/极限尺寸/安装宽度/安装深度/安装高度/安装孔位/孔位”的，优先引用 10A-极限安装.md；回复要给对应极限安装示意图文件名、孔位/极限尺寸 PDF 文件名和完整尺寸数据。若同一产品名有多套规格但问题未说明层数/规格，列出可能项让对方确认，不要只回泛泛口径。
问“实物图/产品图/参考图/效果图/有没有图片”的，优先发送产品图片；资料库已有图片时不要改成产品功能解释。
问“怎么安装/如何安装/安装教程/安装说明书/安装视频”的，优先发送对应安装说明书；如果没有明确安装说明书，只回复“安装教程在微信视频号搜：酷太新零售哦”。
不需要回复时只回SKIP。禁止说"我帮你查/稍后发"。
${hasImageRecognition ? '\n对方发了一张图片，识别结果附在消息中。只有当图片识别结果和文字里已有明确产品型号/尺寸/安装条件，且知识库有直接答案时才回复；现场方案、仅凭图片判断、没有尺寸的空间适配问题一律 SKIP 或 REVIEW，不要泛泛回复。' : ''}

===== 客服自动回复知识库 =====

${customerServiceKnowledge}

===== 产品知识库 =====

${buildPromptProductKnowledge(`${single}\n${contextStr}`)}`;

      let reply = await callAI(systemPrompt, `私聊上下文:\n${contextStr.slice(-800)}\n\n请回复这条消息:\n${single}`);
      reply = sanitizeReplyAddressees(reply, msgs.map(item => item.sender));

      const invalidReply = /^(不需要回复|无需回复|SKIP|没有需要)/i;
      const review = parseReviewReply(reply);
      if (review) {
        let queuedForPendingReview = false;
        if (shouldSkipReviewQueueForReview(msg.content || '', review.reason, review.suggestion)) {
          console.log(`  [REVIEW转跳过] 私聊订单/物流/售后系统类: ${msg.sender}: ${(msg.content || '').slice(0, 60)}`);
        } else if (CONFIG.pendingReviewMode) {
          queuePendingReply(state, directMessageKey, {
            source: '私聊-DeepSeek待确认',
            targetType: 'direct',
            title,
            conversationId: cid,
            sender: msg.sender,
            senderUserId: msg.senderStaffId || msg.senderUserId || msg.userId || '',
            senderOpenDingTalkId: msg.senderOpenDingTalkId || '',
            messageTime: msg.createTime || msg.createdAt || '',
            content: msg.content,
            context: buildReviewContext(msgs, msg),
            reason: `DeepSeek返回 REVIEW：${review.reason}`,
            deepseekSuggestion: review.suggestion,
            deepseekDecision: 'review',
          });
          queuedForPendingReview = true;
        } else {
          appendReviewQueue({
            source: '私聊',
            title,
            sender: msg.sender,
            content: msg.content,
            reason: review.reason,
            context: buildReviewContext(msgs, msg),
            suggestion: review.suggestion,
          });
        }
        if (!queuedForPendingReview) {
          markCooldown(state, directMessageKey, CONFIG.skipCooldownMs, 'skipped');
        }
        continue;
      }

      if (!reply || reply === 'SKIP' || reply.trim().length < 2 || invalidReply.test(reply.trim())) {
        const contentText = (msg.content || '').trim();
        if (looksLikeProductQuestion(contentText) && !isMediaMessage(contentText) && !shouldBlock(contentText)) {
          reply = buildClarifyReply(contentText, contextStr);
          if (reply) {
            console.log(`  澄清 [${msg.sender}]: ${reply.slice(0, 80)}`);
          } else {
            console.log(`  SKIP [${msg.sender}]: ${contentText.slice(0, 60)}`);
            markCooldown(state, directMessageKey, CONFIG.skipCooldownMs, 'skipped');
            continue;
          }
        } else {
          console.log(`  SKIP [${msg.sender}]: ${contentText.slice(0, 60)}`);
          markCooldown(state, directMessageKey, CONFIG.skipCooldownMs, 'skipped');
          continue;
        }
      }

      if (replyLooksBad(reply)) {
        console.log(`  [拦截] 私聊回复质量不合格: ${reply.slice(0, 80)}`);
        if (CONFIG.pendingReviewMode) {
          queuePendingReply(state, directMessageKey, {
            source: '私聊-DeepSeek回复待修',
            targetType: 'direct',
            title,
            conversationId: cid,
            sender: msg.sender,
            senderUserId: msg.senderStaffId || msg.senderUserId || msg.userId || '',
            senderOpenDingTalkId: msg.senderOpenDingTalkId || '',
            messageTime: msg.createTime || msg.createdAt || '',
            content: msg.content,
            context: buildReviewContext(msgs, msg),
            reason: 'DeepSeek给出了候选回复，但命中质量拦截，需要Codex重写后再决定是否发送。',
            deepseekSuggestion: reply,
            deepseekDecision: 'bad_reply',
          });
          continue;
        }
        markCooldown(state, directMessageKey, CONFIG.skipCooldownMs, 'skipped');
        continue;
      }

      if (CONFIG.pendingReviewMode) {
        queuePendingReply(state, directMessageKey, {
          source: '私聊-DeepSeek候选',
          targetType: 'direct',
          title,
          conversationId: cid,
          sender: msg.sender,
          senderUserId: msg.senderStaffId || msg.senderUserId || msg.userId || '',
          senderOpenDingTalkId: msg.senderOpenDingTalkId || '',
          messageTime: msg.createTime || msg.createdAt || '',
          content: msg.content,
          context: buildReviewContext(msgs, msg),
          reason: 'DeepSeek判断可回复；待Codex审核是否发送及重写最终话术。',
          deepseekSuggestion: reply,
          deepseekDecision: 'reply',
        });
        continue;
      }

      // 限频
      const now = Date.now();
      const lastReply = getConversationLastReply(state, 'direct', cid);
      if (now - lastReply < CONFIG.rateLimitSec * 1000) {
        console.log(`  [限频] ${Math.round((now-lastReply)/1000)}秒前刚回复过，跳过 [${msg.sender}]`);
        markCooldown(state, directMessageKey, CONFIG.rateLimitSec * 1000, 'deferred');
        continue;
      }

      console.log(`  消息 [${msg.sender}]: ${(msg.content||'').slice(0, 120)}`);
      console.log(`  AI 回复: ${reply.slice(0, 150)}`);

      if (CONFIG.semiAutoMode) {
        appendReviewQueue({
          source: '私聊-半自动',
          title,
          sender: msg.sender,
          content: msg.content,
          reason: '半自动模式：系统判断可以回复，但不自动发送钉钉，等待大和确认。',
          suggestion: reply,
        });
        markCooldown(state, directMessageKey, CONFIG.skipCooldownMs, 'deferred');
        saveState(state);
        console.log('  [半自动] 已记录建议回复，未发送钉钉');
        continue;
      }

      const sendResult = sendDirectReply(msg, reply);
      if (sendResult?.success) {
        maybeSendReferencedFiles(msg, reply);
        markReplied(state, directMessageKey);
        markConversationReply(state, 'direct', cid);
        saveState(state);
        console.log(`  发送成功 ✓`);
      } else {
        markCooldown(state, directMessageKey, CONFIG.rateLimitSec * 1000, 'deferred');
        saveState(state);
        console.log(`  发送失败: ${JSON.stringify(sendResult)?.slice(0, 150)}`);
      }

      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// ====== 机器人入口：复用现有知识库、Dify、视觉和过滤规则，单条消息决策 ======
function normalizeEngineMessage(raw) {
  const base = fmtMsg(raw || {});
  if (raw?.id) base.id = raw.id;
  if (raw?.sender) base.sender = raw.sender;
  if (raw?.content !== undefined) base.content = String(raw.content || '');
  base.time = raw?.time || raw?.createTime || raw?.createdAt || base.time || new Date().toISOString();
  base.senderOpenDingTalkId = raw?.senderOpenDingTalkId || base.senderOpenDingTalkId || '';
  base.senderUserId = raw?.senderUserId || raw?.senderStaffId || raw?.userId || base.senderUserId || '';
  base._hadImage = raw?._hadImage || false;
  base._pureImage = raw?._pureImage || false;
  base._originalContentWithMedia = raw?._originalContentWithMedia || '';
  base.downloadCode = raw?.downloadCode || raw?.pictureDownloadCode || '';
  base.pictureDownloadCode = raw?.pictureDownloadCode || '';
  base.robotCode = raw?.robotCode || raw?.raw?.robotCode || '';
  base.raw = raw?.raw || raw?.rawMessage || null;
  if (!base.id) {
    base.id = `bot|${stableHash(`${base.sender}|${base.time}|${base.content}`)}`;
  }
  return base;
}

function botSendSucceeded(result) {
  if (!result) return false;
  if (result.success === true) return true;
  if (result.errcode === 0 || result.code === 0 || result.code === '0') return true;
  if (result.status >= 200 && result.status < 300) return true;
  if (result.data?.errcode === 0 || result.data?.code === 0 || result.data?.code === '0') return true;
  return false;
}

async function processSingleMessageForAutoReply({
  state,
  msg,
  messages = [],
  title = '机器人会话',
  conversationId = '',
  targetType = 'direct',
  sourcePrefix = '机器人',
  send,
}) {
  state.repliedMsgs = state.repliedMsgs || {};

  const formatted = (messages.length ? messages : [msg]).map(normalizeEngineMessage);
  let workingMsg = normalizeEngineMessage(msg);
  const sameIndex = formatted.findIndex(item => item.id === workingMsg.id);
  if (sameIndex >= 0) workingMsg = formatted[sameIndex];
  else formatted.push(workingMsg);

  const key = messageKeyOf(workingMsg) || workingMsg.id;
  const source = `${sourcePrefix}-${targetType === 'group' ? '群聊' : '私聊'}`;
  const context = buildReviewContext(formatted, workingMsg);
  let auditContextAnalysis = null;
  const finish = (decision) => {
    const finalDecision = {
      source,
      targetType,
      title,
      conversationId,
      messageKey: key,
      sender: workingMsg.sender,
      content: normalizeReviewText(workingMsg.content, 500),
      ...decision,
    };
    if (auditContextAnalysis) finalDecision.contextAnalysis = auditContextAnalysis;
    if (typeof finalDecision.reply === 'string') {
      finalDecision.reply = sanitizeReplyAddressees(finalDecision.reply, formatted.map(item => item.sender));
    }
    finalDecision.reasonText = describeDecisionReason(finalDecision.reason);
    appendBotAudit(finalDecision);
    return finalDecision;
  };

  const record = getMessageRecord(state, key);
  if (record) {
    const stillCooling = (record.status === 'skipped' || record.status === 'deferred') && record.expiresAt > Date.now();
    const finalRecord = record.status === 'replied' || record.status === 'queued' || stillCooling;
    if (finalRecord) {
      return finish({ action: 'skip', reason: `duplicate_${record.status || 'record'}` });
    }
    delete state.repliedMsgs[key];
  }

  let currentContent = workingMsg.content || '';
  if (hasAssociatedVideoContext(formatted, workingMsg)) {
    markCooldown(state, key, CONFIG.skipCooldownMs, 'skipped');
    saveState(state);
    return finish({ action: 'skip', reason: 'video_context' });
  }

  const imageContextParts = [];
  if (isMediaMessage(currentContent) || workingMsg._hadImage || workingMsg._pureImage) {
    const originalContent = currentContent;
    const plain = stripMediaMarkers(originalContent);
    if (plain) {
      workingMsg._originalContentWithMedia = originalContent;
      workingMsg._hadImage = true;
      workingMsg.content = plain;
      currentContent = plain;
    }
    try {
      const imageResult = await processMessageImages({ ...workingMsg, content: originalContent }, messageTimeOf(workingMsg));
      if (!imageResult.originalMediaReady) {
        markCooldown(state, key, CONFIG.skipCooldownMs, 'skipped');
        saveState(state);
        return finish({ action: 'skip', reason: 'original_image_not_downloaded', imageMediaFailures: imageResult.originalMediaFailures });
      }
      if (imageResult.recognizedTexts.length > 0) {
        imageContextParts.push(`[图片识别结果]\n${imageResult.recognizedTexts.join('\n---\n')}`);
      } else {
        markCooldown(state, key, CONFIG.skipCooldownMs, 'skipped');
        saveState(state);
        return finish({ action: 'skip', reason: 'original_image_recognition_failed', imageRecognitionFailures: imageResult.recognitionFailures });
      }
    } catch (e) {
      markCooldown(state, key, CONFIG.skipCooldownMs, 'skipped');
      saveState(state);
      return finish({ action: 'skip', reason: 'original_image_not_downloaded', imageMediaFailures: [e.message] });
    }
  }

  const priorImageResult = await buildPriorImageContextForShortQuestion(formatted, workingMsg);
  if (!priorImageResult.originalMediaReady) {
    markCooldown(state, key, CONFIG.skipCooldownMs, 'skipped');
    saveState(state);
    return finish({ action: 'skip', reason: 'original_image_not_downloaded', imageMediaFailures: priorImageResult.originalMediaFailures });
  }
  if (priorImageResult.hasPriorImage && !priorImageResult.recognitionReady) {
    markCooldown(state, key, CONFIG.skipCooldownMs, 'skipped');
    saveState(state);
    return finish({ action: 'skip', reason: 'original_image_recognition_failed', imageRecognitionFailures: priorImageResult.recognitionFailures });
  }
  if (priorImageResult.text) {
    imageContextParts.push(`[上文图片识别结果]\n${priorImageResult.text}`);
  }
  const imageContext = imageContextParts.join('\n---\n');
  const recentContextMessages = selectRecentContextMessages(
    formatted,
    workingMsg,
    Math.max(CONFIG.maxHistoryRounds * 2, 8)
  );
  const contextStr = recentContextMessages
    .map(m => `${m.time || ''} ${m.sender || ''}: ${m.content || ''}`)
    .join('\n');
  const priorContextStr = recentContextMessages
    .slice(0, -1)
    .map(m => `${m.time || ''} ${m.sender || ''}: ${m.content || ''}`)
    .join('\n');
  const plainContent = stripMediaMarkers(currentContent);
  auditContextAnalysis = analyzeConversationContext(plainContent || currentContent, priorContextStr, imageContext);
  let single = `发送人：${workingMsg.sender}\n内容：${plainContent || currentContent}`;
  if (imageContext) single += `\n\n${imageContext}`;

  if (looksLikeDiscontinuedLegacySeriesAfterSalesQuestion(plainContent || currentContent, contextStr)) {
    markCooldown(state, key, CONFIG.skipCooldownMs, 'skipped');
    saveState(state);
    return finish({ action: 'skip', reason: 'discontinued_legacy_series_after_sales' });
  }

  const contextualBusinessReason = auditContextAnalysis.businessReason;
  if (contextualBusinessReason) {
    markCooldown(state, key, CONFIG.skipCooldownMs, 'skipped');
    saveState(state);
    return finish({ action: 'skip', reason: contextualBusinessReason });
  }

  if (needsProductConfirmationForCabinetDepthInstallation(plainContent || currentContent, contextStr)) {
    markCooldown(state, key, CONFIG.skipCooldownMs, 'skipped');
    saveState(state);
    return finish({ action: 'review', reason: 'unresolved_product_context_for_installation' });
  }

  const contextResolution = assessContextResolution(plainContent || currentContent, contextStr, imageContext);
  if (contextResolution.needsContext && !contextResolution.resolved) {
    markCooldown(state, key, CONFIG.skipCooldownMs, 'skipped');
    saveState(state);
    return finish({ action: 'skip', reason: 'ambiguous_context_unresolved' });
  }

  const contextualDrawerWidthReply = buildDrawerWidthRuleReply(plainContent || currentContent, contextStr);
  if (contextualDrawerWidthReply) {
    return sendAndRecord(
      contextualDrawerWidthReply,
      'local_drawer_width_rule',
      '抽屉宽度规则：结合当前会话定位产品、柜宽和门型，并读取现有知识库公式计算。'
    );
  }

  if (looksLikeOrderConfigurationQuestion(plainContent || currentContent)) {
    markCooldown(state, key, CONFIG.skipCooldownMs, 'skipped');
    saveState(state);
    return finish({ action: 'skip', reason: 'order_configuration_question' });
  }

  async function sendAndRecord(reply, deepseekDecision, reason, extra = {}) {
    reply = sanitizeReplyAddressees(reply, formatted.map(item => item.sender));
    const queuePayload = {
      source: `${source}-${reason || '候选'}`,
      targetType,
      title,
      conversationId,
      sender: workingMsg.sender,
      senderUserId: workingMsg.senderUserId || '',
      senderOpenDingTalkId: workingMsg.senderOpenDingTalkId || '',
      messageTime: workingMsg.time || '',
      content: workingMsg.content,
      context,
      reason: reason || '系统判断可回复。',
      deepseekSuggestion: reply,
      deepseekDecision,
      ...extra,
    };

    if (CONFIG.pendingReviewMode) {
      const pending = queuePendingReply(state, key, queuePayload);
      return finish({ action: 'queued', reply, reason: reason || 'pending_review', pendingId: pending.id, deepseekDecision });
    }

    const now = Date.now();
    const lastReply = getConversationLastReply(state, targetType, conversationId);
    const activeRateLimitSec = targetType === 'direct' ? CONFIG.directRateLimitSec : CONFIG.groupRateLimitSec;
    if (now - lastReply < activeRateLimitSec * 1000) {
      const waitMs = activeRateLimitSec * 1000 - (now - lastReply) + 50;
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }

    if (CONFIG.semiAutoMode) {
      appendReviewQueue({
        source: `${source}-半自动`,
        title,
        sender: workingMsg.sender,
        content: workingMsg.content,
        reason: '半自动模式：系统判断可以回复，但不自动发送钉钉，等待大和确认。',
        context,
        suggestion: reply,
      });
      markCooldown(state, key, CONFIG.skipCooldownMs, 'deferred');
      saveState(state);
      return finish({ action: 'deferred', reply, reason: 'semi_auto', deepseekDecision });
    }

    if (typeof send !== 'function') {
      return finish({ action: 'reply_ready', reply, reason: 'no_sender_callback', deepseekDecision });
    }

    const assetPaths = buildReplyAssetPaths({
      content: plainContent || currentContent,
      context: contextStr,
      reply,
      decision: deepseekDecision,
    });
    const sendResult = await Promise.resolve(send({
      reply,
      msg: workingMsg,
      targetType,
      title,
      conversationId,
      assetPaths,
    }));
    if (botSendSucceeded(sendResult)) {
      markReplied(state, key);
      markConversationReply(state, targetType, conversationId);
      saveState(state);
      const history = loadHistory();
      history.push({ user: single.slice(0, 500), reply });
      saveHistory(history);
      return finish({
        action: 'reply',
        reply,
        reason: reason || 'sent',
        deepseekDecision,
        assets: assetPaths.map(file => path.basename(file)),
        sendResult,
      });
    }

    markCooldown(state, key, activeRateLimitSec * 1000, 'deferred');
    saveState(state);
    return finish({ action: 'deferred', reply, reason: 'send_failed', deepseekDecision, sendResult });
  }

  const drawerDividerMaterialReply = buildDrawerDividerMaterialReply(plainContent || currentContent);
  if (drawerDividerMaterialReply) {
    return sendAndRecord(
      drawerDividerMaterialReply,
      'local_drawer_divider_material_rule',
      'drawer_divider_material_rule'
    );
  }

  const ambiguousProductFactClarification = buildAmbiguousProductFactClarification(plainContent || currentContent, contextStr);
  if (ambiguousProductFactClarification) {
    return sendAndRecord(
      ambiguousProductFactClarification,
      'local_ambiguous_product_fact_clarification',
      '产品事实问题未唯一定位具体款式或规格，先澄清，禁止套用某一款参数。'
    );
  }

  const wardrobeDrawerDepthReply = buildWardrobeDrawerDepthReplyFromKnowledge(plainContent || currentContent);
  if (wardrobeDrawerDepthReply) {
    return sendAndRecord(
      wardrobeDrawerDepthReply,
      'local_wardrobe_drawer_depth_rule',
      '衣帽间抽屉深度固定公式与背板卡扣处理规则。'
    );
  }

  const magicDrawerSingleDoorWidthReply = buildMagicDrawerSingleDoorWidthReplyFromKnowledge(plainContent || currentContent);
  if (magicDrawerSingleDoorWidthReply) {
    return sendAndRecord(
      magicDrawerSingleDoorWidthReply,
      'local_magic_drawer_single_door_width_rule',
      '魔法抽单开门标品最大550柜；600柜及以上无标品，如有需要走定制。'
    );
  }

  // 带“柜宽 + 单开门”的问法是尺寸计算，不能让泛化的标品参数口径抢先返回。
  const magicDrawerParameterReply = buildMagicDrawerParameterReplyFromKnowledge(plainContent || currentContent);
  if (magicDrawerParameterReply) {
    return sendAndRecord(
      magicDrawerParameterReply,
      'local_magic_drawer_parameter_rule',
      '魔法抽通用参数规则：从产品知识卡读取标准宽度、标准深度或深度定制口径。'
    );
  }

  const drawerCustomizationReply = buildDrawerCustomizationReplyFromKnowledge(plainContent || currentContent, contextStr);
  if (drawerCustomizationReply) {
    return sendAndRecord(
      drawerCustomizationReply,
      'local_drawer_customization_rule',
      '抽屉定制能力与深度计算：从产品知识卡读取明确口径，并按轨道范围计算。'
    );
  }

  const drawerWidthReply = buildDrawerWidthRuleReply(plainContent || currentContent, contextStr);
  if (drawerWidthReply) {
    return sendAndRecord(
      drawerWidthReply,
      'local_drawer_width_rule',
      '抽屉宽度规则：从知识库 MD 读取魔法抽扣尺公式并计算。'
    );
  }

  const railSpecificationReply = buildRailSpecificationReplyFromKnowledge(plainContent || currentContent);
  if (railSpecificationReply) {
    return sendAndRecord(railSpecificationReply, 'local_rail_specification_rule', '轨道规格规则：从产品知识卡确认规格存在性，不作为库存查询。');
  }

  const installationDimensionsReply = buildInstallationDimensionsReplyFromKnowledge(plainContent || currentContent);
  if (installationDimensionsReply) {
    return sendAndRecord(
      installationDimensionsReply,
      'local_installation_dimensions_rule',
      '安装尺寸规则：从知识库 MD 中与产品图片同卡的尺寸表生成回复。'
    );
  }

  const spiceDrawerInstallationReply = buildSpiceDrawerInstallationReplyFromKnowledge(plainContent || currentContent);
  if (spiceDrawerInstallationReply) {
    return sendAndRecord(
      spiceDrawerInstallationReply,
      'local_spice_drawer_installation_rule',
      '调料整抽安装规则：从产品知识卡读取柜内净高与净深要求，不依赖 Dify 检索命中。'
    );
  }

  const knownInstallationReply = buildKnownInstallationCardReplyFromKnowledge(plainContent || currentContent);
  if (knownInstallationReply) {
    return sendAndRecord(knownInstallationReply, 'local_known_installation_card_rule', '精确安装卡规则：从对应产品极限安装知识卡读取尺寸，不依赖 Dify 检索命中。');
  }

  const localImageReply = buildProductImageRuleReply(plainContent || currentContent, contextStr);
  if (localImageReply) {
    return sendAndRecord(localImageReply, 'local_product_image_rule', '产品图片规则：用户明确要产品图片或参考图。');
  }

  const installRuleReply = buildInstallTutorialRuleReply(plainContent || currentContent, contextStr);
  if (installRuleReply) {
    return sendAndRecord(installRuleReply, 'local_install_tutorial_rule', '安装教程规则：有明确安装说明书则发送资料；没有明确安装说明书则发送微信视频号口径。');
  }

  const productIntroductionReply = buildProductIntroductionReplyFromKnowledge(plainContent || currentContent);
  if (productIntroductionReply) {
    return sendAndRecord(
      productIntroductionReply,
      'local_product_introduction_rule',
      '产品介绍话术：从规划师话术 MD 读取对应产品的标准介绍，不依赖 Dify 检索命中。'
    );
  }

  const ambiguousProductClarification = buildAmbiguousProductClarification(plainContent || currentContent, contextStr);
  if (ambiguousProductClarification) {
    return sendAndRecord(
      ambiguousProductClarification,
      'local_ambiguous_product_clarification',
      '产品介绍请求未唯一定位具体产品，先澄清，禁止让模型混合多个产品自由生成。'
    );
  }

  if (looksLikeDesignOrImageRequiredQuestion(plainContent || currentContent)) {
    markCooldown(state, key, CONFIG.skipCooldownMs, 'skipped');
    saveState(state);
    return finish({ action: 'skip', reason: 'design_or_site_image_question' });
  }

  if (shouldBlock(plainContent || currentContent) && shouldSkipReviewQueueForBlocked(plainContent || currentContent)) {
    markCooldown(state, key, CONFIG.skipCooldownMs, 'skipped');
    saveState(state);
    return finish({ action: 'skip', reason: 'customer_service_or_order_block' });
  }

  if (looksLikeProductPlatformOperationQuestion(plainContent || currentContent)) {
    markCooldown(state, key, CONFIG.skipCooldownMs, 'skipped');
    saveState(state);
    return finish({ action: 'skip', reason: 'product_platform_operation_question' });
  }

  const greetingReply = buildBusinessGreetingReply(plainContent || currentContent);
  if (greetingReply) {
    return sendAndRecord(greetingReply, 'business_greeting', '问候消息：主动介绍机器人可处理的产品服务范围。');
  }

  const contentForClassify = plainContent || currentContent || imageContext;
  const casualChat = !looksLikeProductQuestion(contentForClassify) &&
    !looksLikeCustomerServiceQuestion(contentForClassify) &&
    !shouldBlock(contentForClassify) &&
    !looksLikeDesignOrImageRequiredQuestion(contentForClassify);

  if (casualChat) {
    const casualPrompt = `你是酷太自动回复机器人，可以自然回复日常闲聊、问候、感谢和轻松交流。回复简洁友好，不冒充真人，不承诺订单、物流、售后、退款、报价或人工处理结果。必须使用纯文本。`;
    const casualReply = await callDeepSeekAI(casualPrompt, `聊天内容：${contentForClassify}`);
    if (casualReply && casualReply !== 'SKIP' && !replyLooksBad(casualReply)) {
      return sendAndRecord(casualReply, 'casual_chat', '闲聊消息正常回复。');
    }
    markCooldown(state, key, CONFIG.skipCooldownMs, 'skipped');
    saveState(state);
    return finish({ action: 'skip', reason: 'casual_chat_failed' });
  }

  const directReplyRule = targetType === 'direct' && CONFIG.relaxedDirectReplies
    ? '私聊口径可以放宽：只要问题明确指向酷太产品，且结合知识库、上下文、已有规则或常见产品逻辑基本可以判断，就直接回复。只有在产品型号、尺寸、配件、兼容性、安装条件等确实拿不准，或者可能误导对方时，才返回 REVIEW。'
    : '必须有100%把握且产品知识库里有明确、直接答案才可以回复。拿不准、知识库依据不足、可能讲错、需要大和确认时，只回 REVIEW: 原因: ... 建议: ...，系统会记录给大和确认，禁止发送给钉钉。';

  const systemPrompt = `你是大和，酷太用户体验部成员。在钉钉${targetType === 'group' ? `群「${title}」` : '机器人私聊'}中回复消息。

酷太产品问题按知识库回答：产品结构、尺寸、选型、安装、材质、承重、适配、资料发送等。尺寸、安装、极限、产品结构问题只能依据结构化产品事实与安装规则判断；营销话术、设计建议和空间方案只能在事实结论确定后做语气润色，禁止参与事实判断。日常闲聊、问候和感谢可以自然回复。
先通读所有消息理解话题。你现在只需要回复下面这一条消息，不要叠加重复回答旧问题。回复讲清楚，不限句数。必须用纯文本，禁止 Markdown 格式。禁止在回复中称呼、复述或@任何人的姓名、昵称、手机号或门店名；直接从结论开始。
${directReplyRule}
订单、物流、退款、财务、赔付、补发、换货结果、售后责任判断、设计方案、现场照片判断、已安装后的现场异常/摩擦柜门/运行卡滞/左右微调、没有明确尺寸的空间适配等非基础产品知识问题，不自动回复；如你认为后续可以建立规则，也返回 REVIEW 等待大和确认。
对“能否连门安装/这个能装吗/可以吗”这类短问，必须结合上文图片、上一条产品名称、型号或尺寸判断具体产品；如果上文能确认是水槽中枢阁/水槽侧拉中枢阁，回复不能连门安装；如果无法确认具体产品，只回 REVIEW 或 SKIP，禁止泛泛套用普通门板/反弹器口径。
明确问“极限安装/极限尺寸/安装宽度/安装深度/安装高度/安装孔位/孔位”的，优先引用 10A-极限安装.md；回复要给对应极限安装示意图文件名、孔位/极限尺寸 PDF 文件名和完整尺寸数据。若同一产品名有多套规格但问题未说明层数/规格，列出可能项让对方确认，不要只回泛泛口径。
问“实物图/产品图/参考图/效果图/有没有图片”的，优先发送产品图片；资料库已有图片时不要改成产品功能解释。
问“怎么安装/如何安装/安装教程/安装说明书/安装视频”的，优先发送对应安装说明书；如果没有明确安装说明书，只回复“安装教程在微信视频号搜：酷太新零售哦”。
不需要回复时只回SKIP。禁止说"我帮你查/稍后发"。
${imageContext ? '\n对方发了图片或上文有图片，识别结果附在消息中。只有当图片识别结果和文字里已有明确产品型号/尺寸/安装条件，且知识库有直接答案时才回复；现场方案、仅凭图片判断、没有尺寸的空间适配问题一律 SKIP 或 REVIEW，不要泛泛回复。' : ''}

===== 客服自动回复知识库 =====

${customerServiceKnowledge}

===== 产品知识库 =====

${buildPromptProductKnowledge(`${single}\n${contextStr}`)}`;

  let reply = await callAI(systemPrompt, `${targetType === 'group' ? '群聊' : '机器人私聊'}上下文:\n${contextStr.slice(-800)}\n\n请回复这条消息:\n${single}`);
  reply = sanitizeReplyAddressees(reply, formatted.map(item => item.sender));
  if (replyDeniesAvailableInstallationInfo(contentForClassify, reply)) {
    const knowledgeReply = buildInstallationDimensionsReplyFromKnowledge(contentForClassify);
    reply = knowledgeReply || 'REVIEW: 原因: 已匹配到安装示意图，但AI回答没有尺寸资料，文字与图片矛盾。 建议: 根据对应产品安装尺寸知识卡重写后发送。';
  }
  if (!parseReviewReply(reply) && reply !== 'SKIP' && looksLikeProductQuestion(contentForClassify)) {
    const evidenceValidation = validateReplyAgainstWiki(`${single}\n${contextStr}`, reply);
    if (!evidenceValidation.valid) {
      console.log(`[LLM Wiki校验] 回复含无证据事实: ${evidenceValidation.unsupported.join('、')}`);
      reply = `REVIEW: 原因: 候选回复包含无法在本次 LLM Wiki 证据页中核对的数字、型号或单位：${evidenceValidation.unsupported.join('、')}。 建议: 回查原始产品知识卡后重写。`;
    }
  }
  const invalidReply = /^(不需要回复|无需回复|SKIP|没有需要)/i;
  const review = parseReviewReply(reply);

  if (review) {
    if (shouldSkipReviewQueueForReview(workingMsg.content || '', review.reason, review.suggestion)) {
      markCooldown(state, key, CONFIG.skipCooldownMs, 'skipped');
      saveState(state);
      return finish({ action: 'skip', reason: 'review_customer_service_block', review });
    }
    if (CONFIG.pendingReviewMode) {
      const pending = queuePendingReply(state, key, {
        source: `${source}-待确认`,
        targetType,
        title,
        conversationId,
        sender: workingMsg.sender,
        senderUserId: workingMsg.senderUserId || '',
        senderOpenDingTalkId: workingMsg.senderOpenDingTalkId || '',
        messageTime: workingMsg.time || '',
        content: workingMsg.content,
        context,
        reason: `AI返回 REVIEW：${review.reason}`,
        deepseekSuggestion: review.suggestion,
        deepseekDecision: 'review',
      });
      return finish({ action: 'queued', reason: 'ai_review', pendingId: pending.id, review });
    }
    appendReviewQueue({
      source,
      title,
      sender: workingMsg.sender,
      content: workingMsg.content,
      reason: review.reason,
      context,
      suggestion: review.suggestion,
    });
    markCooldown(state, key, CONFIG.skipCooldownMs, 'skipped');
    saveState(state);
    return finish({ action: 'review', reason: 'ai_review', review });
  }

  if (!reply || reply === 'SKIP' || reply.trim().length < 2 || invalidReply.test(reply.trim())) {
    if (looksLikeProductQuestion(contentForClassify) && !isMediaMessage(contentForClassify) && !shouldBlock(contentForClassify)) {
      reply = buildClarifyReply(contentForClassify, contextStr);
      if (!reply && shouldForceReviewOnSkip(contentForClassify)) {
        const reason = '产品尺寸/结构确认类问题被AI判成SKIP。该类问题不允许静默跳过，需由大和确认是否可直接形成标准口径。';
        appendReviewQueue({
          source,
          title,
          sender: workingMsg.sender,
          content: workingMsg.content,
          reason,
          context,
          suggestion: '请确认这条尺寸/结构问题的标准回复口径；如知识库已有明确答案，后续应直接自动回复。',
        });
        markCooldown(state, key, CONFIG.skipCooldownMs, 'skipped');
        saveState(state);
        return finish({ action: 'review', reason: 'skip_force_review' });
      }
    }
    if (!reply) {
      markCooldown(state, key, CONFIG.skipCooldownMs, 'skipped');
      saveState(state);
      return finish({ action: 'skip', reason: 'ai_skip' });
    }
  }

  if (replyLooksBad(reply)) {
    if (CONFIG.pendingReviewMode) {
      const pending = queuePendingReply(state, key, {
        source: `${source}-回复待修`,
        targetType,
        title,
        conversationId,
        sender: workingMsg.sender,
        senderUserId: workingMsg.senderUserId || '',
        senderOpenDingTalkId: workingMsg.senderOpenDingTalkId || '',
        messageTime: workingMsg.time || '',
        content: workingMsg.content,
        context,
        reason: 'AI给出了候选回复，但命中质量拦截，需要Codex重写后再决定是否发送。',
        deepseekSuggestion: reply,
        deepseekDecision: 'bad_reply',
      });
      return finish({ action: 'queued', reason: 'bad_reply', pendingId: pending.id, reply });
    }
    markCooldown(state, key, CONFIG.skipCooldownMs, 'skipped');
    saveState(state);
    return finish({ action: 'skip', reason: 'bad_reply', reply });
  }

  return sendAndRecord(reply, 'reply', 'AI判断可回复。');
}

let engineReady = false;

async function ensureEngineReady() {
  if (engineReady) return;
  loadCurrentUser();
  loadProductKnowledge();
  loadCustomerServiceKnowledge();
  if (!hasUsableAiProvider()) {
    throw new Error('缺少可用 AI 配置：Dify 模式需要 DIFY_API_KEY；DeepSeek 模式需要 AI_API_KEY。');
  }
  engineReady = true;
}

// ====== 启动 ======
function hasUsableAiProvider() {
  if (CONFIG.aiProvider === 'deepseek') return Boolean(CONFIG.aiKey);
  if (CONFIG.aiProvider === 'dify') return Boolean(CONFIG.difyApiKey) || (CONFIG.difyFallbackToDeepSeek && Boolean(CONFIG.aiKey));
  if (CONFIG.aiProvider === 'auto') return Boolean(CONFIG.difyApiKey || CONFIG.aiKey);
  return false;
}

async function main() {
  console.log('='.repeat(46));
  console.log('  钉钉群消息 AI 自动回复服务');
  console.log('='.repeat(46));
  console.log(`  AI Provider: ${CONFIG.aiProvider}`);
  console.log(`  DeepSeek: ${CONFIG.aiModel}`);
  if (CONFIG.aiProvider === 'dify' || CONFIG.aiProvider === 'auto') {
    console.log(`  Dify: ${CONFIG.difyAppType} ${difyEndpoint()}`);
    console.log(`  Dify失败回退DeepSeek: ${CONFIG.difyFallbackToDeepSeek ? '开启' : '关闭'}`);
  }
  console.log(`  轮询: 每 ${CONFIG.pollInterval / 1000}s`);
  console.log(`  过滤自己: ${CONFIG.skipSelf}`);
  console.log(`  群回复: ${CONFIG.enableGroupReplies ? '开启' : '关闭'}`);
  console.log(`  私信回复: ${CONFIG.enableDirectReplies ? '开启' : '关闭'}`);
  console.log(`  员工名单过滤: ${(CONFIG.filterEmployeeSenders || CONFIG.botSkipEmployeeSenders) ? '开启' : '关闭'}`);
  console.log(`  HQ名单过滤: ${CONFIG.filterHQSenders ? '开启' : '关闭'}`);
  console.log(`  私信口径: ${CONFIG.relaxedDirectReplies ? '宽松' : '严格'}`);
  console.log(`  半自动: ${CONFIG.semiAutoMode ? '开启（只记录建议，不发送钉钉）' : '关闭'}`);
  console.log(`  待回复队列: ${CONFIG.pendingReviewMode ? '开启（AI扫描入队，Codex审核发送）' : '关闭'}`);
  console.log(`  图片识别: ${isDoubaoVisionReady() ? `开启（${DOUBAO_CONFIG.model}）` : '关闭/未配置'}`);
  console.log('='.repeat(46));

  loadCurrentUser();
  loadProductKnowledge();
  loadCustomerServiceKnowledge();
  if (!hasUsableAiProvider()) {
    throw new Error('缺少可用 AI 配置：Dify 模式需要 DIFY_API_KEY；DeepSeek 模式需要 AI_API_KEY。');
  }
  if (CONFIG.aiProvider === 'dify' && !CONFIG.difyApiKey && CONFIG.difyFallbackToDeepSeek) {
    console.log('[AI] 当前未配置 DIFY_API_KEY，将临时回退 DeepSeek。');
  }
  console.log('\n开始轮询 (Ctrl+C 停止)...\n');

  let isPolling = false;
  const pollLoop = async () => {
    if (isPolling) {
      console.log('[轮询] 上一轮尚未结束，本轮跳过');
      setTimeout(pollLoop, CONFIG.pollInterval);
      return;
    }

    isPolling = true;
    try {
      await poll();
    } catch (e) {
      console.error('[轮询] 执行失败:', e.message);
    } finally {
      isPolling = false;
      setTimeout(pollLoop, CONFIG.pollInterval);
    }
  };

  await pollLoop();
}

module.exports = {
  CONFIG,
  appendBotAudit,
  ensureEngineReady,
  loadState,
  saveState,
  processSingleMessageForAutoReply,
  normalizeReviewText,
  sanitizeReplyAddressees,
  classifyContextualBusinessFlow,
  analyzeConversationContext,
  selectRecentContextMessages,
  looksLikeInstallationRelatedQuestion,
  findInstallationReferenceImages,
  findFamilyInstallationImages,
  findIndexedProductImages,
  buildReplyAssetPaths,
  looksLikeDrawerWidthCalculationQuestion,
  buildDrawerWidthRuleReply,
  buildInstallationDimensionsReplyFromKnowledge,
  buildSpiceDrawerInstallationReplyFromKnowledge,
  buildKnownInstallationCardReplyFromKnowledge,
  buildRailSpecificationReplyFromKnowledge,
  buildProductIntroductionReplyFromKnowledge,
  buildAmbiguousProductClarification,
  buildAmbiguousProductFactClarification,
  buildMagicDrawerParameterReplyFromKnowledge,
  buildMagicDrawerSingleDoorWidthReplyFromKnowledge,
  buildWardrobeDrawerDepthReplyFromKnowledge,
  buildDrawerCustomizationReplyFromKnowledge,
  extractReplyEvidenceTokens,
  validateReplyAgainstWiki,
  looksLikeProductQuestion,
  looksLikeOrderConfigurationQuestion,
  looksLikeDiscontinuedLegacySeriesAfterSalesQuestion,
  looksLikeDrawerDividerMaterialQuestion,
  buildDrawerDividerMaterialReply,
  processMessageImages,
  buildPriorImageContextForShortQuestion,
  getSpecificProductAnchors,
  assessContextResolution,
  needsProductConfirmationForCabinetDepthInstallation,
  describeDecisionReason,
  looksLikeProductPlatformOperationQuestion,
  isEmployeeSender,
  getProductKnowledgeRetrievalPolicy,
  buildPromptProductKnowledge,
  replyDeniesAvailableInstallationInfo,
};

if (IS_MAIN) {
  main().catch(e => { console.error(e); process.exit(1); });
}
