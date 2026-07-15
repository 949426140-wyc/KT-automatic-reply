/*
 * 一次性迁移工具：把旧 Dify 上传包中主库没有的精准口径迁回章节矩阵。
 * 主库是唯一可编辑事实源；此脚本不会复制已存在标题的旧卡，避免重新制造两套口径。
 */
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');
const difyRoot = process.env.DIFY_SOURCE_ROOT || path.join(projectRoot, 'Dify知识库导入包');
const mainRoot = process.env.MAIN_KNOWLEDGE_ROOT || path.join(projectRoot, '产品知识库');
const bundleRoot = path.join(difyRoot, '_Dify上传合集');
const matrixRoot = path.join(mainRoot, '01_MD章节矩阵');
const recordRoot = path.join(mainRoot, '99_清理记录');
const apply = process.argv.includes('--apply');
const refresh = process.argv.includes('--refresh');

const specialChapters = new Map([
  ['07_规划师方案话术框架.md', '12-规划师方案话术框架.md'],
  ['08_空间痛点诊断与方案表达.md', '13-空间痛点诊断与方案表达.md'],
  ['09_客户画像异议与服务边界.md', '14-客户画像异议与服务边界.md'],
  ['10_魔法抽产品介绍话术专项.md', '15-魔法抽产品介绍话术专项.md'],
]);

function listMarkdown(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap(entry => entry.isDirectory() ? listMarkdown(path.join(dir, entry.name)) : entry.name.endsWith('.md') ? [path.join(dir, entry.name)] : []);
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[\s`*_#|，。；：、,.!?！？:;()（）\[\]【】<>《》"'“”‘’/\\-]+/g, '');
}

function splitBundleCards(content) {
  const source = String(content || '');
  const markers = [...source.matchAll(/^<!--\s*([^\r\n]+?\.md)\s*-->\s*$/gm)];
  return markers.map((marker, index) => ({
    sourceName: marker[1].trim(),
    content: source.slice(marker.index + marker[0].length, markers[index + 1]?.index).trim(),
  })).filter(card => card.content);
}

function cardTitle(card) {
  return (card.content.match(/^#\s+(.+)$/m) || [])[1]?.trim() || path.basename(card.sourceName, '.md').replace(/^\d+_/, '');
}

function stripFrontmatter(content) {
  return String(content || '').replace(/^---\s*[\s\S]*?\n---\s*/m, '').trim();
}

function renderCardSection(card) {
  const title = cardTitle(card);
  let body = stripFrontmatter(card.content);
  body = body.replace(/^#\s+.+\r?\n?/m, '').trim();
  // 外层 ## 是这张规则卡的检索标题；原卡内部标题全部降级，避免编译器把“标准回复示例”
  // 之类的小标题误当成独立规则页。
  body = body.replace(/^(#{1,6})(\s+)/gm, (_, hashes, whitespace) => `${'#'.repeat(Math.min(6, hashes.length + 2))}${whitespace}`);
  return [
    '---',
    '',
    `## ${title}`,
    '',
    `> 迁入来源：旧 Dify 精准知识卡 ${card.sourceName}`,
    '',
    body,
    '',
  ].join('\n');
}

function headingsInFile(file) {
  const titles = new Set();
  const text = fs.readFileSync(file, 'utf8');
  for (const match of text.matchAll(/^#{1,6}\s+(.+)$/gm)) titles.add(normalize(match[1]));
  return titles;
}

function existingHeadings() {
  const titles = new Set();
  const generatedTargets = new Set([...specialChapters.values(), '16-自动回复精准规则补充.md']);
  for (const file of listMarkdown(matrixRoot)) {
    if (refresh && generatedTargets.has(path.basename(file))) continue;
    for (const title of headingsInFile(file)) titles.add(title);
  }
  return titles;
}

function buildSpecialChapter(bundleFile, cards) {
  const title = path.basename(bundleFile, '.md').replace(/^\d+_/, '');
  return [
    `# ${title}`,
    '',
    '> 本章节由旧 Dify 上传合集迁入，现为产品知识库的正式维护源。以后只在本章节维护，不再维护 Dify 上传副本。',
    '',
    ...cards.map(renderCardSection),
  ].join('\n');
}

function dateStamp() {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
}

function main() {
  if (!fs.existsSync(bundleRoot)) throw new Error(`未找到旧 Dify 上传合集：${bundleRoot}`);
  if (!fs.existsSync(matrixRoot)) throw new Error(`未找到主库章节矩阵：${matrixRoot}`);

  const bundles = listMarkdown(bundleRoot).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const existing = existingHeadings();
  const migratedSpecial = [];
  const supplemental = [];
  let alreadyPresent = 0;

  for (const bundleFile of bundles) {
    const bundleName = path.basename(bundleFile);
    const cards = splitBundleCards(fs.readFileSync(bundleFile, 'utf8'));
    const specialTarget = specialChapters.get(bundleName);
    if (specialTarget) {
      migratedSpecial.push({ bundleName, target: specialTarget, cards });
      for (const card of cards) existing.add(normalize(cardTitle(card)));
      continue;
    }

    for (const card of cards) {
      const key = normalize(cardTitle(card));
      if (!key || existing.has(key)) {
        alreadyPresent += 1;
        continue;
      }
      supplemental.push({ bundleName, card });
      existing.add(key);
    }
  }

  const supplementName = '16-自动回复精准规则补充.md';
  const outputs = [
    ...migratedSpecial.map(item => ({
      file: path.join(matrixRoot, item.target),
      content: buildSpecialChapter(item.bundleName, item.cards),
      titles: item.cards.map(cardTitle),
    })),
  ];
  if (supplemental.length) {
    outputs.push({
      file: path.join(matrixRoot, supplementName),
      content: [
        '# 自动回复精准规则补充',
        '',
        '> 本章节只收录旧 Dify 上传包中主库原章节没有的补充口径。现为正式主库内容。',
        '',
        ...supplemental.map(item => renderCardSection(item.card)),
      ].join('\n'),
      titles: supplemental.map(item => cardTitle(item.card)),
    });
  }

  const report = [
    '# Dify 知识迁入章节主库记录',
    '',
    `- 日期：${new Date().toISOString()}`,
    `- 旧来源：${bundleRoot}`,
    `- 主库：${matrixRoot}`,
    `- 迁入规划师/话术章节：${migratedSpecial.reduce((sum, item) => sum + item.cards.length, 0)} 张卡`,
    `- 迁入其他主库缺失卡：${supplemental.length} 张`,
    `- 已存在而未重复迁入：${alreadyPresent} 张`,
    '',
    '## 生成章节',
    '',
    ...outputs.map(item => `- ${path.basename(item.file)}：${item.titles.length} 个口径`),
    '',
    '## 验证方式',
    '',
    '- 每个迁入标题均在对应主库章节中存在。',
    '- 旧 Dify 目录删除后，由主库重新编译 LLM Wiki 并运行检索/回归测试。',
    '',
  ].join('\n');

  if (apply) {
    for (const output of outputs) fs.writeFileSync(output.file, output.content, 'utf8');
    fs.mkdirSync(recordRoot, { recursive: true });
    fs.writeFileSync(path.join(recordRoot, `Dify迁入章节知识库_${dateStamp()}.md`), report, 'utf8');
  }

  const verification = outputs.every(output => {
    const text = apply ? fs.readFileSync(output.file, 'utf8') : output.content;
    return output.titles.every(title => new RegExp(`^#{1,6}\\s+${String(title).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(text));
  });
  if (!verification) throw new Error('迁入标题验证失败');

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    specialChapters: migratedSpecial.map(item => ({ file: item.target, cards: item.cards.length })),
    supplementalCards: supplemental.length,
    alreadyPresent,
    outputFiles: outputs.map(item => path.basename(item.file)),
    verified: verification,
  }, null, 2));
}

main();
