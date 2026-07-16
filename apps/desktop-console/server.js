const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PORT = Number(process.env.KUTAI_CONSOLE_PORT || 43118);
const WORKSPACE_ROOT_FILE = path.join(__dirname, 'workspace-root.txt');
const EMBEDDED_REPO_ROOT = path.resolve(__dirname, '..', '..');
const EMBEDDED_WORKSPACE_ROOT = exists(path.join(EMBEDDED_REPO_ROOT, 'docker-compose.yml'))
  ? path.dirname(EMBEDDED_REPO_ROOT)
  : '';
const DEFAULT_WORKSPACE_ROOT = [
  path.resolve(__dirname, '..'),
  EMBEDDED_WORKSPACE_ROOT,
  path.resolve(__dirname, '..', '..', '..'),
].find((candidate) => candidate && (
  exists(path.join(candidate, 'KT-automatic-reply-repo')) ||
  exists(path.join(candidate, '产品知识库'))
)) || path.resolve(__dirname, '..');
const ROOT = process.env.KUTAI_WORKSPACE_ROOT || readText(WORKSPACE_ROOT_FILE).trim() || DEFAULT_WORKSPACE_ROOT;
// 源码仓库已迁至 KT-automatic-reply-repo；同时保留旧目录兼容，避免控制台误报未配置。
const BOT_DIR = [
  path.join(ROOT, 'KT-automatic-reply-repo'),
  EMBEDDED_REPO_ROOT,
  path.join(ROOT, '\u9489\u9489\u81ea\u52a8\u56de\u590d'),
].find((candidate) => exists(candidate)) || path.join(ROOT, 'KT-automatic-reply-repo');
const DOCKER = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe');
const WIKI_INDEX_FILE = path.join(ROOT, '\u4ea7\u54c1\u77e5\u8bc6\u5e93', 'LLM-Wiki', 'index', 'knowledge-index.json');

function exists(file) {
  try { return fs.existsSync(file); } catch { return false; }
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function readJson(file, fallback) {
  try { return JSON.parse(readText(file)); } catch { return fallback; }
}

function runFile(file, args, cwd, timeout = 30000) {
  try {
    // 显式接管子进程的标准流。Electron 的主进程没有稳定的控制台管道时，
    // execFileSync 默认转发 docker 的 stderr 会触发 EPIPE，并弹出主进程报错框。
    const output = execFileSync(file, args, {
      cwd,
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output: output.trim() };
  } catch (error) {
    return {
      ok: false,
      output: String(error.stdout || error.stderr || error.message || '').trim(),
    };
  }
}

function runDocker(args, cwd = ROOT, timeout = 30000) {
  if (!exists(DOCKER)) return { ok: false, output: 'Docker CLI not found' };
  return runFile(DOCKER, args, cwd, timeout);
}

function readEnvSummary() {
  const envFile = path.join(BOT_DIR, '.env');
  const env = {};
  for (const line of readText(envFile).split(/\r?\n/)) {
    const match = line.match(/^\s*([^#][A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (match) env[match[1]] = match[2];
  }
  return {
    aiProvider: env.AI_PROVIDER || '',
    aiModel: env.AI_MODEL || '',
    deepseekKey: env.AI_API_KEY ? '\u5df2\u914d\u7f6e' : '\u672a\u914d\u7f6e',
    visionEnabled: env.ENABLE_VISION_RECOGNITION === 'true',
    visionModel: env.DOUBAO_VISION_MODEL || '',
    visionKey: env.DOUBAO_VISION_API_KEY ? '\u5df2\u914d\u7f6e' : '\u672a\u914d\u7f6e',
    pendingReview: env.PENDING_REVIEW_MODE === 'true',
    dingtalkKey: env.DINGTALK_APP_KEY || env.DINGTALK_CLIENT_ID ? '\u5df2\u914d\u7f6e' : '\u672a\u914d\u7f6e',
    dingtalkAgentId: env.DINGTALK_AGENT_ID || '',
  };
}

function getContainerState(name) {
  const state = runDocker(['inspect', '-f', '{{.State.Status}}', name], ROOT, 5000);
  if (!state.ok) return { exists: false, status: 'not_found', health: '' };
  const health = runDocker(['inspect', '-f', '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', name], ROOT, 5000);
  return { exists: true, status: state.output || 'unknown', health: health.ok ? health.output : '' };
}

function getWikiStatus() {
  if (!exists(WIKI_INDEX_FILE)) {
    return { exists: false, pageCount: 0, generatedAt: '', indexUpdatedAt: '' };
  }
  const index = readJson(WIKI_INDEX_FILE, {});
  const stat = fs.statSync(WIKI_INDEX_FILE);
  const counts = index.counts || {};
  return {
    exists: true,
    generatedAt: index.generatedAt || stat.mtime.toISOString(),
    indexUpdatedAt: stat.mtime.toISOString(),
    pageCount: Array.isArray(index.entries) ? index.entries.length : 0,
    counts,
  };
}

function getPendingSummary() {
  const candidates = [
    path.join(BOT_DIR, '\u5f85\u56de\u590d\u961f\u5217.json'),
    path.join(BOT_DIR, 'runtime', '\u5f85\u56de\u590d\u961f\u5217.json'),
    path.join(BOT_DIR, 'data', '\u5f85\u56de\u590d\u961f\u5217.json'),
  ];
  let raw = [];
  let file = '';
  for (const candidate of candidates) {
    if (exists(candidate)) {
      raw = readJson(candidate, []);
      file = candidate;
      break;
    }
  }
  const items = Array.isArray(raw) ? raw : Array.isArray(raw.items) ? raw.items : [];
  const pending = Array.isArray(items) ? items.filter((item) => (item.status || 'pending') === 'pending') : [];
  return {
    file,
    total: items.length,
    pending: pending.length,
    latest: pending.slice(0, 12).map((item) => ({
      id: item.id || '',
      sender: item.sender || '',
      title: item.title || '',
      content: String(item.content || '').slice(0, 300),
      suggestion: String(item.deepseekSuggestion || item.suggestion || item.reply || '').slice(0, 500),
      reason: item.reason || '',
      createdAt: item.createdAt || item.time || '',
    })),
  };
}

function tail(file, lines = 80) {
  const text = readText(file);
  if (!text) return '';
  return text.split(/\r?\n/).slice(-lines).join('\n');
}

function parseJsonLines(file, lines = 120) {
  return tail(file, lines)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function getQaRecords() {
  const pending = getPendingSummary().latest.map((item) => ({
    source: 'pending',
    timestamp: item.createdAt,
    status: 'queued',
    replyState: 'unreplied',
    replied: false,
    title: item.title,
    sender: item.sender,
    question: item.content,
    answer: item.suggestion,
    reason: item.reason,
  }));
  const auditCandidates = [
    path.join(BOT_DIR, 'data', 'bot-reply-audit.jsonl'),
    path.join(BOT_DIR, 'bot-reply-audit.jsonl'),
  ];
  const auditFile = auditCandidates.find((candidate) => exists(candidate));
  const audit = auditFile ? parseJsonLines(auditFile, 160) : [];
  const auditItems = [];
  const seenDecisions = new Set();
  for (const item of [...audit].reverse()) {
    const decision = item.decision || (item.action ? item : null);
    if (!decision?.action) continue;

    const action = String(decision.action || '').toLowerCase();
    const messageKey = decision.messageKey || item.messageKey || '';
    const question = item.content || decision.content || '';
    const dedupeKey = messageKey || `${item.conversationId || decision.conversationId || ''}|${question}|${action}`;
    if (seenDecisions.has(dedupeKey)) continue;
    seenDecisions.add(dedupeKey);

    const replied = ['reply', 'sent', 'success'].includes(action);
    auditItems.push({
      source: 'audit',
      timestamp: item.timestamp || item.createdAt || '',
      status: action,
      replyState: replied ? 'replied' : 'unreplied',
      replied,
      title: item.title || decision.title || '',
      sender: item.sender || decision.sender || '',
      question,
      answer: decision.reply || decision.suggestion || decision.review?.suggestion || '',
      reason: decision.reason || item.reason || decision.deepseekDecision || '',
    });
    if (auditItems.length >= 40) break;
  }
  return auditItems.length ? auditItems : pending;
}

async function getStatus() {
  const bot = getContainerState('kutai-dingtalk-bot');
  const manifest = path.join(BOT_DIR, 'package.json');
  const manifestStat = exists(manifest) ? fs.statSync(manifest) : null;
  return {
    generatedAt: new Date().toISOString(),
    paths: { root: ROOT, botDir: BOT_DIR, wikiIndexFile: WIKI_INDEX_FILE },
    docker: { cli: exists(DOCKER), path: DOCKER },
    services: {
      bot,
    },
    config: readEnvSummary(),
    wiki: getWikiStatus(),
    pending: getPendingSummary(),
    source: manifestStat ? { exists: true, mtime: manifestStat.mtime.toISOString() } : { exists: false },
  };
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data, null, 2));
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); }
    });
  });
}

function runSelfTest() {
  const script = [
    "(async () => {",
    "const bot = require('./auto-reply');",
    "await bot.ensureEngineReady();",
    "const state = { repliedMsgs: {}, groupConfig: {} };",
    "const msg = { id: 'ui-selftest-' + Date.now(), sender: 'UI自测客户', senderUserId: 'ui-selftest', time: new Date().toISOString(), content: '安装教程在哪里看？' };",
    "let sendCalled = false;",
    "const decision = await bot.processSingleMessageForAutoReply({ state, msg, messages: [msg], title: '酷太控制台自测', conversationId: 'ui-selftest', targetType: 'direct', sourcePrefix: '控制台自测', send: () => { sendCalled = true; } });",
    "console.log(JSON.stringify({ action: decision.action, reason: decision.reason || '', reply: decision.reply || '', pendingId: decision.pendingId || '', sendCalled }));",
    "})().catch((err) => { console.error(err.message); process.exit(1); });",
  ].join('\n');
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  return runDocker([
    'compose', 'run', '--rm', '--no-deps', '--entrypoint', 'node',
    '-e', 'RUNTIME_DIR=/app/runtime-ui-selftest',
    '-e', 'BOT_AUDIT_LOG_FILE=/app/runtime-ui-selftest/audit.jsonl',
    'kutai-dingtalk-bot',
    '-e', `eval(Buffer.from('${encoded}','base64').toString('utf8'))`,
  ], BOT_DIR, 120000);
}

function handleAction(action) {
  switch (action) {
    case 'start-bot':
      return runDocker(['compose', 'up', '-d', 'kutai-dingtalk-bot'], BOT_DIR, 90000);
    case 'start-all': {
      return runDocker(['compose', 'up', '-d', 'kutai-dingtalk-bot', 'llm-wiki-watcher'], BOT_DIR, 90000);
    }
    case 'stop-bot':
      return runDocker(['compose', 'stop', 'kutai-dingtalk-bot'], BOT_DIR, 60000);
    case 'restart-bot':
      return runDocker(['compose', 'restart', 'kutai-dingtalk-bot'], BOT_DIR, 60000);
    case 'selftest':
      return runSelfTest();
    default:
      return { ok: false, output: `Unknown action: ${action}` };
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const file = path.normalize(path.join(__dirname, 'ui', pathname));
  if (!file.startsWith(path.join(__dirname, 'ui'))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  if (!exists(file)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = path.extname(file).toLowerCase();
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname === '/api/status') {
      sendJson(res, await getStatus());
      return;
    }
    if (url.pathname === '/api/logs') {
      const audit = path.join(BOT_DIR, 'data', 'bot-reply-audit.jsonl');
      sendJson(res, {
        audit: tail(audit, 80),
        bot: runDocker(['logs', '--tail', '80', 'kutai-dingtalk-bot'], ROOT, 6000).output,
        qa: getQaRecords(),
      });
      return;
    }
    if (url.pathname === '/api/action' && req.method === 'POST') {
      const body = await parseBody(req);
      const result = handleAction(body.action);
      sendJson(res, { ok: result.ok, action: body.action, output: result.output });
      return;
    }
    serveStatic(req, res);
  } catch (error) {
    sendJson(res, { error: error.message }, 500);
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.log(`Kutai console: port ${PORT} is already in use, reusing existing local service.`);
    return;
  }
  throw error;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Kutai console: http://127.0.0.1:${PORT}`);
});
