# 反代服务器（阶段 B 的前置条件）

移动端要「本地打包 + 离线可用」，就必须有一个**不带 sharecode 网关**的接口地址。
原因（2026-11-05 实测）：

| 探测 | 结果 |
|---|---|
| 无 cookie 请求发布域名的 `/`、`/probe`、`/sbapi/*` | 全部 **403** |
| 从本机直连 `*.supabase.co` | **000**（连接被重置，0.47s） |

所以 App 既不能走发布域名，也不能直连 Supabase，只能自己架一个反代。

## 一、买什么

| 项目 | 建议 | 费用 |
|---|---|---|
| 服务器 | 腾讯云/阿里云**香港或境外**轻量，1 核 1G、1Mbps 足够（只有 JSON 同步流量） | 约 ¥24/月起 |
| 域名 | 任意 `.com` / `.dev`，A 记录指向服务器 IP | ¥30–60/年 |

放境外是因为**不需要备案**；放香港是因为大陆访问延迟低（30–60ms）。
不要买国内节点——域名备案没下来之前，80/443 会被拦。

## 二、装 Caddy（比 Nginx 少一半配置，自动 HTTPS）

```bash
sudo apt update && sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

## 三、Caddyfile

把 `api.example.com` 换成你自己的域名：

```caddyfile
api.example.com {
    encode gzip

    # 只反代 Supabase 的 auth 与 rest，其余一律 404
    handle_path /sbapi/* {
        reverse_proxy https://ntzszgyeamygquxyqnve.supabase.co {
            header_up Host ntzszgyeamygquxyqnve.supabase.co
        }
    }

    handle {
        respond "not found" 404
    }
}
```

```bash
sudo systemctl reload caddy
```

Caddy 会自动申请并续期 Let's Encrypt 证书，无需额外操作。
DNS 解析生效后再 reload，否则证书申请会失败（日志：`journalctl -u caddy -n 50`）。

## 四、验证（三条都要过）

```bash
# 1. 匿名可读：应该返回 JSON（不是 403 网关页）
curl -s https://api.example.com/sbapi/auth/v1/settings \
  -H "apikey: sb_publishable_5nmbB_LXp-GJDisBgt1UkA_-mTleMa0" | head -c 120

# 2. 不要变成开放代理：随便一个路径应该 404
curl -s -o /dev/null -w "%{http_code}\n" https://api.example.com/anything

# 3. 错密码应该 400 invalid_credentials（证明 auth 通了）
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  -H "apikey: sb_publishable_5nmbB_LXp-GJDisBgt1UkA_-mTleMa0" \
  -H "Content-Type: application/json" \
  -d '{"email":"nobody@example.com","password":"wrongpass123"}' \
  "https://api.example.com/sbapi/auth/v1/token?grant_type=password"
```

## 五、安全红线

1. **只反代 `/sbapi/*`**，绝不 `reverse_proxy *`——开放代理会被人白嫖流量甚至滥用到封号。
2. **这台机器上不放任何密钥**。Supabase 的 `service_role` 永远只在网页端 `server.js` 里，客户端只用 publishable key + RLS。
3. 建议在 Caddy 里加个简单限流（`rate_limit` 插件）或防火墙只放行 443。
4. 反代挂了不影响本地使用：App 会把改动存在本机，恢复后再同步——这正是阶段 B 要做的容错。

## 六、免费替代（不推荐做主力）

Cloudflare Worker 也能反代（10 万请求/天免费），但 `*.workers.dev` 域名在大陆经常被污染，
自定义域名走 Cloudflare 代理也不稳定。可以作为**备用地址**写在 App 里，主力还是自建 VPS。

## 七、有了域名之后我这边要改的

1. `acct.js`：`SB_DEFAULTS.url` → `window.__API_BASE__ || '/sbapi'`（网页端行为不变）
2. 打包脚本注入 `window.__API_BASE__ = 'https://api.example.com/sbapi'`
3. 删掉 `capacitor.config.json` 的 `server.url`，`www/` 换成真正的构建产物
4. `Preferences` 镜像 localStorage + 恢复联网自动同步
