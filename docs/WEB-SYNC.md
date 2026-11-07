# 网页端 → 三端 更新对照表（V1.0.36）

网页端源码包：`shangantong-web-v1.0.36-src.zip`（项目云盘）。
本仓只放壳工程；两边通过下面这张表对齐，避免「网页改了、App 还指向旧站」。

## 一、每次网页端发版，三端要检查什么

| 网页端变化 | 三端要改的文件 | 本次（V1.0.36）是否已改 |
|---|---|---|
| 域名 / 部署地址 | `capacitor.config.json` 的 `server.url`、`allowNavigation`；`desktop/main.js` 的 `APP_URL`、`ALLOW_HOST` | ✅ 统一为 `https://shangantong.top/` |
| 版本号 +1 | `version.json`、根 `package.json`、`desktop/package.json` | ✅ 全部 1.0.36 / code 37 |
| 品牌名 / logo | `www/index.html` 兜底页文案、`desktop/main.js` 窗口标题、`capacitor.config.json` 的 `appName` | ✅ 均为「上岸通」 |
| 云端存储方案 | 说明文档（`README.md`、`docs/PROXY.md`）与主进程注释 | ✅ 改为 Cloudflare Worker + D1 + R2，删除 Supabase 描述 |
| Service Worker 缓存名 | 远程加载，壳不需要改；但升级后建议用户强刷一次 | ✅ 已在 `www/index.html` 注明 |
| 新接口 / 权限 | 若新增麦克风、日历、文件读写能力，检查 `native/patch-android.mjs`、`native/patch-ios.mjs` 的权限与用途说明 | ⏸ 本轮未新增权限，脚本保持原样 |

## 二、版本号怎么不靠人记

网页端：

```bash
cd <网页端源码目录>
python build_cf.py          # version.json 自动 +1，同步 SW / manifest / 后台页脚
python deploy.py
```

三端构建仓（把网页端源码放在同级目录时，网页端 `build_cf.py` 会尝试自动同步；也可手动）：

```bash
cd shangantong
node native/sync-web-version.mjs 1.0.36
git add version.json package.json desktop/package.json
git commit -m "chore: 对齐网页端 V1.0.36"
git push
```

`build-all` workflow 会用 `version.json` 给三端产物命名，构建成功后自动把版本号 +1 并
以 `[skip ci]` 推回，不需要人工提醒。

## 三、三端加载方式（重要）

- **Android / iOS（Capacitor）**：`server.url` 远程加载，`www/` 只是壳启动兜底页，不打包业务代码。
- **Windows（Electron）**：`win.loadURL(APP_URL)` 远程加载，`desktop/` 只含 `main.js` + `package.json` + 图标。
- 因此**网页端更新后，用户不需要重装 App** 就能用到新界面；只有域名、权限、图标、原生插件或版本号变化时才需要重新发版。

### 换域名的数据影响

`localStorage` 按 origin 隔离。旧域名 `civil-service-workbench.app.workbuddy.host` 上的
本机数据不会自动出现在 `shangantong.top`。但 V1.0.36 起账号档案在云端 D1/R2，
用户在新域名**登录同一账号**即可取回已上传的档案；仅存在旧设备本机、从未上传过的数据，
需要在旧设备上导出 v5 备份后在新站导入。

## 四、发版检查清单

1. `capacitor.config.json` / `desktop/main.js` 指向 `https://shangantong.top/`，无 `sharecode`。
2. `version.json`、根 `package.json`、`desktop/package.json` 三处版本号一致，且与网页端 `version.json` 相同。
3. 代码与配置里无 `supabase` / `sbapi` / 旧发布域名 / `sharecode` 残留（历史说明文档的复盘段落除外）。
4. `www/index.html` 兜底页文案与品牌一致。
5. 推到 `main` 后确认 `build-all` 三个 job 通过，Release 里三端文件名带同一版本号。
6. Windows 的 `latest.yml` 与 `.blockmap` 必须随包发布，否则应用内静默更新失效。
