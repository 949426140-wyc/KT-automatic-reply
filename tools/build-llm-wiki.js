const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');
const knowledgeRoot = process.env.KNOWLEDGE_ROOT || path.join(projectRoot, '产品知识库');
const wikiRoot = path.join(knowledgeRoot, 'LLM-Wiki');
const wikiSourceRoot = process.env.WIKI_SOURCE_ROOT || path.join(wikiRoot, 'source');

const sources = [
  { dir: path.join(wikiSourceRoot, '05_精准知识卡', '基础产品知识卡'), pageType: 'fact', output: 'facts' },
  { dir: path.join(wikiSourceRoot, '06_规划师设计知识卡', '01_规划师设计精准知识卡'), pageType: 'planning', output: 'planning' },
  { dir: path.join(wikiSourceRoot, '06_规划师设计知识卡', '02_产品应用卡_按产品拆分'), pageType: 'application', output: 'applications' },
];
const bundleDir = path.join(wikiSourceRoot, '05_精准知识卡', '_Wiki上传合集');

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

function listMarkdown(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap(entry => entry.isDirectory() ? listMarkdown(path.join(dir, entry.name)) : entry.name.endsWith('.md') && !entry.name.startsWith('_') ? [path.join(dir, entry.name)] : []);
}

function unquote(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '');
}

function parseFrontmatter(content) {
  const result = {};
  if (!content.startsWith('---')) return result;
  const end = content.indexOf('\n---', 3);
  if (end < 0) return result;
  const lines = content.slice(3, end).split(/\r?\n/);
  let listKey = '';
  for (const line of lines) {
    const list = line.match(/^\s+-\s+(.+)$/);
    if (list && listKey) {
      result[listKey].push(unquote(list[1]));
      continue;
    }
    const field = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
    if (!field) continue;
    listKey = field[1];
    result[listKey] = field[2] ? unquote(field[2]) : [];
  }
  return result;
}

function firstHeading(content, fallback) {
  return (content.match(/^#\s+(.+)$/m) || [])[1]?.trim() || fallback;
}

function compactText(content) {
  return content
    .replace(/^---[\s\S]*?^---\s*/m, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/[`*_#|>\[\](){}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8000);
}

function yamlString(value) {
  return JSON.stringify(String(value || ''));
}

function titleKey(value) {
  return String(value || '').toLowerCase().replace(/[\s`*_#|，。；：、,.!?！？:;()（）\[\]【】<>《》"'“”‘’/\\-]+/g, '');
}

// 上传合集是为批量上传准备的拼接文件；每个注释标记后仍是一张独立的精准知识卡。
// 编译时拆回卡片粒度，才能让“一个问题”准确命中其中的标准回复，而不是在 9 万字文件中丢失。
function splitBundleCards(content) {
  const markers = [...String(content || '').matchAll(/^<!--\s*([^\r\n]+?\.md)\s*-->\s*$/gm)];
  return markers.map((marker, index) => ({
    sourceName: marker[1].trim(),
    content: String(content || '').slice(marker.index + marker[0].length, markers[index + 1]?.index).trim(),
  })).filter(card => card.content);
}

function buildPage(sourcePath, pageType, content, meta, title) {
  const relativeSource = path.relative(projectRoot, sourcePath).replace(/\\/g, '/');
  const aliases = Array.isArray(meta.aliases) ? meta.aliases : [];
  return [
    '---',
    `wiki_type: ${yamlString(pageType)}`,
    `title: ${yamlString(title)}`,
    `source_path: ${yamlString(relativeSource)}`,
    `source_doc_type: ${yamlString(meta.doc_type || '')}`,
    `product_name: ${yamlString(meta.product_name || '')}`,
    `generated: true`,
    aliases.length ? `aliases:\n${aliases.map(value => `  - ${yamlString(value)}`).join('\n')}` : 'aliases: []',
    '---',
    '',
    `> [!source] 原始来源`,
    `> [[${relativeSource.replace(/\.md$/i, '')}]]`,
    '> 本页由编译脚本生成。事实冲突时必须回查原始来源，不得在本页自行补全。',
    '',
    content.replace(/^---[\s\S]*?^---\s*/m, '').trim(),
    '',
  ].join('\n');
}

function cleanOutputDir(dir) {
  ensureDir(dir);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) fs.unlinkSync(path.join(dir, entry.name));
  }
}

function main() {
  const wikiDir = path.join(wikiRoot, 'wiki');
  const indexDir = path.join(wikiRoot, 'index');
  ensureDir(indexDir);
  ensureDir(path.join(wikiRoot, 'review'));
  ensureDir(path.join(wikiRoot, 'tests'));
  const entries = [];
  const counts = {};
  const factTitles = new Set();

  for (const source of sources) {
    const outputDir = path.join(wikiDir, source.output);
    cleanOutputDir(outputDir);
    const files = listMarkdown(source.dir).sort((a, b) => a.localeCompare(b, 'zh-CN'));
    counts[source.pageType] = files.length;
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const meta = parseFrontmatter(content);
      const baseName = path.basename(file, '.md');
      const title = firstHeading(content, baseName.replace(/^\d+_/, ''));
      const outputName = `${baseName}.md`;
      const outputPath = path.join(outputDir, outputName);
      fs.writeFileSync(outputPath, buildPage(file, source.pageType, content, meta, title), 'utf8');
      const wikiPath = path.relative(wikiRoot, outputPath).replace(/\\/g, '/');
      const sourcePath = path.relative(projectRoot, file).replace(/\\/g, '/');
      const aliases = Array.isArray(meta.aliases) ? meta.aliases : [];
      const keywords = Array.isArray(meta.keywords) ? meta.keywords : [];
      entries.push({
        id: `${source.pageType}:${baseName}`,
        pageType: source.pageType,
        title,
        productName: meta.product_name || '',
        aliases,
        keywords,
        topic: meta.topic || meta.major_category || '',
        series: meta.series || '',
        sourcePath,
        wikiPath,
        searchText: [title, meta.product_name, meta.heading_path, meta.topic, meta.major_category, meta.series, ...aliases, ...keywords, compactText(content)].filter(Boolean).join(' '),
      });
      if (source.pageType === 'fact') factTitles.add(titleKey(title));
    }
  }

  // 精准知识卡源文件中没有、但已在上传合集中维护的补充卡，也要进入 Wiki。
  // 同标题的原始精准卡优先，避免同一事实重复占据检索结果。
  let bundleAdded = 0;
  for (const bundleFile of listMarkdown(bundleDir).sort((a, b) => a.localeCompare(b, 'zh-CN'))) {
    const bundleContent = fs.readFileSync(bundleFile, 'utf8');
    for (const card of splitBundleCards(bundleContent)) {
      const meta = parseFrontmatter(card.content);
      const title = firstHeading(card.content, path.basename(card.sourceName, '.md').replace(/^\d+_/, ''));
      if (!title || factTitles.has(titleKey(title))) continue;
      const baseName = `${path.basename(bundleFile, '.md')}__${path.basename(card.sourceName, '.md')}`;
      const outputPath = path.join(wikiDir, 'facts', `${baseName}.md`);
      fs.writeFileSync(outputPath, buildPage(bundleFile, 'fact', card.content, meta, title), 'utf8');
      const aliases = Array.isArray(meta.aliases) ? meta.aliases : [];
      const keywords = Array.isArray(meta.keywords) ? meta.keywords : [];
      entries.push({
        id: `fact:bundle:${baseName}`,
        pageType: 'fact',
        title,
        productName: meta.product_name || '',
        aliases,
        keywords,
        topic: meta.topic || meta.major_category || '',
        series: meta.series || '',
        sourcePath: path.relative(projectRoot, bundleFile).replace(/\\/g, '/'),
        wikiPath: path.relative(wikiRoot, outputPath).replace(/\\/g, '/'),
        searchText: [title, meta.product_name, meta.heading_path, meta.topic, meta.major_category, meta.series, ...aliases, ...keywords, compactText(card.content)].filter(Boolean).join(' '),
      });
      factTitles.add(titleKey(title));
      bundleAdded += 1;
    }
  }
  counts.fact = (counts.fact || 0) + bundleAdded;

  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceRoot: path.relative(projectRoot, knowledgeRoot).replace(/\\/g, '/'),
    counts,
    entries,
  };
  fs.writeFileSync(path.join(indexDir, 'knowledge-index.json'), JSON.stringify(payload, null, 2), 'utf8');

  const groups = Object.entries(counts).map(([type, count]) => `- ${type}: ${count} 页`).join('\n');
  const indexMd = [
    '# 酷太产品 LLM Wiki',
    '',
    `生成时间：${payload.generatedAt}`,
    '',
    groups,
    '',
    '## 入口',
    '',
    '- [[facts/index|基础产品事实]]',
    '- [[applications/index|产品应用]]',
    '- [[planning/index|规划师知识]]',
    '- [[../review/README|待人工审核]]',
    '',
    '> Wiki 是来源资料的可查询编译层，不是独立事实源。',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(wikiDir, 'index.md'), indexMd, 'utf8');

  for (const source of sources) {
    const pages = entries.filter(entry => entry.pageType === source.pageType);
    const lines = [`# ${source.pageType} 页面索引`, '', ...pages.map(page => `- [[${path.basename(page.wikiPath, '.md')}|${page.title}]]`), ''];
    fs.writeFileSync(path.join(wikiDir, source.output, 'index.md'), lines.join('\n'), 'utf8');
  }
  fs.writeFileSync(path.join(wikiRoot, 'review', 'README.md'), '# 待人工审核\n\n来源冲突、缺失事实和低置信度问题记录在这里。确认后应先修改原始知识卡，再重新编译。\n', 'utf8');
  console.log(`[LLM Wiki] 编译完成：${entries.length} 页（fact=${counts.fact || 0}, application=${counts.application || 0}, planning=${counts.planning || 0}）`);
  console.log(`[LLM Wiki] 索引：${path.join(indexDir, 'knowledge-index.json')}`);
}

main();
