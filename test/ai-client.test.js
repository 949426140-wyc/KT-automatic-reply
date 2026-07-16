const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { requestJson } = require('../lib/ai-client');

test('AI 网络客户端发送 JSON 并解析 JSON 响应', async () => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ received: JSON.parse(body), ok: true }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const result = await requestJson(`http://127.0.0.1:${port}/chat`, { model: 'test' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.body.received, { model: 'test' });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
