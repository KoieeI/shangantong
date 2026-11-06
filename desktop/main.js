/* 上岸通 · 桌面版主进程
   设计取舍：
   - 直接加载线上站点，不做本地副本：数据仍在 Supabase，桌面端和网页/小程序看到的是同一份档案；
   - 只开一个窗口，菜单栏隐藏，外观与浏览器标签页几乎一致，但独立任务栏图标、可用快捷键刷新；
   - 外链一律交给系统浏览器，避免在应用内被钓鱼页面困住；
   - 窗口大小/位置记忆在 userData 里，下次打开还原。 */
'use strict';
const { app, BrowserWindow, shell, Menu, dialog, session } = require('electron');
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

   【静默更新：全程不弹任何窗口】
   旧版在下载完成后会弹一个「有新版本 / 立即重启-稍后」的对话框，
   用户反馈这个浮窗打断操作。现在改为：
   1. 后台下载，不提示；
   2. 下载完也不弹窗，只标记 ready，等用户自己关闭应用时由安装器静默替换
      （autoInstallOnAppQuit 已在安装阶段接管，不会打断当前会话）；
   3. 若用户开了「使用中」，下次启动即已是新版本，没有任何感知成本。

   前提（缺一个就会静默失效，CI 里已配套）：
   1. Release 必须带 latest.yml 与 *.blockmap；
   2. 每个新包的版本号必须递增（构建时用 run_number 写进 package.json）；
   3. 包名必须与 latest.yml 里登记的一致（用 artifactName 固定，不在 Release 里改名）。 */
let updateReady = false;
function setupAutoUpdate() {
  if (process.platform !== 'win32') return;
  let autoUpdater;
  try { autoUpdater = require('electron-updater').autoUpdater; } catch (e) { return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;   /* 退出时静默装，替代弹窗里的「立即重启」 */
  autoUpdater.allowPrerelease = false;
  autoUpdater.autoRunAppAfterInstall = true;

  /* 断网、还没发过 Release、证书问题一律静默：更新不该打扰使用 */
  autoUpdater.on('error', () => { });
  autoUpdater.on('update-available', () => { /* 静默：不提示「发现新版本」 */ });
  autoUpdater.on('update-not-available', () => { });
  autoUpdater.on('update-downloaded', () => {
    /* 静默：只打一行主进程日志，绝不弹窗。下次正常退出时自动装好，
       用户下次打开就是新版，数据与登录状态保持不变。 */
    updateReady = true;
    try { console.log('[update] 新版本已下载，将在退出应用时静默安装'); } catch (e) { }
  });

  /* 先让人把首页用起来，3 秒后再查；之后每 6 小时一次 */
  setTimeout(() => { autoUpdater.checkForUpdates().catch(() => { }); }, 3000);
  setInterval(() => { autoUpdater.checkForUpdates().catch(() => { }); }, 6 * 3600 * 1000);
}

/* 预留：给网页端查「是否有更新就绪」用（目前网页不调用，保持接口稳定）
   通过 preload 注入不合适（sandbox 已开），所以只暴露在主进程内部，
   未来若要加设置页再走 IPC。 */
function isUpdateReady() { return updateReady; }

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

/* ---------- 下载处理 ----------
   WebView 里的 <a download>（导出备份、导出 .ics、文档转换产物）默认会被丢弃，
   这是"在软件里点了导出但什么都没发生"的原因。

   【静默保存：不弹保存对话框、不弹完成提示】
   旧版每次导出都要先弹「另存为」、下完再弹「已保存」，两次打断。
   现在统一保存到系统的「下载」目录，文件名同名时自动加 (1)(2) 后缀，
   失败（如目录只读）才退回保存对话框，确保导出不会悄无声息地失败。 */
function setupDownloads() {
  const ses = (win && win.webContents ? win.webContents.session : session.defaultSession);
  if (!ses || ses.__dlHooked) return;
  ses.__dlHooked = true;
  ses.on('will-download', (e, item, wc) => {
    try {
      const dir = app.getPath('downloads') || app.getPath('documents');
      const name = item.getFilename() || '上岸通导出文件';
      item.setSavePath(uniquePath(dir, name));
    } catch (err) {
      /* 取不到下载目录（极端情况）：保持默认行为，仍可手动选位置 */
    }
    item.once('done', (ev, state) => {
      try {
        console.log('[download] ' + state + ' -> ' + (item.getSavePath ? item.getSavePath() : ''));
      } catch (e) { }
      if (state === 'interrupted' || state === 'failed') {
        /* 真正失败时才提示一次，避免用户以为导出成功却找不到文件 */
        dialog.showMessageBox(win || null, {
          type: 'warning',
          title: '保存失败',
          message: '文件没能保存',
          detail: '可以再导出一次；也可以直接在浏览器里打开网页版导出。',
          buttons: ['知道了'],
          noLink: true
        }).catch(() => { });
      }
    });
  });
}

/* 同名文件自动加 (1)(2)…，避免静默覆盖用户已有的备份 */
function uniquePath(dir, name) {
  const fsx = require('fs');
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = path.join(dir, name);
  let i = 1;
  while (fsx.existsSync(candidate) && i < 1000) {
    candidate = path.join(dir, base + '(' + i + ')' + ext);
    i++;
  }
  return candidate;
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
    setupDownloads();
    setupAutoUpdate();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
