const fs = require('fs');
const path = require('path');

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[\s`*_#|，。；：、,.!?！？:;()（）\[\]【】<>《》"'“”‘’/\\-]+/g, '');
}

function chineseBigrams(value) {
  const text = normalize(value);
  const grams = new Set();
  for (let i = 0; i < text.length - 1; i += 1) grams.add(text.slice(i, i + 2));
  return [...grams];
}

function expandQueryTerms(value) {
  const text = normalize(value);
  const terms = new Set();
  const mappings = [
    [/定深|做深/g, ['深度定制', '抽屉深度', '抽深']],
    [/锅具抽|碗碟抽|工具抽|调料抽/g, ['抽屉']],
    [/能不能|可不可以|能否/g, ['判断', '适配']],
    [/装不装得下|能装吗/g, ['安装', '适配']],
    [/怎么介绍|介绍一下/g, ['介绍', '话术']],
  ];
  for (const [pattern, expansions] of mappings) {
    if (pattern.test(text)) expansions.forEach(term => terms.add(normalize(term)));
  }
  for (const term of ['尺寸', '宽度', '深度', '高度', '安装', '孔位', '承重', '材质', '结构', '别名', '选型', '适配', '兼容', '介绍', '话术', '空间', '收纳']) {
    if (text.includes(term)) terms.add(term);
  }
  return [...terms];
}

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return null;
  }
}

class LlmWiki {
  constructor(options = {}) {
    this.root = options.root || path.resolve(__dirname, '..', '..', '产品知识库', 'LLM-Wiki');
    this.indexFile = options.indexFile || path.join(this.root, 'index', 'knowledge-index.json');
    this.maxPages = Number(options.maxPages || 6);
    this.minScore = Number(options.minScore || 18);
    this.entries = [];
    this.generatedAt = '';
    this.indexMtimeMs = 0;
  }

  load() {
    const payload = safeReadJson(this.indexFile);
    this.entries = Array.isArray(payload?.entries) ? payload.entries : [];
    this.generatedAt = payload?.generatedAt || '';
    try { this.indexMtimeMs = fs.statSync(this.indexFile).mtimeMs; } catch { this.indexMtimeMs = 0; }
    return this.entries.length;
  }

  reloadIfChanged() {
    try {
      const mtimeMs = fs.statSync(this.indexFile).mtimeMs;
      if (mtimeMs > this.indexMtimeMs) this.load();
    } catch (error) {}
  }

  score(entry, query) {
    const q = normalize(query);
    if (!q) return 0;
    const title = normalize(entry.title);
    const productName = normalize(entry.productName);
    const aliases = (entry.aliases || []).map(normalize).filter(Boolean);
    const keywords = (entry.keywords || []).map(normalize).filter(Boolean);
    const searchable = normalize(entry.searchText);
    const expandedTerms = expandQueryTerms(query);
    let score = entry.pageType === 'fact' ? 6 : entry.pageType === 'application' ? 3 : 1;

    if (title && q.includes(title)) score += 90 + Math.min(title.length, 30);
    if (productName && q.includes(productName)) score += 110 + Math.min(productName.length, 30);
    for (const alias of aliases) {
      if (alias.length >= 2 && q.includes(alias)) score += 100 + Math.min(alias.length, 25);
    }
    for (const keyword of keywords) {
      if (keyword.length >= 2 && q.includes(keyword)) score += 42 + Math.min(keyword.length, 20);
      else if (q.length >= 3 && keyword.includes(q)) score += 18;
    }

    const intentTerms = ['尺寸', '宽度', '深度', '高度', '安装', '孔位', '承重', '材质', '结构', '别名', '选型', '适配', '兼容', '介绍', '话术', '空间', '收纳'];
    for (const term of intentTerms) {
      if (q.includes(term) && searchable.includes(term)) score += 9;
    }
    for (const term of expandedTerms) {
      if (term.length >= 2 && searchable.includes(term)) score += 16 + Math.min(term.length, 12);
    }

    // 参数类问题优先命中同参数的事实卡，避免系列名很强时把“深度体系”挤出证据页。
    const parameterIntents = ['标准规格', '标准品', '宽度', '深度', '高度', '定制', '轨道规格'];
    for (const intent of parameterIntents) {
      const normalizedIntent = normalize(intent);
      if (!q.includes(normalizedIntent)) continue;
      if (title.includes(normalizedIntent)) score += 38;
      else if (searchable.includes(normalizedIntent)) score += 14;
    }
    if (q.includes(normalize('深度定制')) && searchable.includes(normalize('深度定制'))) score += 45;
    if (q.includes(normalize('标准规格')) && searchable.includes(normalize('标准回复字段'))) score += 24;

    const grams = chineseBigrams(q);
    let matchedGrams = 0;
    for (const gram of grams) if (searchable.includes(gram)) matchedGrams += 1;
    if (grams.length) score += Math.min(24, (matchedGrams / grams.length) * 24);
    return Math.round(score * 100) / 100;
  }

  query(question, options = {}) {
    if (!this.entries.length) this.load();
    else this.reloadIfChanged();
    const limit = Number(options.limit || this.maxPages);
    const minScore = Number(options.minScore ?? this.minScore);
    const allowedPageTypes = Array.isArray(options.pageTypes) && options.pageTypes.length
      ? new Set(options.pageTypes)
      : null;
    const excludePattern = options.excludePattern instanceof RegExp ? options.excludePattern : null;
    return this.entries
      .filter(entry => !allowedPageTypes || allowedPageTypes.has(entry.pageType))
      .filter(entry => !excludePattern || !excludePattern.test(`${entry.title || ''}\n${entry.topic || ''}\n${entry.sourcePath || ''}`))
      .map(entry => ({ ...entry, score: this.score(entry, question) }))
      .filter(entry => entry.score >= minScore)
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'zh-CN'))
      .slice(0, limit)
      .map(entry => {
        const wikiPath = path.join(this.root, entry.wikiPath);
        let content = '';
        try { content = fs.readFileSync(wikiPath, 'utf8'); } catch (error) {}
        return { ...entry, content };
      });
  }

  buildPrompt(question, options = {}) {
    const pages = this.query(question, options);
    if (!pages.length) return { pages: [], prompt: '' };
    const prompt = pages.map((page, index) => [
      `===== LLM Wiki 证据 ${index + 1}：${page.title} =====`,
      `页面类型：${page.pageType}`,
      `原始来源：${page.sourcePath}`,
      page.content,
    ].join('\n')).join('\n\n');
    return { pages, prompt };
  }
}

module.exports = { LlmWiki, normalize, chineseBigrams, expandQueryTerms };
