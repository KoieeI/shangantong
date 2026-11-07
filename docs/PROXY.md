# 云端架构与反代方案（已废弃）

> **本文档记录 2026-11-05 的历史方案，2026-11-07 起已不再适用。**
> 旧方案里的发布域名、`/sbapi` 反代、Supabase 项目与所有相关密钥**全部作废**，
> 请不要再按下面的步骤部署，也不要复用其中的任何 key。

## 一、现在是怎么跑的（V1.0.36）

```
浏览器 / Android / iOS / Windows 壳
        │  同源 https://shangantong.top/
        ▼
Cloudflare Worker（自定义域 shangantong.top）
        ├─ Workers Assets  静态站点（index / admin / download / sw / icons）
        ├─ D1  users / sessions / archives / invites / events / audit_log / media
        └─ R2  shangantong-media（私有桶，照片 / 录音 / 附件）
```

- **不再需要反代**：Worker 自带 `/api/v1/*`，前端同源调用，没有 sharecode 网关，也没有跨域。
- **不再需要 Supabase**：账号是 Worker 用 PBKDF2 校验后签发的令牌，数据库只存令牌哈希。
- **不再需要客户端密钥**：前端零密钥，所有敏感操作都要带会话令牌；R2 不开放公共访问。
- **不再需要境外 VPS / Caddy**：Cloudflare 已承担 HTTPS、证书与边缘分发。

## 二、旧方案为什么被换掉

| 旧问题 | 现状 |
|---|---|
| 发布域名要带 `?sharecode=`，无 cookie 请求 `/`、`/sbapi/*` 一律 403 | 自定义域直出，匿名可打开首页 |
| 本机直连 `*.supabase.co` 被重置，必须自建反代 | 自有 API，同源可达 |
| Supabase publishable key 写在客户端与文档里 | 前端零密钥；旧 key 已随项目删除作废 |
| 照片/附件只能留本机，换设备看不到 | R2 按账号隔离，跨设备自动同步 |
| 版本号四端各写一份 | 网页端 `version.json` 自动 +1，三端由 `sync-web-version.mjs` 对齐 |

## 三、历史方案留档（仅作故障复盘，不要执行）

<details>
<summary>展开 2026-11-05 的 Caddy 反代步骤（已废弃）</summary>

当时的思路是：买一台境外轻量服务器 + 域名，用 Caddy 只反代 `/sbapi/*` 到 Supabase，
避免把整台机器做成开放代理。配置文件形如：

```caddyfile
api.example.com {
    encode gzip
    handle_path /sbapi/* {
        reverse_proxy https://<已删除的 Supabase 项目>.supabase.co {
            header_up Host <已删除的 Supabase 项目>.supabase.co
        }
    }
    handle { respond "not found" 404 }
}
```

安全红线（当时定的，现在仍值得保留）：只反代必要路径、机器上不放长期密钥、
反代挂掉时本机仍可离线使用、恢复后再同步。

</details>

## 四、迁移时做过的事

1. 删除 Supabase 项目与所有 `/sbapi` 代理代码、旧的 wb 云文档同步代码。
2. 新开私有 R2 桶 `shangantong-media`，媒体 key 形如 `u/<uid>/<hash>.<ext>`，读写前校验归属。
3. `capacitor.config.json` 与 `desktop/main.js` 的站点地址统一改为 `https://shangantong.top/`。
4. `www/index.html` 保留为壳启动兜底页，不再承载业务。
5. 网页端与三端版本号统一由 `version.json` 驱动，自动递增。

> 提醒：旧版文档里出现过的 Supabase publishable key 属于已删除项目，
> 即使如此，任何真实密钥都不应写进公开仓库；本仓库现有文件已扫描，无残留密钥。
