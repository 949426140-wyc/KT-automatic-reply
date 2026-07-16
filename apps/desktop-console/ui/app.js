const state = {
  status: null,
  logs: null,
};

const $ = (id) => document.getElementById(id);

function setNotice(text, type = 'idle') {
  const el = $('actionNotice');
  if (!el) return;
  el.textContent = text;
  el.dataset.type = type;
}

function setPill(cardId, ok, warnText = '异常') {
  const pill = document.querySelector(`#${cardId} .pill`);
  if (!pill) return;
  pill.dataset.status = ok ? 'ok' : 'bad';
  pill.textContent = ok ? '正常' : warnText;
}

function setCheck(id, ok, warn = false) {
  const el = $(id);
  if (!el) return;
  el.classList.remove('ok', 'warn', 'bad');
  el.classList.add(ok ? 'ok' : warn ? 'warn' : 'bad');
}

function formatTime(value) {
  if (!value) return '--';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function actionName(action) {
  return {
    'start-bot': '启动机器人',
    'stop-bot': '关闭机器人',
    'start-all': '启动服务',
    selftest: '自测试',
  }[action] || action;
}

function qaReplyState(item) {
  if (item.replyState === 'replied' || item.replied === true) return 'replied';
  if (item.replyState === 'unreplied' || item.replied === false) return 'unreplied';
  const status = String(item.status || '').toLowerCase();
  return ['reply', 'sent', 'success'].includes(status) ? 'replied' : 'unreplied';
}

function qaStatusText(item, replyState) {
  if (replyState === 'replied') return '已回复';
  const status = String(item.status || '').toLowerCase();
  if (status === 'queued') return '待审核 · 未回复';
  if (status === 'deferred') return '发送失败 · 未回复';
  if (status === 'skip') return '已跳过 · 未回复';
  if (status === 'reply_ready') return '待发送 · 未回复';
  return '未回复';
}

function qaReasonText(reason) {
  const raw = String(reason || '').trim();
  const known = {
    bad_reply: '候选回复命中本地质量过滤，未发送',
    ai_skip: '模型判定为 SKIP，没有生成可发送回复',
    pending_review: '当前为待审核模式，尚未发送',
    customer_service_or_order_block: '订单、物流、售后或流程类问题被本地规则过滤',
    review_customer_service_block: '客服或流程类问题已转人工处理',
    not_product_question: '未识别为可自动回答的产品问题',
    design_or_site_image_question: '需要结合现场、图片或设计条件判断',
    send_failed: '调用钉钉发送接口失败',
    rate_limited: '触发回复频率限制，暂未发送',
    semi_auto: '半自动模式仅记录候选回复，没有发送',
  };
  return known[raw] || raw || '未记录具体原因';
}

function renderStatus(data) {
  state.status = data;
  $('timestamp').textContent = `最后刷新：${formatTime(data.generatedAt)}`;

  const wikiOk = Boolean(data.wiki?.exists && data.wiki?.generatedAt);
  setPill('wikiCard', wikiOk, '未建立');
  $('wikiUpdatedAt').textContent = wikiOk ? formatTime(data.wiki.generatedAt) : '--';
  const counts = data.wiki?.counts || {};
  const countText = data.wiki?.pageCount ? `${data.wiki.pageCount} 页` : '0 页';
  $('wikiMeta').textContent = wikiOk
    ? `索引最近生效时间 · ${countText}（事实 ${counts.fact || 0} / 应用 ${counts.application || 0} / 规划 ${counts.planning || 0}）`
    : '未找到 LLM Wiki 索引';

  const aiOk = data.config?.deepseekKey === '已配置';
  setPill('aiCard', aiOk, '待配置');
  $('aiModel').textContent = data.config?.aiModel || '--';

  const botExists = Boolean(data.services?.bot?.exists);
  const botRunning = data.services?.bot?.status === 'running';
  setPill('botCard', botRunning, botExists ? '停止' : '未创建');
  $('botStatus').textContent = botExists ? data.services.bot.status : '未启动';

  const visionOk = data.config?.visionEnabled && data.config?.visionKey === '已配置';
  setPill('visionCard', visionOk, '待配置');
  $('visionModel').textContent = data.config?.visionModel || '--';

  $('pendingMode').textContent = data.config?.pendingReview ? '开启，回复先入队' : '关闭，可能直接发送';
  $('packageInfo').textContent = data.source?.exists
    ? `源码仓库：已就绪，${formatTime(data.source.mtime)}`
    : '源码仓库：未找到';

  setCheck('dockerCheck', data.docker?.cli);
  $('dockerText').textContent = data.docker?.cli ? '已找到' : '未找到';

  setCheck('wikiCheck', wikiOk, !wikiOk);
  $('wikiText').textContent = wikiOk ? `已更新 ${formatTime(data.wiki.generatedAt)}` : '需检查';

  const deepseekKeyOk = data.config?.deepseekKey === '已配置';
  const visionKeyOk = data.config?.visionKey === '已配置';
  setCheck('keyCheck', deepseekKeyOk && visionKeyOk, !visionKeyOk);
  $('keyText').textContent = `DeepSeek ${data.config?.deepseekKey || '--'} / 视觉${data.config?.visionKey || '--'}`;
}

function renderLogs(data) {
  state.logs = data;
  const content = data.bot || data.audit || '暂无运行日志';
  $('logBox').textContent = content;
  renderQa(data.qa || []);
}

function renderQa(items) {
  const list = $('qaList');
  $('qaCount').textContent = items.length;

  if (!items.length) {
    list.innerHTML = `
      <div class="qa-item empty">
        当前还没有问答记录。机器人收到钉钉消息、生成建议或写入待审核队列后，会实时显示在这里。
      </div>
    `;
    return;
  }

  list.innerHTML = items.map((item) => {
    const title = item.sender || item.title || '未知用户';
    const meta = [formatTime(item.timestamp), item.title].filter(Boolean).join(' ｜ ');
    const question = item.question || item.reason || '无消息内容';
    const answer = item.answer || '';
    const replyState = qaReplyState(item);
    const statusText = qaStatusText(item, replyState);
    const unrepliedReason = qaReasonText(item.reason);
    const answerLabel = replyState === 'replied'
      ? '<span class="qa-answer-label">答：</span>'
      : `<span class="qa-answer-label">答<span class="qa-answer-warning" tabindex="0" aria-label="未回复原因：${escapeHtml(unrepliedReason)}" data-tooltip="未回复原因：${escapeHtml(unrepliedReason)}">!</span>：</span>`;
    const answerText = answer || (replyState === 'unreplied' ? '未生成可发送回复' : '');
    return `
      <article class="qa-item ${replyState}">
        <div class="qa-head">
          <div>
            <div class="qa-title">${escapeHtml(title)}</div>
            <div class="qa-meta">${escapeHtml(meta)}</div>
          </div>
          <span class="qa-status ${replyState}">${escapeHtml(statusText)}</span>
        </div>
        <div class="qa-text">问：${escapeHtml(question)}</div>
        <div class="qa-text qa-answer ${replyState}">${answerLabel}<span>${escapeHtml(answerText)}</span></div>
      </article>
    `;
  }).join('');
}

async function refresh() {
  $('timestamp').textContent = '正在刷新...';
  const [status, logs] = await Promise.all([
    fetch('/api/status').then((res) => res.json()),
    fetch('/api/logs').then((res) => res.json()).catch(() => ({ audit: '', qa: [] })),
  ]);
  renderStatus(status);
  renderLogs(logs);
}

async function runAction(button) {
  const action = button.dataset.action;
  const span = button.querySelector('span');
  const small = button.querySelector('small');
  const oldText = button.textContent;
  const oldSmall = small?.textContent || button.dataset.defaultSmall || '';

  button.disabled = true;
  button.classList.add('disabled');
  setNotice(`${actionName(action)}执行中...`, 'busy');
  if (small) small.textContent = '执行中...';
  else button.textContent = '执行中...';

  try {
    const result = await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    }).then((res) => res.json());
    $('logBox').textContent = result.output || result.message || JSON.stringify(result, null, 2);
    await refresh();
    setNotice(result.ok ? `${actionName(action)}成功` : `${actionName(action)}失败`, result.ok ? 'ok' : 'bad');
  } catch (error) {
    $('logBox').textContent = `操作失败：${error.message}`;
    setNotice(`${actionName(action)}失败：${error.message}`, 'bad');
  } finally {
    button.disabled = false;
    button.classList.remove('disabled');
    if (span && small) small.textContent = button.dataset.defaultSmall || oldSmall;
    else button.textContent = oldText;
  }
}

$('refreshButton').addEventListener('click', refresh);
document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', () => runAction(button));
});

refresh();
setInterval(refresh, 8000);
