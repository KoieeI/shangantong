# 上岸通 · 三端构建仓

用 GitHub Actions 自动构建 Windows / Android / iOS 安装包，并发布到 Releases。

| 平台 | 产物文件 | 说明 |
|---|---|---|
| Windows | ShangAnTong-Setup.exe | 安装包（约 78 MB），首次运行需点「更多信息 → 仍要运行」 |
| Android | ShangAnTong-Android.apk | Debug 包，安装时需允许「未知来源」 |
| iOS | ShangAnTong-unsigned.ipa | 未签名包，需自行用爱思助手等工具签名安装 |

> 要最新的安装包，直接去 [Releases](https://github.com/KoieeI/shangantong/releases/latest) 下载。
> 想自己构建，去 [Actions](https://github.com/KoieeI/shangantong/actions) 运行 workflow。
