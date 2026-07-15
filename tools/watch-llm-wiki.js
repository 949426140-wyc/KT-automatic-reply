/* Obsidian 保存原始 Markdown 后的安全编译监听器（轮询，兼容 Docker Windows 挂载）。 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const knowledgeRoot = process.env.KNOWLEDGE_ROOT || path.resolve(__dirname, '..', '..', '产品知识库');
const intervalMs = Number(process.env.WIKI_WATCH_INTERVAL_MS || 3000);
const debounceMs = Number(process.env.WIKI_WATCH_DEBOUNCE_MS || 2500);
const sourceDirs = [
  '01_MD章节矩阵',
  path.join('05_数据与图片', '酷太产品图文知识库.json'),
];
let snapshot = '';
let changedAt = 0;
let building = false;

function walk(dir, rows = []) {
  try {
    const stat = fs.statSync(dir);
    if (stat.isFile()) {
      rows.push(`${dir}:${stat.mtimeMs}:${stat.size}`);
      return rows;
    }
  } catch { return rows; }
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return rows; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, rows);
    else if (entry.isFile() && entry.name.endsWith('.md')) {
      try { rows.push(`${full}:${fs.statSync(full).mtimeMs}:${fs.statSync(full).size}`); } catch {}
    }
  }
  return rows;
}

function fingerprint() { return walk(knowledgeRoot ? sourceDirs.map(dir => path.join(knowledgeRoot, dir)) : []).flat?.() || []; }
function currentFingerprint() {
  const rows = [];
  for (const dir of sourceDirs) walk(path.join(knowledgeRoot, dir), rows);
  return rows.sort().join('|');
}
function compile() {
  building = true;
  try {
    const sourceDir = path.join(knowledgeRoot, 'LLM-Wiki', 'source');
    const generatorDir = path.join(knowledgeRoot, '04_生成工具');
    execFileSync(process.execPath, [path.join(generatorDir, 'export-wiki-source.js')], {
      stdio: 'inherit',
      env: { ...process.env, KNOWLEDGE_ROOT: knowledgeRoot, KNOWLEDGE_EXPORT_DIR: sourceDir },
    });
    execFileSync(process.execPath, [path.join(generatorDir, 'generate-wiki-precision-cards.js')], {
      stdio: 'inherit',
      env: { ...process.env, KNOWLEDGE_ROOT: knowledgeRoot, KNOWLEDGE_EXPORT_DIR: sourceDir },
    });
    execFileSync(process.execPath, [path.join(__dirname, 'build-llm-wiki.js')], { stdio: 'inherit', env: { ...process.env, KNOWLEDGE_ROOT: knowledgeRoot } });
    execFileSync(process.execPath, [path.join(__dirname, 'test-llm-wiki.js')], { stdio: 'inherit', env: { ...process.env, LLM_WIKI_ROOT: path.join(knowledgeRoot, 'LLM-Wiki') } });
    console.log(`[LLM Wiki Watch] 已安全编译并通过检索测试：${new Date().toISOString()}`);
  } catch (error) { console.error(`[LLM Wiki Watch] 编译或测试失败，保留上一版索引：${error.message}`); }
  building = false;
}

snapshot = currentFingerprint();
console.log(`[LLM Wiki Watch] 正在监听 ${knowledgeRoot}`);
setInterval(() => {
  const next = currentFingerprint();
  if (next !== snapshot) { snapshot = next; changedAt = Date.now(); console.log('[LLM Wiki Watch] 检测到原始知识卡变更，等待保存稳定。'); }
  if (!building && changedAt && Date.now() - changedAt >= debounceMs) { changedAt = 0; compile(); }
}, intervalMs);
