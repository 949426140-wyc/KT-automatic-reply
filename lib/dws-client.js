'use strict';

const { execSync } = require('child_process');
const { quoteForShell } = require('./shell');

function parseDwsJson(output) {
  const text = String(output || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) {}
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(text.slice(first, last + 1)); } catch (_) {}
  }
  return { raw: text };
}

function runDws(args, { cwd, timeout = 30000, maxBuffer = 20 * 1024 * 1024 } = {}) {
  const finalArgs = [...args];
  if (!finalArgs.includes('--format') && !finalArgs.includes('-f')) finalArgs.push('--format', 'json');
  if (!finalArgs.includes('-y') && !finalArgs.includes('--yes')) finalArgs.push('-y');
  const output = execSync(`dws ${finalArgs.map(quoteForShell).join(' ')}`, {
    cwd,
    encoding: 'utf-8',
    timeout,
    maxBuffer,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return parseDwsJson(output);
}

module.exports = { parseDwsJson, runDws };
