const crypto = require('crypto');

function xmlValue(xml, tag) {
  const match = String(xml || '').match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return match ? (match[1] ?? match[2] ?? '').trim() : '';
}

function xmlText(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

class WecomCallbackCrypto {
  constructor({ token = '', encodingAesKey = '', receiveId = '' } = {}) {
    this.token = String(token).trim();
    this.receiveId = String(receiveId).trim();
    this.aesKey = encodingAesKey
      ? Buffer.from(`${String(encodingAesKey).trim()}=`, 'base64')
      : null;
    if (this.aesKey && this.aesKey.length !== 32) {
      throw new Error('WECOM_KF_CALLBACK_AES_KEY 格式不正确，应为企业微信生成的 43 位 EncodingAESKey。');
    }
  }

  isConfigured() {
    return Boolean(this.token && this.aesKey && this.receiveId);
  }

  signature(timestamp, nonce, encrypted) {
    return crypto.createHash('sha1')
      .update([this.token, String(timestamp), String(nonce), String(encrypted)].sort().join(''))
      .digest('hex');
  }

  verify({ msgSignature, timestamp, nonce, encrypted }) {
    if (!this.isConfigured()) throw new Error('企业微信回调尚未配置。');
    if (!safeEqual(this.signature(timestamp, nonce, encrypted), msgSignature)) {
      throw new Error('企业微信回调签名校验失败。');
    }
  }

  decrypt(encrypted) {
    if (!this.isConfigured()) throw new Error('企业微信回调尚未配置。');
    const decipher = crypto.createDecipheriv('aes-256-cbc', this.aesKey, this.aesKey.subarray(0, 16));
    decipher.setAutoPadding(false);
    const plainWithPadding = Buffer.concat([
      decipher.update(Buffer.from(String(encrypted || ''), 'base64')),
      decipher.final(),
    ]);
    const pad = plainWithPadding[plainWithPadding.length - 1];
    if (pad < 1 || pad > 32) throw new Error('企业微信回调 AES 填充无效。');
    const plain = plainWithPadding.subarray(0, plainWithPadding.length - pad);
    if (plain.length < 20) throw new Error('企业微信回调内容长度无效。');
    const length = plain.readUInt32BE(16);
    const bodyEnd = 20 + length;
    if (bodyEnd > plain.length) throw new Error('企业微信回调正文长度无效。');
    const receiveId = plain.subarray(bodyEnd).toString('utf8');
    if (receiveId !== this.receiveId) throw new Error('企业微信回调接收方校验失败。');
    return plain.subarray(20, bodyEnd).toString('utf8');
  }

  verifyUrl(query) {
    const encryptedEcho = String(query.echostr || '');
    this.verify({
      msgSignature: query.msg_signature || query.signature,
      timestamp: query.timestamp,
      nonce: query.nonce,
      encrypted: encryptedEcho,
    });
    return this.decrypt(encryptedEcho);
  }

  decryptMessage(query, encryptedXml) {
    const encrypted = xmlValue(encryptedXml, 'Encrypt');
    if (!encrypted) throw new Error('企业微信回调缺少 Encrypt 字段。');
    this.verify({
      msgSignature: query.msg_signature || query.signature,
      timestamp: query.timestamp,
      nonce: query.nonce,
      encrypted,
    });
    return this.decrypt(encrypted);
  }
}

class WecomKfClient {
  constructor({ corpId = '', secret = '', httpClient } = {}) {
    this.corpId = String(corpId).trim();
    this.secret = String(secret).trim();
    // 允许单元测试传入轻量 HTTP client；生产环境仍使用 axios。
    this.http = httpClient || require('axios');
    this.accessToken = '';
    this.accessTokenExpiresAt = 0;
  }

  isConfigured() {
    return Boolean(this.corpId && this.secret);
  }

  async getAccessToken() {
    if (!this.isConfigured()) throw new Error('缺少 WECOM_KF_CORP_ID / WECOM_KF_SECRET。');
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt) return this.accessToken;
    const response = await this.http.get('https://qyapi.weixin.qq.com/cgi-bin/gettoken', {
      params: { corpid: this.corpId, corpsecret: this.secret },
      timeout: 15000,
    });
    if (response.data?.errcode !== 0 || !response.data?.access_token) {
      throw new Error(`企业微信客服 Token 获取失败：${response.data?.errmsg || response.data?.errcode || '未知错误'}`);
    }
    this.accessToken = response.data.access_token;
    this.accessTokenExpiresAt = Date.now() + Math.max((response.data.expires_in || 7200) - 60, 60) * 1000;
    return this.accessToken;
  }

  async syncMessages({ token, openKfId, cursor = '' }) {
    const accessToken = await this.getAccessToken();
    const response = await this.http.post(
      'https://qyapi.weixin.qq.com/cgi-bin/kf/sync_msg',
      { cursor, token, limit: 1000, open_kfid: openKfId },
      { params: { access_token: accessToken }, timeout: 20000 }
    );
    if (response.data?.errcode !== 0) {
      throw new Error(`企业微信客服消息拉取失败：${response.data?.errmsg || response.data?.errcode || '未知错误'}`);
    }
    return response.data;
  }

  async sendText({ externalUserId, openKfId, content, messageId }) {
    const accessToken = await this.getAccessToken();
    const response = await this.http.post(
      'https://qyapi.weixin.qq.com/cgi-bin/kf/send_msg',
      {
        touser: externalUserId,
        open_kfid: openKfId,
        msgid: messageId,
        msgtype: 'text',
        text: { content: String(content || '').slice(0, 2048) },
      },
      { params: { access_token: accessToken }, timeout: 20000 }
    );
    if (response.data?.errcode !== 0) {
      throw new Error(`企业微信客服消息发送失败：${response.data?.errmsg || response.data?.errcode || '未知错误'}`);
    }
    return response.data;
  }
}

function normalizeKfMessage(message) {
  const msgType = String(message?.msgtype || '').toLowerCase();
  const content = msgType === 'text' ? xmlText(message?.text?.content || '') : '';
  const openKfId = String(message?.open_kfid || '');
  const externalUserId = String(message?.external_userid || '');
  const sendTime = Number(message?.send_time || Date.now() / 1000) * 1000;
  return {
    msgType,
    origin: Number(message?.origin),
    openKfId,
    externalUserId,
    conversationId: `wecom-kf:${openKfId}:${externalUserId}`,
    msg: {
      id: `wecom-kf:${message?.msgid || `${openKfId}:${externalUserId}:${sendTime}`}`,
      sender: '微信客户',
      senderUserId: externalUserId,
      content,
      time: new Date(sendTime).toISOString(),
      createTime: new Date(sendTime).toISOString(),
      raw: message,
    },
  };
}

module.exports = {
  WecomCallbackCrypto,
  WecomKfClient,
  normalizeKfMessage,
  xmlValue,
};
