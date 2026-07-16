'use strict';

const http = require('http');
const https = require('https');

// DeepSeek、Dify 及兼容 OpenAI/Anthropic 网关共用的安全 JSON POST 底座。
// 业务提示词、供应商选择和回复解析留在调用方，避免网络层拥有产品决策。
function requestJson(urlText, body, headers = {}, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const url = new URL(urlText);
    const client = url.protocol === 'http:' ? http : https;
    let settled = false;
    const payload = JSON.stringify(body);
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const req = client.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
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
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data || '{}');
          if (res.statusCode >= 400) return finish({ ok: false, statusCode: res.statusCode, body: parsed, raw: data });
          return finish({ ok: true, statusCode: res.statusCode, body: parsed, raw: data });
        } catch (_) {
          return finish({ ok: false, statusCode: res.statusCode, body: null, raw: data });
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      finish({ ok: false, timeout: true, body: null, raw: '' });
    });
    req.on('error', error => finish({ ok: false, error: error.message, body: null, raw: '' }));
    req.write(payload);
    req.end();
  });
}

module.exports = { requestJson };
