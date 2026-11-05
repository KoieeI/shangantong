/* 上岸通 · 桌面版主进程
   设计取舍：
   - 直接加载线上站点，不做本地副本：数据仍在 Supabase，桌面端和网页/小程序看到的是同一份档案；
   - 只开一个窗口，菜单栏隐藏，外观与浏览器标签页几乎一致，但独立任务栏图标、可用快捷键刷新；
   - 外链一律交给系统浏览器，避免在应用内被钓鱼页面困住；
   - 窗口大小/位置记忆在 userData 里，下次打开还原。 */
'use strict';
const { app, BrowserWindow, shell, Menu, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

const APP_URL = 'https://civil-service-workbench.app.workbuddy.host/?sharecode=GCYR427BEX';
const ALLOW_HOST = 'civil-service-workbench.app.workbuddy.host';
const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');

function loadState() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (j && typeof j.width === 'number' && typeof j.height === 'number') return j;
  } catch (e) { }
  return { width: 1320, height: 880 };
}

function saveState(win) {
  try {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    const b = win.getNormalBounds ? win.getNormalBounds() : win.getBounds();
    fs.writeFileSync(STATE_FILE, JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height, max: win.isMaximized() }));
  } catch (e) { }
}

let win = null;

/* ---------- 应用内更新（仅 Windows 安装版） ----------
   走 electron-updater + NSIS：靠 Release 里的 latest.yml 比对版本，
   下载时走 blockmap 差分，只取变化的块（通常 1–5MB，而不是 78MB 整包）。
   下载完弹一次「重启即可」，重启后安装器静默替换，用户不用再去 Releases 下载。

   前提（缺一个就会静默失效，CI 里已配套）：
   1. Release 必须带 latest.yml 与 *.blockmap；
   2. 每个新包的版本号必须递增（构建时用 run_number 写进 package.json）；
   3. 包名必须与 latest.yml 里登记的一致（用 artifactName 固定，不在 Release 里改名）。 */
function setupAutoUpdate() {
  if (process.platform !== 'win32') return;
  let autoUpdater;
  try { autoUpdater = require('electron-updater').autoUpdater; } catch (e) { return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  /* 断网、还没发过 Release、证书问题一律静默：更新不该打扰使用 */
  autoUpdater.on('error', () => { });
  autoUpdater.on('update-downloaded', info => {
    const v = info && info.version ? 'v' + info.version : '';
    dialog.showMessageBox(win || null, {
      type: 'info',
      title: '有新版本',
      message: '上岸通 ' + v + ' 已下载完成',
      detail: '重启应用即可完成更新，当前数据和登录状态都不会丢。',
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    }).then(r => { if (r.response === 0) autoUpdater.quitAndInstall(true, true); }).catch(() => { });
  });
  /* 先让人把首页用起来，3 秒后再查；之后每 6 小时一次 */
  setTimeout(() => { autoUpdater.checkForUpdates().catch(() => { }); }, 3000);
  setInterval(() => { autoUpdater.checkForUpdates().catch(() => { }); }, 6 * 3600 * 1000);
}

function createWindow() {
  const st = loadState();
  win = new BrowserWindow({
    width: st.width,
    height: st.height,
    x: st.x,
    y: st.y,
    minWidth: 960,
    minHeight: 620,
    title: '上岸通',
    backgroundColor: '#f5f6f8',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  if (st.max) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.loadURL(APP_URL);

  /* 站内跳转留在窗口里，站外链接交给系统浏览器 */
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (new URL(url).host !== ALLOW_HOST) { shell.openExternal(url); return { action: 'deny' }; }
    } catch (e) { }
    return { action: 'allow' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    try {
      if (new URL(url).host !== ALLOW_HOST) { e.preventDefault(); shell.openExternal(url); }
    } catch (err) { }
  });

  win.on('close', () => saveState(win));
  win.on('closed', () => { win = null; });
}

/* 单实例：重复点击图标时聚焦已有窗口，而不是开出第二个 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    createWindow();
    setupAutoUpdate();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
