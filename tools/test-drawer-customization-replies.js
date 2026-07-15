const bot = require('../auto-reply');

const cases = [
  ['140的内衣抽深度可以定制吗', /支持深度定制.*460mm.*510mm.*450mm轨道.*500mm轨道/],
  ['内衣抽深度480可以做吗', /仅可做460mm或510mm/],
  ['定制的四代碗碟半抽能不能碗碟位置互换一下', /支持定制.*位置可以互换/],
  ['停机坪尺寸现在可以定制吗', /不支持.*定制/],
  ['倾松抽有定制款吗？深度需要更改', /属于标品.*不是定制款.*固定的480mm.*极限安装深度500mm.*挂钩深度20mm.*485mm.*深度不支持更改定制/],
  ['问下尚酷的可以做切角抽吗', /不支持切角抽定制/],
  ['抽屉深度可以做240吗', /240mm.*不能做.*255mm/],
  ['请问130H分隔抽（600柜）无门，下哪款？双开定制吗？', /600柜连门定制.*不是双开门定制/],
  ['鞋抽定制，宽度是柜内净宽减36*2吗', /柜内净宽-36×2/],
  ['之行阁的这个横条可以拆吗', /可拆卸三节轨.*其他需要.*拆卸分离/],
  ['之行阁抽屉因为搬运需要拆下来，可以吗', /可拆卸三节轨.*其他需要.*拆卸分离/],
  ['衣柜深度460可以装我们的衣帽间抽屉吗', /460mm抽屉深度配450mm轨道.*背板.*卡扣.*打孔.*轻度不可逆/],
  ['衣帽抽用500轨道，抽屉做多深', /500mm轨道对应510mm抽屉深度.*不走连续深度范围或其他特殊定制/],
  ['衣帽抽抽屉深度485可以做吗', /485mm需要475mm轨道.*只用450mm或500mm轨道.*不能按485mm特殊定制/],
  ['70H 魔法空抽没有 600 柜单开门的吗？', /600-18×2.*-11×2.*-25.*517mm.*没有标品.*走定制/],
];

async function main() {
  await bot.ensureEngineReady();
  const results = [];
  for (let index = 0; index < cases.length; index += 1) {
    const [content, expected] = cases[index];
    const msg = { id: `drawer-customization-${index}`, sender: '离线回归测试', time: new Date().toISOString(), content };
    const decision = await bot.processSingleMessageForAutoReply({
      state: { repliedMsgs: {} }, msg, messages: [msg], title: '抽屉定制离线回归测试',
      conversationId: `drawer-customization-${index}`, targetType: 'direct', sourcePrefix: '只读回归测试',
    });
    const passed = decision.action === 'reply_ready' && expected.test(decision.reply || '');
    results.push({ content, passed, action: decision.action, reason: decision.reason, reply: decision.reply || '' });
  }

  const followUpMessages = [
    { id: 'divider-first', sender: '离线回归测试', time: new Date(Date.now() - 2000).toISOString(), content: '130H分隔抽（600柜）无门，定制什么尺寸' },
    { id: 'divider-bot-reply', sender: '酷太自动回复机器人', time: new Date(Date.now() - 1000).toISOString(), content: '无门是指不装独立柜门，按连门安装方式下单；选择600柜连门定制，不是双开门定制。' },
  ];
  const followUp = { id: 'divider-follow-up', sender: '离线回归测试', time: new Date().toISOString(), content: '尺寸是多少？' };
  const followUpDecision = await bot.processSingleMessageForAutoReply({
    state: { repliedMsgs: {} }, msg: followUp, messages: [...followUpMessages, followUp],
    title: '抽屉上下文离线回归测试', conversationId: 'drawer-context-follow-up', targetType: 'group', sourcePrefix: '只读回归测试',
  });
  results.push({
    content: '130H分隔抽连续追问尺寸',
    passed: followUpDecision.action === 'reply_ready' && /W542×D480×H130mm.*600-18×2.*11×2.*542mm/.test(followUpDecision.reply || ''),
    action: followUpDecision.action,
    reason: followUpDecision.reason,
    reply: followUpDecision.reply || '',
  });

  console.log(JSON.stringify(results, null, 2));
  if (results.some(item => !item.passed)) process.exit(1);
}

main().catch(error => { console.error(error); process.exit(1); });
