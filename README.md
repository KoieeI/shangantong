# 上岸通 · 三端构建仓

用 GitHub Actions 自动构建 Windows / Android / iOS 安装包，并发布到 Releases。

**当前与网页端对齐版本：V1.0.36**（网页端 `version.json` 是版本号的源头，本仓 `version.json` 与其一致）。

| 平台 | 产物文件 | 说明 |
|---|---|---|
| Windows | ShangAnTong-Setup.exe | NSIS 安装包，首次运行需点「更多信息 → 仍要运行」；装过一次后静默差分更新 |
| Android | shangantong-android-v1.0.36.apk | Debug 包，安装时需允许「未知来源」 |
| iOS | shangantong-ios-v1.0.36.ipa | 未签名包，需自行用爱思助手等工具签名安装 |

> 最新安装包：[Releases](https://github.com/KoieeI/shangantong/releases/latest)
> 自行构建：[Actions](https://github.com/KoieeI/shangantong/actions) 运行 `build-all`

## 线上架构（V1.0.36 起）

三端都是「壳 + 远程加载」，统一指向 **`https://shangantong.top/`**：

- 网页端由 Cloudflare Worker 直出静态资源并提供 `/api/v1/*`；
- **文字档案**（待办、速记、错题、打卡、专注）存 Cloudflare **D1**；
- **照片 / 录音 / 附件**存私有 **R2** 桶 `shangantong-media`，经会话校验后才可读写；
- 账号体系是后端自建的邮箱+密码 + 邀请码注册，**已彻底移除 Supabase**。

因为登录态按账号走云端，四端登录同一邮箱即可看到同一份数据；不再依赖任何反代或第三方网关。

| 端 | 入口配置 | 位置 |
|---|---|---|
| Android / iOS | `server.url` / `allowNavigation` | `capacitor.config.json` |
| Windows | `APP_URL` / `ALLOW_HOST` | `desktop/main.js` |
| 壳内兜底页 | 启动瞬间占位页 | `www/index.html` |

## 版本号怎么走

- 网页端：`python build_cf.py` 每次构建自动把 `version.json` 的 PATCH +1，并同步 SW 缓存名、manifest、后台页脚。
- 三端：本仓 `version.json` 是唯一版本源，CI 构建成功后自动 +1（`[skip ci]`，不会循环触发）。
- 两边对齐：`node native/sync-web-version.mjs <网页端版本号>`，一次改好 `version.json`、根 `package.json`、`desktop/package.json`。
- 本仓若与网页端源码放在同级目录，网页端的 `build_cf.py` 也会在构建时自动尝试同步这三处。

## 网页端源码包

网页端完整源码（含 `app/` 构建产物、`src-web/` 可编辑源、Worker 后端、测试与文档）以
`shangantong-web-v1.0.36-src.zip` 形式放在项目云盘，供三端离线内置或二次开发使用。
本仓只保留壳工程，不重复存放前端资源，避免两份不同步。

详细对照表见 [`docs/WEB-SYNC.md`](docs/WEB-SYNC.md)，架构变迁见 [`docs/PROXY.md`](docs/PROXY.md)。
