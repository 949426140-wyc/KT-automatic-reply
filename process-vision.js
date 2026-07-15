'use strict';

/**
 * 原图识别工作器。
 * 只接受钉钉提供的 downloadCode：先下载原图，再识别；缺 downloadCode 或下载失败时明确失败，
 * 绝不回退到缩略图、桌面缓存或按时间猜图。
 */
const fs = require('fs');
const path = require('path');
const { downloadOriginalMedia, recognizeImage } = require('./image-recognizer');

const DATA_DIR = path.join(__dirname, 'data');
const REQUEST_DIR = path.join(DATA_DIR, 'vision-requests');
const RESULT_DIR = path.join(DATA_DIR, 'vision-results');
const PROCESSED_DIR = path.join(REQUEST_DIR, 'processed');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeResult(name, result) {
  ensureDir(RESULT_DIR);
  fs.writeFileSync(path.join(RESULT_DIR, name), JSON.stringify(result, null, 2), 'utf-8');
}

function archiveRequest(file) {
  ensureDir(PROCESSED_DIR);
  const target = path.join(PROCESSED_DIR, file);
  if (fs.existsSync(target)) fs.rmSync(target);
  fs.renameSync(path.join(REQUEST_DIR, file), target);
}

async function processRequest(file) {
  const requestPath = path.join(REQUEST_DIR, file);
  let request;
  try {
    request = JSON.parse(fs.readFileSync(requestPath, 'utf-8'));
  } catch (error) {
    writeResult(file, { status: 'failed', reason: '请求文件不是有效 JSON', error: error.message, processedAt: new Date().toISOString() });
    archiveRequest(file);
    return;
  }

  const base = {
    requestId: request.requestId || path.parse(file).name,
    mediaId: request.mediaId || '',
    processedAt: new Date().toISOString(),
    source: 'dingtalk_original_media',
  };
  if (!request.downloadCode) {
    writeResult(file, { ...base, status: 'failed', reason: '缺少钉钉原图 downloadCode，禁止使用缩略图或缓存图识别' });
    archiveRequest(file);
    return;
  }

  try {
    const original = await downloadOriginalMedia({
      downloadCode: request.downloadCode,
      robotCode: request.robotCode || '',
      mediaId: request.mediaId || '',
    });
    const description = await recognizeImage(original.buffer);
    if (!description) throw new Error('视觉模型未返回可用识别结果');
    writeResult(file, {
      ...base,
      status: 'completed',
      bytes: original.buffer.length,
      imageSource: original.source || 'dingtalk_original_media',
      description,
    });
  } catch (error) {
    writeResult(file, { ...base, status: 'failed', reason: '原图下载或视觉识别失败', error: error.message });
  }
  archiveRequest(file);
}

async function main() {
  ensureDir(REQUEST_DIR);
  const files = fs.readdirSync(REQUEST_DIR).filter(file => file.endsWith('.json'));
  if (!files.length) {
    console.log('无待处理原图识别请求');
    return;
  }
  for (const file of files) await processRequest(file);
  console.log(`已处理 ${files.length} 个原图识别请求`);
}

main().catch(error => {
  console.error(`[原图识别工作器] 未处理异常: ${error.stack || error.message}`);
  process.exitCode = 1;
});
