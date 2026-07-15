const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const path = require('path');
const fs = require('fs');
const { DWClient, TOPIC_ROBOT } = require('dingtalk-stream');
const { ConversationHistoryStore } = require('./lib/conversation-history');

try { require('dotenv').config({ path: path.join(__dirname, '.env') }); } catch (e) {}

const {
  CONFIG: ENGINE_CONFIG,
  appendBotAudit,
  ensureEngineReady,
  loadState,
  processSingleMessageForAutoReply,
  normalizeReviewText,
} = require('./auto-reply');

const CONFIG = {
  connectMode: (process.env.DINGTALK_CONNECT_MODE || 'stream').toLowerCase(),
  appKey: process.env.DINGTALK_APP_KEY || process.env.DINGTALK_CLIENT_ID || '',
  appSecret: process.env.DINGTALK_APP_SECRET || process.env.DINGTALK_CLIENT_SECRET || '',
  robotCode: process.env.DINGTALK_ROBOT_CODE || '',
  port: parseInt(process.env.PORT || process.env.BOT_PORT || '3000', 10),
  groupOnlyAt: process.env.BOT_GROUP_ONLY_AT !== 'false',
  maxMessageAgeMs: parseInt(process.env.BOT_MAX_MESSAGE_AGE_MIN || '5', 10) * 60 * 1000,
  streamDebug: process.env.DINGTALK_STREAM_DEBUG === 'true',
  conversationContextTtlMs: parseInt(process.env.CONVERSATION_CONTEXT_TTL_MIN || '30', 10) * 60 * 1000,
  conversationContextMaxMessages: parseInt(process.env.CONVERSATION_CONTEXT_MAX_MESSAGES || '16', 10),
};

const HUMAN_REQUIRED_REPLY = process.env.HUMAN_REQUIRED_REPLY || '这个问题请联系人工处理。';
const SILENT_SKIP_REASONS = new Set([
  'message_too_old',
  'group_not_at_robot',
]);

function shouldSendHumanFallback(decision) {
  if (!decision || decision.action === 'reply') return false;
  const reason = String(decision.reason || 'unknown');
  if (SILENT_SKIP_REASONS.has(reason) || reason.startsWith('duplicate_')) return false;
  return ['skip', 'review', 'queued', 'deferred'].includes(decision.action);
}

const PID_FILE = path.join(__dirname, 'bot-reply.pid');
try {
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');
} catch (e) {
  console.warn(`[Robot] PID 写入失败: ${e.message}`);
}

let accessToken = null;
let tokenExpireAt = 0;
let oapiAccessToken = null;
let oapiTokenExpireAt = 0;
const conversationHistory = new ConversationHistoryStore({
  filePath: path.join(process.env.RUNTIME_DIR || path.join(__dirname, 'runtime'), 'conversation-history.json'),
  ttlMs: CONFIG.conversationContextTtlMs,
  maxMessages: CONFIG.conversationContextMaxMessages,
});
let streamClient = null;

function nowIso() {
  return new Date().toISOString();
}

function normalizeCreateTime(body) {
  const raw = body.createAt || body.createTime || body.timestamp || body.msgCreateTime || Date.now();
  const n = Number(raw);
  if (Number.isFinite(n)) {
    return n < 10_000_000_000 ? n * 1000 : n;
  }
  const parsed = new Date(raw).getTime();
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function asBool(value) {
  if (value === true) return true;
  if (value === false) return false;
  return /^(true|1|yes)$/i.test(String(value || '').trim());
}

function extractText(body) {
  const candidates = [
    body.text?.content,
    body.content?.text,
    body.content,
    body.msgContent,
    body.message?.text,
    body.message,
  ];
  for (const item of candidates) {
    if (typeof item === 'string' && item.trim()) return item.trim();
  }
  return '';
}

function extractOriginalImageDownloadCode(body) {
  const sources = [body, body.content, body.message, body.text]
    .filter(item => item && typeof item === 'object');
  for (const source of sources) {
    for (const key of ['downloadCode', 'pictureDownloadCode']) {
      const value = source[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return '';
}

function inferTargetType(body) {
  const raw = String(body.conversationType || body.chatType || body.scene || '').toLowerCase();
  if (raw === '1' || raw.includes('single') || raw.includes('private') || raw.includes('oto')) return 'direct';
  if (body.sessionWebhook || raw === '2' || raw.includes('group')) return 'group';
  return body.senderStaffId || body.senderId ? 'direct' : 'group';
}

function messageWasAtRobot(body, text) {
  if (asBool(body.isInAtList) || asBool(body.isAt)) return true;
  if (Array.isArray(body.atUsers) && body.atUsers.length > 0) return true;
  if (Array.isArray(body.atUserIds) && body.atUserIds.length > 0) return true;
  if (/@/.test(text || '') && /(酷太|机器人|自动回复|AI|大和)/i.test(text || '')) return true;
  return false;
}

function normalizeInboundMessage(body) {
  const originalText = extractText(body);
  const downloadCode = extractOriginalImageDownloadCode(body);
  const text = originalText || (downloadCode ? '[图片消息]' : '');
  const ts = normalizeCreateTime(body);
  const targetType = inferTargetType(body);
  const title = body.conversationTitle || body.title || (targetType === 'group' ? '钉钉群聊' : '机器人私聊');
  const conversationId = body.conversationId || body.openConversationId || body.chatbotCorpId || title;
  const sender = body.senderNick || body.senderName || body.senderStaffId || body.senderId || body.userId || '未知';
  const id = body.msgId || body.openMessageId || body.messageId || `bot|${conversationId}|${sender}|${ts}|${text.slice(0, 40)}`;
  const msgType = body.msgtype || body.msgType || (text ? 'text' : 'unknown');

  return {
    raw: body,
    msgType,
    targetType,
    title,
    conversationId,
    sessionWebhook: body.sessionWebhook || '',
    robotCode: body.robotCode || CONFIG.robotCode,
    isAtRobot: messageWasAtRobot(body, text),
    ageMs: Date.now() - ts,
    msg: {
      id,
      sender,
      senderUserId: body.senderStaffId || body.senderUserId || body.userId || '',
      senderOpenDingTalkId: body.senderId || body.senderOpenDingTalkId || '',
      content: text,
      time: new Date(ts).toISOString(),
      createTime: new Date(ts).toISOString(),
      downloadCode,
      pictureDownloadCode: downloadCode,
      robotCode: body.robotCode || CONFIG.robotCode,
      raw: body,
    },
  };
}

async function getAccessToken() {
  if (!CONFIG.appKey || !CONFIG.appSecret) {
    throw new Error('缺少 DINGTALK_APP_KEY / DINGTALK_APP_SECRET，无法通过机器人 API 发送私聊消息。');
  }
  if (accessToken && Date.now() < tokenExpireAt) return accessToken;

  const resp = await axios.post('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
    appKey: CONFIG.appKey,
    appSecret: CONFIG.appSecret,
  }, { timeout: 15000 });

  accessToken = resp.data.accessToken;
  tokenExpireAt = Date.now() + Math.max((resp.data.expireIn || 7200) - 60, 60) * 1000;
  console.log('[DingTalk] AccessToken 已更新');
  return accessToken;
}

async function getOapiAccessToken() {
  if (!CONFIG.appKey || !CONFIG.appSecret) {
    throw new Error('缺少 DINGTALK_APP_KEY / DINGTALK_APP_SECRET，无法上传图片。');
  }
  if (oapiAccessToken && Date.now() < oapiTokenExpireAt) return oapiAccessToken;

  const resp = await axios.get('https://oapi.dingtalk.com/gettoken', {
    params: { appkey: CONFIG.appKey, appsecret: CONFIG.appSecret },
    timeout: 15000,
  });
  if (resp.data?.errcode !== 0 || !resp.data?.access_token) {
    throw new Error(`钉钉媒体 Token 获取失败: ${resp.data?.errmsg || resp.data?.errcode || '未知错误'}`);
  }
  oapiAccessToken = resp.data.access_token;
  oapiTokenExpireAt = Date.now() + Math.max((resp.data.expires_in || 7200) - 60, 60) * 1000;
  console.log('[DingTalk] 媒体 AccessToken 已更新');
  return oapiAccessToken;
}

async function uploadImageToDingTalk(localPath) {
  if (!localPath || !fs.existsSync(localPath)) {
    throw new Error(`安装示意图不存在: ${localPath || '(空路径)'}`);
  }
  const stats = fs.statSync(localPath);
  if (stats.size > 20 * 1024 * 1024) {
    throw new Error(`安装示意图超过 20MB: ${path.basename(localPath)}`);
  }

  const token = await getOapiAccessToken();
  const form = new FormData();
  form.append('media', fs.createReadStream(localPath), {
    filename: path.basename(localPath),
    contentType: path.extname(localPath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg',
  });
  const resp = await axios.post('https://oapi.dingtalk.com/media/upload', form, {
    params: { access_token: token, type: 'image' },
    headers: form.getHeaders(),
    timeout: 60000,
    maxBodyLength: Infinity,
  });
  if (resp.data?.errcode && resp.data.errcode !== 0) {
    throw new Error(`图片上传失败: ${resp.data.errmsg || resp.data.errcode}`);
  }
  const mediaId = resp.data?.media_id;
  if (!mediaId) throw new Error('图片上传成功但未返回 media_id');
  return mediaId;
}

async function sendImageByRobot(inbound, localPath) {
  const mediaId = await uploadImageToDingTalk(localPath);
  const token = await getAccessToken();
  const robotCode = inbound.robotCode || CONFIG.robotCode || CONFIG.appKey;
  if (!robotCode) throw new Error('缺少机器人 RobotCode，无法发送图片消息。');

  const isGroup = inbound.targetType === 'group';
  const endpoint = isGroup
    ? 'https://api.dingtalk.com/v1.0/robot/groupMessages/send'
    : 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend';
  const body = {
    robotCode,
    msgKey: 'sampleImageMsg',
    msgParam: JSON.stringify({ photoURL: mediaId }),
  };
  if (isGroup) {
    if (!inbound.conversationId) throw new Error('缺少 openConversationId，无法向群聊发送图片。');
    body.openConversationId = inbound.conversationId;
  } else {
    if (!inbound.msg.senderUserId) throw new Error('缺少 senderStaffId/userId，无法向单聊发送图片。');
    body.userIds = [inbound.msg.senderUserId];
  }

  const resp = await axios.post(endpoint, body, {
    headers: { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' },
    timeout: 20000,
  });
  console.log(`[DingTalk] 安装示意图发送成功: ${path.basename(localPath)}`);
  return { success: true, status: resp.status, data: resp.data, file: path.basename(localPath) };
}

async function sendBySessionWebhook(sessionWebhook, text) {
  if (!sessionWebhook) throw new Error('缺少 sessionWebhook，无法回复群机器人消息。');
  const resp = await axios.post(sessionWebhook, {
    msgtype: 'markdown',
    markdown: { title: '酷太自动回复', text },
  }, { timeout: 15000 });
  return { success: true, status: resp.status, data: resp.data, channel: 'sessionWebhook' };
}

async function sendDirectByRobot(userId, text, robotCode) {
  if (!userId) throw new Error('缺少 senderStaffId/userId，无法发送机器人单聊回复。');
  if (!robotCode) throw new Error('缺少 DINGTALK_ROBOT_CODE，无法发送机器人单聊回复。');

  const token = await getAccessToken();
  const resp = await axios.post(
    'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend',
    {
      robotCode,
      userIds: [userId],
      msgKey: 'sampleMarkdown',
      msgParam: JSON.stringify({ title: '酷太自动回复', text }),
    },
    {
      headers: { 'x-acs-dingtalk-access-token': token },
      timeout: 15000,
    }
  );
  return { success: true, status: resp.status, data: resp.data, channel: 'robotDirect' };
}

async function sendRobotReply(inbound, reply, assetPaths = []) {
  const textResult = inbound.sessionWebhook
    ? await sendBySessionWebhook(inbound.sessionWebhook, reply)
    : await sendDirectByRobot(inbound.msg.senderUserId, reply, inbound.robotCode || CONFIG.robotCode || CONFIG.appKey);

  const assetResults = [];
  for (const localPath of assetPaths || []) {
    try {
      assetResults.push(await sendImageByRobot(inbound, localPath));
    } catch (e) {
      const failure = { success: false, file: path.basename(localPath || ''), error: e.message };
      assetResults.push(failure);
      console.error(`[DingTalk] 安装示意图发送失败: ${failure.file}: ${failure.error}`);
      appendBotAudit({
        event: 'asset_send_failed',
        targetType: inbound.targetType,
        conversationId: inbound.conversationId,
        file: failure.file,
        reason: failure.error,
      });
    }
  }
  return {
    ...textResult,
    success: true,
    assets: assetResults,
    assetFailureCount: assetResults.filter(item => !item.success).length,
  };
}

function getConversationHistory(conversationId) {
  return conversationHistory.get(conversationId);
}

function rememberMessage(conversationId, msg, reply) {
  conversationHistory.remember(conversationId, msg, reply);
}

async function processInbound(body) {
  const inbound = normalizeInboundMessage(body);
  const auditBase = {
    event: 'inbound',
    targetType: inbound.targetType,
    title: inbound.title,
    conversationId: inbound.conversationId,
    sender: inbound.msg.sender,
    senderUserId: inbound.msg.senderUserId,
    msgType: inbound.msgType,
    content: normalizeReviewText(inbound.msg.content, 500),
  };

  appendBotAudit(auditBase);

  if (inbound.ageMs > CONFIG.maxMessageAgeMs) {
    appendBotAudit({ ...auditBase, event: 'skip', reason: 'message_too_old', ageMs: inbound.ageMs });
    return { action: 'skip', reason: 'message_too_old' };
  }

  if (inbound.targetType === 'group' && CONFIG.groupOnlyAt && !inbound.isAtRobot) {
    appendBotAudit({ ...auditBase, event: 'skip', reason: 'group_not_at_robot' });
    return { action: 'skip', reason: 'group_not_at_robot' };
  }

  if (inbound.msgType !== 'text' && !inbound.msg.content) {
    const originalDecision = { action: 'skip', reason: 'non_text_without_content' };
    try {
      const sendResult = await sendRobotReply(inbound, HUMAN_REQUIRED_REPLY, []);
      const decision = {
        action: 'reply',
        reply: HUMAN_REQUIRED_REPLY,
        reason: `human_required:${originalDecision.reason}`,
        deepseekDecision: 'human_required_fallback',
        sendResult,
      };
      rememberMessage(inbound.conversationId, inbound.msg, HUMAN_REQUIRED_REPLY);
      appendBotAudit({ ...auditBase, event: 'decision', decision, originalDecision });
      return decision;
    } catch (error) {
      const decision = {
        action: 'deferred',
        reply: HUMAN_REQUIRED_REPLY,
        reason: 'human_required_send_failed',
        originalReason: originalDecision.reason,
        error: error.message,
      };
      appendBotAudit({ ...auditBase, event: 'decision', decision, originalDecision });
      return decision;
    }
  }

  let originalDecision;
  try {
    await ensureEngineReady();
    const state = loadState();
    const history = getConversationHistory(inbound.conversationId);
    const messages = [...history, inbound.msg];

    originalDecision = await processSingleMessageForAutoReply({
      state,
      msg: inbound.msg,
      messages,
      title: inbound.title,
      conversationId: inbound.conversationId,
      targetType: inbound.targetType,
      sourcePrefix: '机器人',
      send: ({ reply, assetPaths }) => sendRobotReply(inbound, reply, assetPaths),
    });
  } catch (error) {
    originalDecision = {
      action: 'skip',
      reason: 'processing_error',
      error: error.message,
    };
  }

  let decision = originalDecision;
  if (shouldSendHumanFallback(originalDecision)) {
    try {
      const sendResult = await sendRobotReply(inbound, HUMAN_REQUIRED_REPLY, []);
      decision = {
        action: 'reply',
        reply: HUMAN_REQUIRED_REPLY,
        reason: `human_required:${originalDecision.reason || 'unknown'}`,
        deepseekDecision: 'human_required_fallback',
        sendResult,
      };
    } catch (error) {
      decision = {
        action: 'deferred',
        reply: HUMAN_REQUIRED_REPLY,
        reason: 'human_required_send_failed',
        originalReason: originalDecision.reason || 'unknown',
        error: error.message,
      };
    }
  }

  rememberMessage(inbound.conversationId, inbound.msg, decision.action === 'reply' ? decision.reply : '');
  appendBotAudit({ ...auditBase, event: 'decision', decision, originalDecision });
  return decision;
}

async function startStreamClient() {
  if (CONFIG.connectMode !== 'stream') {
    console.log('[Stream] 未启用，当前模式:', CONFIG.connectMode);
    return;
  }
  if (!CONFIG.appKey || !CONFIG.appSecret) {
    console.warn('[Stream] 缺少 DINGTALK_APP_KEY/DINGTALK_APP_SECRET，等待配置后再启动 Stream。');
    return;
  }

  streamClient = new DWClient({
    clientId: CONFIG.appKey,
    clientSecret: CONFIG.appSecret,
    keepAlive: true,
    debug: CONFIG.streamDebug,
  });

  streamClient.registerCallbackListener(TOPIC_ROBOT, (downstream) => {
    try {
      const body = JSON.parse(downstream.data || '{}');
      const messageId = downstream.headers?.messageId;
      if (messageId) {
        streamClient.socketCallBackResponse(messageId, { status: 'SUCCESS' });
      }
      appendBotAudit({
        event: 'stream_received',
        topic: downstream.headers?.topic,
        messageId,
        dataPreview: normalizeReviewText(downstream.data, 1000),
      });
      setImmediate(() => {
        processInbound(body).then(decision => {
          console.log(`[StreamRobot] ${decision.action}: ${decision.reason || ''}`);
        }).catch(err => {
          console.error('[StreamRobot] 处理失败:', err.stack || err.message);
          appendBotAudit({
            event: 'stream_error',
            message: err.message,
            stack: String(err.stack || '').slice(0, 2000),
          });
        });
      });
    } catch (err) {
      console.error('[StreamRobot] 消息解析失败:', err.message);
      appendBotAudit({ event: 'stream_parse_error', message: err.message });
    }
  });

  await streamClient.connect();
  console.log('[Stream] 钉钉 Stream 连接已启动');
}

const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'kutai-dingtalk-robot-reply',
    aiProvider: ENGINE_CONFIG.aiProvider,
    connectMode: CONFIG.connectMode,
    streamConfigured: Boolean(CONFIG.appKey && CONFIG.appSecret),
    groupOnlyAt: CONFIG.groupOnlyAt,
    maxMessageAgeMin: Math.round(CONFIG.maxMessageAgeMs / 60000),
  });
});

app.post('/dingtalk/webhook', (req, res) => {
  res.json({ msg: 'ok' });
  setImmediate(() => {
    processInbound(req.body).then(decision => {
      console.log(`[Robot] ${decision.action}: ${decision.reason || ''}`);
    }).catch(err => {
      console.error('[Robot] 处理失败:', err.stack || err.message);
      appendBotAudit({
        event: 'error',
        message: err.message,
        stack: String(err.stack || '').slice(0, 2000),
      });
    });
  });
});

function startServer() {
  setInterval(() => conversationHistory.prune(), 60 * 1000);
  return app.listen(CONFIG.port, () => {
    console.log('='.repeat(46));
    console.log('  酷太钉钉机器人自动回复服务已启动');
    console.log(`  端口: ${CONFIG.port}`);
    console.log(`  回调地址: /dingtalk/webhook`);
    console.log(`  接入模式: ${CONFIG.connectMode}`);
    console.log(`  群聊仅@回复: ${CONFIG.groupOnlyAt ? '是' : '否'}`);
    console.log(`  只处理 ${Math.round(CONFIG.maxMessageAgeMs / 60000)} 分钟内新消息`);
    console.log(`  AI Provider: ${ENGINE_CONFIG.aiProvider}`);
    console.log('='.repeat(46));
    startStreamClient().catch(err => {
      console.error('[Stream] 启动失败:', err.stack || err.message);
      appendBotAudit({
        event: 'stream_start_failed',
        message: err.message,
        stack: String(err.stack || '').slice(0, 2000),
      });
    });
  });
}

module.exports = {
  app,
  startServer,
  processInbound,
  normalizeInboundMessage,
  sendRobotReply,
  sendImageByRobot,
  shouldSendHumanFallback,
};

if (require.main === module) {
  startServer();
  process.on('SIGINT', () => {
    if (streamClient) streamClient.disconnect();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    if (streamClient) streamClient.disconnect();
    process.exit(0);
  });
}
