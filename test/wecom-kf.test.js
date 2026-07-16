const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { WecomCallbackCrypto, WecomKfClient, normalizeKfMessage } = require('../lib/wecom-kf');

function encryptForCallback({ aesKey, receiveId, text }) {
  const key = Buffer.from(`${aesKey}=`, 'base64');
  const content = Buffer.from(text);
  const body = Buffer.concat([
    crypto.randomBytes(16),
    Buffer.from([0, 0, 0, content.length]),
    content,
    Buffer.from(receiveId),
  ]);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  return Buffer.concat([cipher.update(body), cipher.final()]).toString('base64');
}

test('企业微信客服回调：验签、解密 URL 与 XML 消息', () => {
  const aesKey = crypto.randomBytes(32).toString('base64').replace(/=$/, '');
  const config = { token: 'test-token', encodingAesKey: aesKey, receiveId: 'ww_test_corp' };
  const adapter = new WecomCallbackCrypto(config);
  const timestamp = '1720000000';
  const nonce = 'nonce-1';
  const encryptedEcho = encryptForCallback({ aesKey, receiveId: config.receiveId, text: 'echo-ok' });
  const signature = adapter.signature(timestamp, nonce, encryptedEcho);
  assert.equal(adapter.verifyUrl({ timestamp, nonce, echostr: encryptedEcho, msg_signature: signature }), 'echo-ok');

  const plainXml = '<xml><Event><![CDATA[kf_msg_or_event]]></Event><Token><![CDATA[event-token]]></Token></xml>';
  const encrypted = encryptForCallback({ aesKey, receiveId: config.receiveId, text: plainXml });
  const messageSignature = adapter.signature(timestamp, nonce, encrypted);
  const encryptedXml = `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`;
  assert.equal(adapter.decryptMessage({ timestamp, nonce, msg_signature: messageSignature }, encryptedXml), plainXml);
});

test('企业微信客服消息：只规范化客户文本，不暴露客户名称', () => {
  const inbound = normalizeKfMessage({
    msgid: 'm1',
    open_kfid: 'wk_test',
    external_userid: 'wm_test',
    send_time: 1720000000,
    origin: 3,
    msgtype: 'text',
    text: { content: '抽屉能定制吗？' },
  });
  assert.equal(inbound.origin, 3);
  assert.equal(inbound.msg.sender, '微信客户');
  assert.equal(inbound.msg.content, '抽屉能定制吗？');
  assert.equal(inbound.conversationId, 'wecom-kf:wk_test:wm_test');
});

test('企业微信客服 API：Token、拉取和发送走正确接口', async () => {
  const calls = [];
  const httpClient = {
    async get(url, options) {
      calls.push({ method: 'get', url, options });
      return { data: { errcode: 0, access_token: 'access-token', expires_in: 7200 } };
    },
    async post(url, body, options) {
      calls.push({ method: 'post', url, body, options });
      return { data: { errcode: 0, errmsg: 'ok', msg_list: [], msgid: 'sent-1' } };
    },
  };
  const client = new WecomKfClient({ corpId: 'ww_test', secret: 'secret', httpClient });
  await client.syncMessages({ token: 'event-token', openKfId: 'wk_test' });
  await client.sendText({ externalUserId: 'wm_test', openKfId: 'wk_test', content: '测试回复', messageId: 'm1' });
  assert.match(calls[0].url, /gettoken/);
  assert.match(calls[1].url, /kf\/sync_msg/);
  assert.equal(calls[1].body.token, 'event-token');
  assert.match(calls[2].url, /kf\/send_msg/);
  assert.equal(calls[2].body.touser, 'wm_test');
});
