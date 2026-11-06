/* =============================================================================
   上岸通 · App 内置兼容补丁（v1.0.17）
   -----------------------------------------------------------------------------
   为什么需要它：
   App 通过 server.url 远程加载网页，网页更新要能写进那个域名才生效。
   而 civil-service-workbench 这个域名归属另一个运行时，当前账号改不动；
   换域名又会让 localStorage（按 origin 隔离）里的打卡、笔记、待办全部读不到。

   所以这里走第三条路：**App 启动后把修复直接注入到页面里**。
   域名不变 → 数据不丢；补丁随 APK 分发 → 不依赖远程站点是否可写。

   执行方式：MainActivity 里 addWebViewListener，onPageLoaded 时
   evaluateJavascript(本文件内容)。每次页面加载都会跑一遍，必须幂等。

   幂等策略：
   1) 打标记 window.__gkPatch17；
   2) 若页面已是新版（NA.hasAllFiles 是函数），说明远程站点已更新，直接退出，
      避免两套逻辑打架。
   ============================================================================= */
(function () {
  'use strict';

  if (window.__gkPatch17) return;
  window.__gkPatch17 = true;

  /* 页面已是 v1.0.17 及以上（远程站点将来若更新，这里自动让位） */
  try {
    if (window.NA && typeof NA.hasAllFiles === 'function' && typeof NA.applyInsets === 'function') {
      window.__gkPatch17 = 'skipped';
      return;
    }
  } catch (e) { }

  var CAP = window.Capacitor || null;
  function plugin(n) { return (CAP && CAP.Plugins && CAP.Plugins[n]) || null; }
  function platform() {
    try { return (CAP && CAP.getPlatform && CAP.getPlatform()) || 'web'; } catch (e) { return 'web'; }
  }

  /* ===================== 1. 样式：安全区 + 触控 ===================== */
  var CSS = [
    ':root{--sat:env(safe-area-inset-top,0px);--sab:env(safe-area-inset-bottom,0px);',
    '--sal:env(safe-area-inset-left,0px);--sar:env(safe-area-inset-right,0px)}',
    'body{touch-action:manipulation;-webkit-tap-highlight-color:transparent}',
    '.topbar{padding-top:calc(12px + var(--sat));padding-left:calc(22px + var(--sal));',
    'padding-right:calc(22px + var(--sar))}',
    '@media(max-width:980px){',
    '.topbar{padding-top:calc(12px + var(--sat));padding-left:calc(16px + var(--sal));',
    'padding-right:calc(16px + var(--sar))}',
    '.rail{padding-top:calc(18px + var(--sat))}',
    '.view{padding-bottom:calc(72px + var(--sab))}',
    '.toasts{bottom:calc(24px + var(--sab))}',
    '.ft-pill{bottom:calc(18px + var(--sab));right:calc(18px + var(--sar))}',
    '.modal{max-height:calc(100vh - var(--sat) - var(--sab) - 24px);',
    'max-height:calc(100dvh - var(--sat) - var(--sab) - 24px)}',
    '.modal-f{padding-bottom:calc(16px + var(--sab))}',
    '.na-off{padding-bottom:calc(7px + var(--sab))}',
    '}',
    '@media(max-width:560px){.topbar{padding-top:calc(11px + var(--sat));',
    'padding-left:calc(12px + var(--sal));padding-right:calc(12px + var(--sar))}}',
    '@media(pointer:coarse){',
    '.icon-btn{width:44px;height:44px;border-radius:12px;position:relative}',
    '.icon-btn svg{width:18px;height:18px}',
    '.icon-btn::after{content:"";position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);',
    'width:max(100%,40px);height:max(100%,40px);border-radius:inherit}',
    '.btn{min-height:44px;padding:10px 15px;font-size:13.5px}',
    '.btn-s{min-height:40px;padding:8px 12px}',
    '.nav-i{min-height:46px}',
    '.chip{min-height:30px;padding:5px 11px}',
    '.hc-nav .icon-btn{width:36px;height:36px}',
    '.att-month .icon-btn{width:34px;height:34px}',
    '}',
    '@media(max-width:560px){.modal{width:calc(100vw - 24px)}',
    '.modal-f .btn{flex:1 1 0;min-height:44px}}',
    '@supports(-webkit-touch-callout:none){@media(max-width:980px){',
    'input,select,textarea{font-size:16px}}}',
    '.btn,.icon-btn,.nav-i{touch-action:manipulation;-webkit-user-select:none;user-select:none}'
  ].join('');

  function injectCSS() {
    if (document.getElementById('gk-patch17-css')) return;
    var st = document.createElement('style');
    st.id = 'gk-patch17-css';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  /* ===================== 2. 安全区计算 ===================== */
  var insetTimer = null;
  function applyInsets() {
    var NF = plugin('NativeFix');
    if (!NF || !NF.getInsets) return;
    var done = function (m) {
      if (!m) return;
      var top = Number(m.statusBar) || 0;
      var nav = Number(m.navBar) || 0;
      var webTop = Number(m.webTop);
      var fit = isFinite(webTop) && top > 0 && webTop >= top * 0.6;
      try {
        var root = document.documentElement;
        if (top > 0) root.style.setProperty('--sat', fit ? '0px' : top + 'px');
        if (nav > 0) root.style.setProperty('--sab', fit ? '0px' : nav + 'px');
      } catch (e) { }
    };
    try {
      var p = NF.getInsets();
      if (p && p.then) p.then(done).catch(function () { }); else done(p);
    } catch (e) { }
  }
  function scheduleInsets() {
    if (insetTimer) clearTimeout(insetTimer);
    insetTimer = setTimeout(applyInsets, 120);
  }

  /* ===================== 3. 导出（三级降级） ===================== */
  function toShareUrl(uri) {
    if (!uri || typeof uri !== 'string') return uri;
    try {
      if (uri.slice(0, 7) === 'file://') {
        var p = uri.slice(7);
        try { p = decodeURI(p); } catch (e) { }
        return 'file://' + encodeURI(p);
      }
    } catch (e) { }
    return uri;
  }
  function shareFile(uri, name) {
    if (!uri) return Promise.resolve();
    var SH = plugin('Share');
    if (!SH || !SH.share) return Promise.resolve();
    return Promise.resolve(SH.share({ title: name, url: toShareUrl(uri), dialogTitle: '导出文件' }))
      .catch(function () { });
  }
  function hasAllFiles() {
    if (platform() !== 'android') return Promise.resolve(true);
    var NF = plugin('NativeFix');
    if (!NF || !NF.hasAllFilesAccess) return Promise.resolve(null);
    return Promise.resolve(NF.hasAllFilesAccess())
      .then(function (r) { return !!(r && r.granted); })
      .catch(function () { return null; });
  }
  function ensureAllFiles() {
    if (platform() !== 'android') return Promise.resolve({ ok: true, state: 'notandroid' });
    var NF = plugin('NativeFix');
    if (!NF || !NF.requestAllFilesAccess) {
      return Promise.resolve({ ok: false, state: 'noplugin', err: '当前 App 版本还不支持「所有文件访问」，请更新安装包' });
    }
    return hasAllFiles().then(function (cur) {
      if (cur === true) return { ok: true, state: 'granted' };
      return Promise.resolve(NF.requestAllFilesAccess()).then(function () {
        return { ok: false, state: 'opened', err: '已打开系统授权页，请打开「允许管理所有文件」后返回' };
      });
    }).catch(function (e) {
      return { ok: false, state: 'error', err: String((e && e.message) || e) };
    });
  }

  function exportFile(name, text) {
    if (!CAP) return Promise.resolve({ ok: false, err: '非原生环境' });
    var FS = plugin('Filesystem');
    if (!FS || !FS.writeFile) return Promise.resolve({ ok: false, err: '文件插件未就绪，请重启 App 再试' });
    var safe = String(name || ('导出-' + Date.now())).replace(/[\\/:*?"<>|]/g, '_');
    var body = String(text == null ? '' : text);
    var android = platform() === 'android';

    if (android) {
      return hasAllFiles().then(function (all) {
        var chain = Promise.resolve();

        if (all === true) {
          chain = chain.then(function () {
            return FS.writeFile({
              path: 'Download/上岸通/' + safe, data: body,
              directory: 'EXTERNAL_STORAGE', encoding: 'UTF8', recursive: true
            }).then(function (r) {
              var uri = (r && r.uri) || '';
              return shareFile(uri, safe).then(function () {
                return { ok: true, uri: uri, dir: 'EXTERNAL_STORAGE', allFiles: true,
                         where: '手机「文件管理 → 下载 → 上岸通」（电脑连线也在这个目录）' };
              });
            }).catch(function () { return null; });
          });
        }

        return chain.then(function (hit) {
          if (hit) return hit;
          return FS.writeFile({
            path: '上岸通/' + safe, data: body,
            directory: 'DOCUMENTS', encoding: 'UTF8', recursive: true
          }).then(function (r) {
            var uri = (r && r.uri) || '';
            return shareFile(uri, safe).then(function () {
              return { ok: true, uri: uri, dir: 'DOCUMENTS', allFiles: all === true,
                       where: '手机「文件管理 → 文档 → 上岸通」' };
            });
          }).catch(function () { return null; });
        }).then(function (hit2) {
          if (hit2) return hit2;
          return FS.writeFile({
            path: '上岸通/' + safe, data: body,
            directory: 'EXTERNAL', encoding: 'UTF8', recursive: true
          }).then(function (r) {
            var uri = (r && r.uri) || '';
            return shareFile(uri, safe).then(function () {
              return { ok: true, uri: uri, dir: 'EXTERNAL', allFiles: false,
                       needAllFiles: all === false,
                       where: 'App 专属目录（文件管理 → Android/data → 上岸通 → files → 上岸通）' };
            });
          });
        }).catch(function (e) {
          return { ok: false, err: String((e && e.message) || e), needAllFiles: all === false };
        });
      });
    }

    return Promise.resolve(FS.writeFile({
      path: '上岸通/' + safe, data: body,
      directory: 'DOCUMENTS', encoding: 'UTF8', recursive: true
    })).then(function (r) {
      var uri = (r && r.uri) || '';
      return shareFile(uri, safe).then(function () {
        return { ok: true, uri: uri, dir: 'DOCUMENTS', where: '「文件」App → 我的 iPhone → 上岸通' };
      });
    }).catch(function (e) {
      return { ok: false, err: String((e && e.message) || e) };
    });
  }

  /* ===================== 4. 覆盖导出入口的提示文案 ===================== */
  function patchNA() {
    if (!window.NA) return;
    NA.exportFile = exportFile;
    NA.hasAllFiles = hasAllFiles;
    NA.ensureAllFiles = ensureAllFiles;
    NA.applyInsets = applyInsets;
  }

  function patchExportBackup() {
    if (typeof window.exportBackup !== 'function' || window.exportBackup.__gk17) return;
    var fn = async function () {
      var name = (S.meta.appName || '学习工作台') + '-备份-' + TODAY() + '.json';
      var data = JSON.stringify({ app: '学习工作台', v: 4, exportedAt: new Date().toISOString(), state: S }, null, 1);
      var resume = '<p class="xs muted" style="line-height:1.8;margin:0">换设备恢复：在「数据管理 → 导入备份」里选中这个文件。</p>';

      if (typeof NA !== 'undefined' && NA.isNative) {
        var out = await exportFile(name, data);
        if (out && out.ok) {
          var inPublic = out.dir === 'EXTERNAL_STORAGE' || out.dir === 'DOCUMENTS';
          var tip = inPublic
            ? '<p class="xs muted" style="line-height:1.8;margin:6px 0 0">这个位置用数据线连电脑、或用「文件管理」都能直接打开；分享面板同时已弹出。</p>'
            : '<p class="xs muted" style="line-height:1.8;margin:6px 0 0">App 专属目录卸载时会一起删掉。想让文件直接出现在「文件管理 → 下载」里，点下面的按钮授权一次即可。</p>';
          modal('导出完成',
            '<p style="font-size:13.5px;line-height:1.9;margin:0">文件 <b>' + esc(name) + '</b> 已保存到：' + esc(out.where || '本机') + '。</p>' + tip + resume,
            '<button class="btn" data-act="modal-close">知道了</button>' +
            (inPublic ? '' : '<button class="btn btn-p" data-act="all-files-perm">存到「下载」目录</button>'));
        } else {
          var emsg = String((out && out.err) || '写文件失败');
          var needAll = !!(out && out.needAllFiles);
          var needPerm = needAll || /permission|denied|权限|EACCES|INVALID_DIR/i.test(emsg);
          modal('导出失败',
            '<p style="font-size:13.5px;line-height:1.8;margin:0">' + esc(emsg) + '</p>' +
            '<p class="xs muted" style="line-height:1.8;margin:6px 0 0">' +
            (needAll
              ? '这台手机是 Android 11 及以上，写公共目录需要「所有文件访问权限」。点下面的按钮会直接跳到系统授权页，打开开关后返回再导出一次即可。'
              : (needPerm ? '看起来是存储权限被拒绝了：可点下面的按钮跳到系统授权页；也可以手动去 系统设置 → 应用 → 上岸通 → 权限 里允许。'
                          : '请重试一次；仍失败就先复制几条重要内容。')) + '</p>',
            '<button class="btn" data-act="modal-close">关闭</button>' +
            (needPerm ? '<button class="btn btn-p" data-act="all-files-perm">去开权限</button>' : '<button class="btn btn-p" data-act="modal-close">知道了</button>'));
        }
        return;
      }

      /* 网页端保持原行为 */
      var blob = new Blob([data], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      try { toast('已导出 ' + name); } catch (e) { }
    };
    fn.__gk17 = true;
    try { window.exportBackup = fn; } catch (e) { }
  }

  /* ===================== 5. 「所有文件访问」按钮 ===================== */
  function bindAllFilesBtn() {
    if (window.__gkAllFilesBound) return;
    window.__gkAllFilesBound = true;
    document.addEventListener('click', function (ev) {
      var t = ev.target && ev.target.closest ? ev.target.closest('[data-act="all-files-perm"]') : null;
      if (!t) return;
      ev.preventDefault();
      ev.stopPropagation();
      ensureAllFiles().then(function (r) {
        try { closeModal(); } catch (e) { }
        if (r && r.ok) {
          try { toast('已授权，正在重新导出…'); } catch (e) { }
          setTimeout(function () { try { exportBackup(); } catch (e) { } }, 400);
        } else {
          try { toast((r && r.err) || '已打开系统授权页，打开开关后返回再导出一次', true); } catch (e) { }
        }
      });
    }, true);
  }

  /* ===================== 6. 启动 ===================== */
  function boot() {
    injectCSS();
    patchNA();
    patchExportBackup();
    bindAllFilesBtn();
    applyInsets();
    setTimeout(applyInsets, 400);
    setTimeout(applyInsets, 1200);
    try {
      window.addEventListener('resize', scheduleInsets);
      window.addEventListener('orientationchange', scheduleInsets);
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) { applyInsets(); patchExportBackup(); }
      });
    } catch (e) { }
  }

  /* 页面脚本可能比注入晚执行（远程页面先 load 再跑业务 JS），多探几轮 */
  var tries = 0;
  (function wait() {
    if (window.NA && typeof window.exportBackup === 'function') return boot();
    if (++tries > 40) return boot();   /* 4 秒还没就绪也硬上，CSS 至少生效 */
    setTimeout(wait, 100);
  })();
})();
