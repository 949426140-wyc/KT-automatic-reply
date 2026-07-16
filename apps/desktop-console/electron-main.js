const { app, BrowserWindow, Menu, Tray, nativeImage } = require('electron');

function writeMainProcessDiagnostic(error) {
  try {
    const fs = require('fs');
    const path = require('path');
    const line = `[${new Date().toISOString()}] ${error?.stack || error?.message || error}\n`;
    fs.appendFileSync(path.join(__dirname, 'console-main-errors.log'), line, 'utf8');
  } catch {}
}

// Docker CLI 的日志输出管道偶发提前关闭时，Node 会抛出 EPIPE。
// 该异常只记录、不弹出 Electron 主进程错误框，也不会影响后台机器人容器。
process.on('uncaughtException', (error) => {
  if (error?.code === 'EPIPE') {
    writeMainProcessDiagnostic(error);
    return;
  }
  writeMainProcessDiagnostic(error);
  throw error;
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  process.env.KUTAI_CONSOLE_EMBEDDED = '1';
  require('./server');
}

let mainWindow = null;
let tray = null;
let isQuitting = false;
let hideNoticeShown = false;

function createTrayIcon() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      <rect x="1" y="1" width="30" height="30" rx="8" fill="#60a5fa"/>
      <rect x="1" y="1" width="30" height="30" rx="8" fill="none" stroke="#bfdbfe" stroke-width="2"/>
      <text x="16" y="21" text-anchor="middle" font-family="Arial, sans-serif" font-size="13" font-weight="700" fill="#0f172a">KT</text>
    </svg>`;
  const dataUrl = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
  return nativeImage.createFromDataURL(dataUrl).resize({ width: 20, height: 20 });
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  console.log('[\u6258\u76d8] \u6253\u5f00\u63a7\u5236\u53f0\u7a97\u53e3');
  mainWindow.setSkipTaskbar(false);
  mainWindow.show();
  mainWindow.maximize();
  mainWindow.focus();
}

function quitApplication() {
  isQuitting = true;
  if (tray && !tray.isDestroyed()) tray.destroy();
  app.quit();
}

async function createTray() {
  if (tray && !tray.isDestroyed()) return;

  let icon = createTrayIcon();
  if (icon.isEmpty()) icon = await app.getFileIcon(process.execPath, { size: 'small' });
  tray = new Tray(icon);
  tray.setToolTip('\u9177\u592a\u670d\u52a1\u5668\u63a7\u5236\u53f0\uff08\u8fd0\u884c\u4e2d\uff09');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '\u9177\u592a\u670d\u52a1\u5668\u6b63\u5728\u8fd0\u884c', enabled: false },
    { type: 'separator' },
    { label: '\u6253\u5f00\u63a7\u5236\u53f0', click: showWindow },
    { type: 'separator' },
    { label: '\u9000\u51fa\u9177\u592a\u670d\u52a1\u5668', click: quitApplication },
  ]));
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: '\u9177\u592a\u670d\u52a1\u5668\u63a7\u5236\u53f0',
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    frame: true,
    fullscreen: false,
    autoHideMenuBar: true,
    backgroundColor: '#0f172a',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
  });

  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
    mainWindow.setSkipTaskbar(true);
    console.log('[\u7a97\u53e3] \u5df2\u9690\u85cf\u5230\u7cfb\u7edf\u6258\u76d8\uff0c\u670d\u52a1\u7ee7\u7eed\u8fd0\u884c');
    if (!hideNoticeShown && tray && !tray.isDestroyed()) {
      hideNoticeShown = true;
      tray.displayBalloon({
        title: '\u9177\u592a\u670d\u52a1\u5668\u4ecd\u5728\u8fd0\u884c',
        content: '\u7a97\u53e3\u5df2\u9690\u85cf\u5230\u53f3\u4e0b\u89d2\u6258\u76d8\uff0c\u9700\u8981\u505c\u6b62\u65f6\u8bf7\u4ece\u6258\u76d8\u9000\u51fa\u3002',
      });
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadURL('http://127.0.0.1:43118');
}

app.setAppUserModelId('cn.kutai.autoReplyConsole');
if (hasSingleInstanceLock) app.whenReady().then(async () => {
  await createTray();
  createWindow();
});
app.on('second-instance', showWindow);
if (process.platform === 'darwin') app.on('activate', showWindow);
app.on('before-quit', () => {
  isQuitting = true;
});
app.on('window-all-closed', () => {
  // Windows/Linux 下保持托盘和本地服务器运行，只有托盘“退出”才结束进程。
});
