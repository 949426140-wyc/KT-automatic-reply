/**
 * 图片识别模块
 * 1. 钉钉 OAuth PKCE 登录 → 获取 access token
 * 2. 下载钉钉消息中的图片
 * 3. 调用 Doubao vision API 识别图片内容
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');
const { execSync } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// ====== 配置 ======
const DINGTALK_CLIENT_ID = process.env.DINGTALK_CLIENT_ID || process.env.DINGTALK_APP_KEY || '';
const DINGTALK_APP_KEY = process.env.DINGTALK_APP_KEY || DINGTALK_CLIENT_ID;
const DINGTALK_APP_SECRET = process.env.DINGTALK_APP_SECRET || process.env.DINGTALK_CLIENT_SECRET || '';
const DINGTALK_OAUTH_AUTH_URL = 'https://login.dingtalk.com/oauth2/auth';
const DINGTALK_OAUTH_TOKEN_URL = 'https://api.dingtalk.com/v1.0/oauth2/userAccessToken';
const DINGTALK_APP_TOKEN_URL = 'https://api.dingtalk.com/v1.0/oauth2/accessToken';
const DINGTALK_ROBOT_MESSAGE_FILE_DOWNLOAD_PATH = '/v1.0/robot/messageFiles/download';

// Doubao vision 配置
const DOUBAO_CONFIG_PATH = path.join(require('os').homedir(), '.claude', 'doubao-vision-config.json');
function normalizeVisionBaseUrl(baseUrl) {
  return String(baseUrl || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, '');
}

function loadDoubaoConfig() {
  const envApiKey = process.env.DOUBAO_VISION_API_KEY || process.env.ARK_API_KEY || process.env.VOLCENGINE_API_KEY || '';
  const envModel = process.env.DOUBAO_VISION_MODEL || process.env.ARK_VISION_MODEL || '';
  if (envApiKey || envModel || process.env.DOUBAO_VISION_BASE_URL || process.env.ARK_BASE_URL) {
    return {
      apiKey: envApiKey,
      baseUrl: normalizeVisionBaseUrl(process.env.DOUBAO_VISION_BASE_URL || process.env.ARK_BASE_URL),
      model: envModel || 'doubao-seed-1-6-vision-250815',
    };
  }
  try {
    const legacy = JSON.parse(fs.readFileSync(DOUBAO_CONFIG_PATH, 'utf-8'));
    return {
      apiKey: legacy.apiKey || legacy.api_key || '',
      baseUrl: normalizeVisionBaseUrl(legacy.baseUrl || legacy.base_url),
      model: legacy.model || 'doubao-seed-1-6-vision-250815',
    };
  } catch { return null; }
}

// Token 存储路径
const TOKEN_FILE = path.join(__dirname, 'data', 'dingtalk-token.json');
let appAccessTokenCache = { token: '', expiresAt: 0 };

// ====== PKCE 工具 ======
function base64URL(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest();
}

function generateCodeVerifier() {
  return base64URL(crypto.randomBytes(32));
}

function generateCodeChallenge(verifier) {
  return base64URL(sha256(verifier));
}

// ====== HTTP 请求 ======
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, headers: res.headers, data: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function httpsRequestBinary(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function requestBinaryUrl(downloadUrl) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(downloadUrl);
    const client = parsed.protocol === 'http:' ? http : https;
    const req = client.request({
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      timeout: 30000,
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`原图文件下载失败：HTTP ${res.statusCode}`));
          return;
        }
        resolve(buffer);
      });
    });
    req.on('timeout', () => req.destroy(new Error('原图文件下载超时')));
    req.on('error', reject);
    req.end();
  });
}

// ====== 获取/刷新 Access Token ======
async function getAccessToken({ interactive = true } = {}) {
  // 优先读 DWS 的环境 token
  const dwsToken = await tryGetDwsToken();
  if (dwsToken) return dwsToken;

  // 从本地文件读 refresh token
  const stored = loadStoredToken();
  if (stored?.refreshToken) {
    try {
      const newTokens = await refreshAccessToken(stored.refreshToken);
      saveTokens(newTokens);
      return newTokens.accessToken;
    } catch (e) {
      console.log('[图片识别] 刷新 token 失败，需要重新登录');
    }
  }

  // 机器人运行时优先使用应用凭证下载群消息原图；无需弹出个人 OAuth 登录页。
  const appToken = await getAppAccessToken();
  if (appToken) return appToken;

  // 生产消息处理不能因为图片缺 token 而弹出登录或阻塞轮询；只记录为原图未获取。
  if (!interactive) return null;

  // 需要重新登录
  console.log('[图片识别] 需要 OAuth 登录...');
  return await oauthLogin();
}

async function getAppAccessToken() {
  if (appAccessTokenCache.token && appAccessTokenCache.expiresAt > Date.now() + 60 * 1000) {
    return appAccessTokenCache.token;
  }
  if (!DINGTALK_APP_KEY || !DINGTALK_APP_SECRET) return null;

  try {
    const res = await httpsRequest({
      hostname: 'api.dingtalk.com',
      path: '/v1.0/oauth2/accessToken',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    }, JSON.stringify({ appKey: DINGTALK_APP_KEY, appSecret: DINGTALK_APP_SECRET }));
    const token = res.data?.accessToken || '';
    if (!token) {
      console.error(`[图片识别] 获取应用访问令牌失败: HTTP ${res.status}`);
      return null;
    }
    appAccessTokenCache = {
      token,
      expiresAt: Date.now() + Number(res.data?.expireIn || 7200) * 1000,
    };
    return token;
  } catch (e) {
    console.error(`[图片识别] 获取应用访问令牌异常: ${e.message}`);
    return null;
  }
}

async function tryGetDwsToken() {
  try {
    // 尝试通过 dws 进程获取 token（用调试日志）
    const result = execSync('dws auth status -y 2>&1', { encoding: 'utf-8', timeout: 10000 });
    const status = JSON.parse(result);
    if (!status.authenticated) return null;

    // 尝试直接调 API 看是否能拿到 token
    // dws 的 token 存在进程内存中，无法直接读取
    // 这里换一种思路：用 subprocess 调 dws 来下载
    return null; // 暂时返回 null，走 PKCE 流程
  } catch { return null; }
}

function loadStoredToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
      if (data.refreshToken && data.refreshExpiresAt > Date.now()) return data;
    }
  } catch {}
  return null;
}

function saveTokens(tokens) {
  const dir = path.dirname(TOKEN_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({
    refreshToken: tokens.refreshToken,
    accessToken: tokens.accessToken,
    expiresAt: Date.now() + (tokens.expiresIn || 7200) * 1000,
    refreshExpiresAt: Date.now() + (tokens.refreshExpiresIn || 30 * 24 * 3600) * 1000 * 0.9,
  }, null, 2));
}

async function refreshAccessToken(refreshToken) {
  const body = JSON.stringify({
    grantType: 'refresh_token',
    clientId: DINGTALK_CLIENT_ID,
    refreshToken: refreshToken,
  });

  const res = await httpsRequest({
    hostname: 'api.dingtalk.com',
    path: '/v1.0/oauth2/userAccessToken',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000,
  }, body);

  if (res.data?.accessToken) {
    return {
      accessToken: res.data.accessToken,
      refreshToken: res.data.refreshToken,
      expiresIn: res.data.expireIn || 7200,
    };
  }
  throw new Error('刷新 token 失败: ' + JSON.stringify(res.data));
}

// ====== OAuth PKCE 登录 ======
async function oauthLogin() {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = base64URL(crypto.randomBytes(16));

  // 启动本地 HTTP 服务器接收回调
  const localPort = 18080;
  const server = http.createServer();
  const codePromise = new Promise((resolve, reject) => {
    server.on('request', (req, res) => {
      const u = new URL(req.url, `http://localhost:${localPort}`);
      const code = u.searchParams.get('code');
      const returnedState = u.searchParams.get('state');

      if (code && returnedState === state) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><h2>登录成功！</h2><p>可以关闭此页面。</p></body></html>');
        server.close();
        resolve(code);
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><h2>登录失败</h2><p>state 不匹配，请重试。</p></body></html>');
      }
    });
    server.on('error', reject);
  });

  server.listen(localPort, '127.0.0.1');

  const authUrl = `${DINGTALK_OAUTH_AUTH_URL}?` +
    `client_id=${encodeURIComponent(DINGTALK_CLIENT_ID)}` +
    `&response_type=code` +
    `&scope=openid+corpid` +
    `&state=${state}` +
    `&redirect_uri=${encodeURIComponent(`http://127.0.0.1:${localPort}`)}` +
    `&code_challenge=${codeChallenge}` +
    `&code_challenge_method=S256`;

  console.log('[图片识别] 请在浏览器中打开以下链接完成钉钉登录：');
  console.log(authUrl);

  // 尝试自动打开浏览器
  try {
    const startCmd = process.platform === 'win32'
      ? `start "" "${authUrl}"`
      : process.platform === 'darwin'
        ? `open "${authUrl}"`
        : `xdg-open "${authUrl}"`;
    execSync(startCmd, { timeout: 5000 });
  } catch {}

  // 等待回调（超时 5 分钟）
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('登录超时（5分钟）')), 5 * 60 * 1000));
  const code = await Promise.race([codePromise, timeout]);

  // 用 code 换 token
  const body = JSON.stringify({
    grantType: 'authorization_code',
    clientId: DINGTALK_CLIENT_ID,
    code: code,
    codeVerifier: codeVerifier,
  });

  const res = await httpsRequest({
    hostname: 'api.dingtalk.com',
    path: '/v1.0/oauth2/userAccessToken',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000,
  }, body);

  if (res.data?.accessToken) {
    const tokens = {
      accessToken: res.data.accessToken,
      refreshToken: res.data.refreshToken,
      expiresIn: res.data.expireIn || 7200,
    };
    saveTokens(tokens);
    console.log('[图片识别] OAuth 登录成功');
    return tokens.accessToken;
  }

  throw new Error('获取 token 失败: ' + JSON.stringify(res.data));
}

// ====== 下载图片 ======
async function downloadMedia(downloadCode, robotCode, accessToken) {
  if (!downloadCode) throw new Error('消息未提供原图下载码');
  if (!robotCode) throw new Error('消息未提供机器人编码，无法下载原图');

  const ticket = await httpsRequest({
    hostname: 'api.dingtalk.com',
    path: DINGTALK_ROBOT_MESSAGE_FILE_DOWNLOAD_PATH,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-acs-dingtalk-access-token': accessToken,
    },
    timeout: 30000,
  }, JSON.stringify({ downloadCode, robotCode }));

  const downloadUrl = ticket.data?.downloadUrl || '';
  if (ticket.status < 200 || ticket.status >= 300 || !downloadUrl) {
    const code = ticket.data?.code || ticket.data?.errcode || '';
    const message = ticket.data?.message || ticket.data?.errmsg || '未返回原图下载地址';
    throw new Error(`钉钉原图下载地址获取失败${code ? `（${code}）` : ''}：${message}`);
  }
  return requestBinaryUrl(downloadUrl);
}

// 只允许使用钉钉媒体接口下载到的原始二进制图片。
// 不返回桌面缓存、缩略图或按时间猜到的本地文件，避免把无关图片带入回复链路。
async function downloadOriginalMedia({ downloadCode, robotCode, mediaId = '' } = {}) {
  const accessToken = await getAccessToken({ interactive: false });
  if (!accessToken) {
    throw new Error('缺少可用的钉钉访问令牌，未能下载原图');
  }

  const buffer = await downloadMedia(downloadCode, robotCode, accessToken);
  if (!Buffer.isBuffer(buffer) || buffer.length < 100) {
    throw new Error('钉钉未返回有效原图文件');
  }
  // 钉钉接口出错时通常返回 JSON；不能把错误 JSON 当图片交给视觉模型。
  const head = buffer.subarray(0, 200).toString('utf8').trim();
  if (head.startsWith('{') || head.startsWith('[')) {
    throw new Error(`钉钉原图下载失败：${head.slice(0, 120)}`);
  }
  return { mediaId, buffer, source: 'dingtalk_robot_message_file_download' };
}

// ====== Doubao Vision 识别 ======
async function recognizeImage(imageBuffer) {
  const config = loadDoubaoConfig();
  if (!config) {
    console.error('[图片识别] 未找到 doubao-vision-config.json');
    return null;
  }

  const base64 = imageBuffer.toString('base64');
  const mimeType = detectMimeType(imageBuffer);

  const body = JSON.stringify({
    model: config.model,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: { url: `data:${mimeType};base64,${base64}` },
        },
        {
          type: 'text',
          text: '请详细描述这张图片中的所有内容。如果是产品相关图片（抽屉、拉篮、柜体、订单、尺寸表等），请尽可能详细地提取所有文字、数字、型号、尺寸信息。如果是截图，请完整提取截图中的文字内容。',
        },
      ],
    }],
    max_tokens: 1000,
  });

  const apiUrl = new URL(config.baseUrl + '/chat/completions');
  const res = await httpsRequest({
    hostname: apiUrl.hostname,
    path: apiUrl.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    timeout: 60000,
  }, body);

  if (res.data?.choices?.[0]?.message?.content) {
    return res.data.choices[0].message.content.trim();
  }

  console.error('[图片识别] Doubao API 返回异常:', JSON.stringify(res.data).slice(0, 300));
  return null;
}

function detectMimeType(buffer) {
  // 简单检测常见图片格式
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return 'image/gif';
  if (buffer[0] === 0x52 && buffer[1] === 0x49) return 'image/webp';
  return 'image/jpeg'; // 默认
}

// ====== 提取 mediaId ======
function extractMediaIds(text) {
  const ids = [];
  const re = /mediaId=([@$])([^\s)\]）]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    ids.push(m[1] + m[2]); // 保留 @ 或 $ 前缀
  }
  return ids;
}

// ====== 主入口：识别消息中的图片 ======
async function recognizeImagesInMessage(text) {
  const mediaIds = extractMediaIds(text);
  if (!mediaIds.length) return null;
  console.log('[图片识别] 旧文本只含 mediaId，缺少钉钉原图下载码；已拒绝识别，禁止使用缩略图或缓存替代。');
  return null;
}

module.exports = {
  recognizeImagesInMessage,
  extractMediaIds,
  getAccessToken,
  getAppAccessToken,
  downloadMedia,
  downloadOriginalMedia,
  recognizeImage,
};
