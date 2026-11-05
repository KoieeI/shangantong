# 上岸通 · 三端构建仓

这个仓库只做一件事：用 GitHub Actions 把 **Windows 安装包 / Android APK / iOS 未签名 IPA** 打出来，产物自动挂到 Releases。

## 一、怎么用（3 步）

1. 在 GitHub 新建一个仓库（Public 即可，Actions 对公开仓库免费，包含 macOS 机时）
2. 把本目录下的所有文件推到仓库根目录（`main` 分支）
3. 打开仓库的 **Actions → build-all → Run workflow**

约 8–15 分钟后，**Releases** 里会出现 `v1.0.x`，三个文件：

| 文件 | 说明 |
|---|---|
| `ShangAnTong-Setup.exe` | Windows 安装包（约 78 MB），未签名，首次运行点「更多信息 → 仍要运行」 |
| `ShangAnTong-Android.apk` | Android debug 包，安装时允许「未知来源」 |
| `ShangAnTong-unsigned.ipa` | iOS 未签名包，用爱思助手以你的 Apple ID 自签（免费证书 7 天，到期重签） |

## 二、为什么安装包是「壳」

`capacitor.config.json` 里 `server.url` 指向线上站点，桌面版同理（`desktop/main.js` 里的 `APP_URL`）。这样：

- 三端加载的是**同一份代码**，站点更新后不用重新发安装包；
- 登录走的是站点同源的 `/sbapi` 反向代理，**同步功能与网页版完全一致**（服务端密钥不进客户端）；
- 代价：首次打开需要联网；断网时只显示浏览器级缓存。

如果以后要做「完全离线版」，得把前端打进安装包并自建 Supabase 直连（需要处理跨域与密钥），是另一套方案。

## 三、目录说明

```
package.json              Capacitor 依赖与脚本
capacitor.config.json     AppID / 应用名 / 指向的线上地址
www/                      壳加载期间的兜底页
desktop/main.js           Electron 主进程（窗口、外链、单实例、状态记忆）
desktop/package.json      electron-builder 配置
desktop/icon.b64          应用图标（base64，构建时还原成 app.ico）
.github/workflows/build.yml  三条流水线 + Release 汇总
```

## 四、注意

- **不要**把任何密钥（Supabase service_role、sessionSecret）提交进这个仓库。客户端只需要公开的 publishable key。
- iOS 未签名 IPA 只能在**越狱设备**或**自签后**安装；自签需要一台 Windows + 爱思助手 + 你自己的 Apple ID。
- Android debug 包用的是公共 debug 签名，能安装但不能上架应用商店。
- 想换应用名/图标：改 `capacitor.config.json` 的 `appName`、替换 `desktop/icon.b64`（以及后续接入 `@capacitor/assets` 生成移动端图标）。
