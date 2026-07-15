'use strict';

// DWS CLI 当前经 Windows cmd 调用；统一在此处做参数转义，避免不同入口出现不一致实现。
function quoteForShell(value) {
  return `"${String(value)
    .replace(/"/g, '\\"')
    .replace(/[%^&|<>]/g, '^$&')
    .replace(/\r?\n/g, ' ')}"`;
}

module.exports = { quoteForShell };
