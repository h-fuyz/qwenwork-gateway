# 云服务器部署手册（团队共享网关）

目标拓扑：

```
开发机 Claude Code ─┐
开发机 Codex ───────┼─ HTTPS ─▶ Nginx(TLS) ─▶ qwenwork-gateway :8787 ─▶ gateway.qwenwork.cn
开发机 Claude Code ─┘            (云服务器)      (systemd, qwg 用户)      (COSY 签名)
```

- **一台云服务器**（2C4G 起步即可，网关本身是 IO 转发，几乎不耗 CPU；带宽按团队并发 * 模型输出速度估算，10 人团队 10Mbps 够用）
- 系统：Ubuntu 22.04/24.04 或 Debian 12；Node ≥ 22.19
- 一个域名（如 `qwg.your-corp.com`）解析到服务器，用于 TLS 证书

## 一、部署（10 分钟）

```bash
# 1. 代码上传到服务器（任选其一）
git clone <your-repo> /root/qwenwork-gateway        # git
# 或 rsync -a --exclude .git qwenwork-gateway/ root@server:/root/qwenwork-gateway

# 2. 一键部署（创建专用用户/目录、安装 systemd 服务）
ssh root@server
cd /root/qwenwork-gateway && bash deploy/deploy.sh

# 3. Nginx TLS
apt install certbot python3-certbot-nginx
cp deploy/nginx-qwg.conf /etc/nginx/sites-available/qwg.conf
vim /etc/nginx/sites-available/qwg.conf   # 改 server_name 和证书路径
ln -sf /etc/nginx/sites-available/qwg.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d qwg.your-corp.com       # 自动申请/续期 Let's Encrypt
```

验证：

```bash
curl -s https://qwg.your-corp.com/healthz   # → {"ok":true,...}
```

**安全设计**（deploy.sh 已内置）：
- 网关以无登录 shell 的系统用户 `qwg` 运行，`ProtectSystem=strict` + `PrivateTmp` 沙箱
- 千问凭据（`/var/lib/qwenwork-gateway/creds/`，0700）只有 `qwg` 用户可读；**成员的 API key 只存 SHA-256 哈希**
- 网关只监听 `127.0.0.1`，对外唯一入口是 Nginx TLS；限流 30 req/s/IP
- 防火墙只开 80/443/SSH（`ufw allow 443 && ufw enable`）

## 二、成员注册（三种方式）

每位成员需要把自己的千问办公账号授权一次。**推荐方式 A（管理员代办，最简单）**；成员分散授权用方式 B；无浏览器环境用方式 C。

### 方式 A：管理员在服务器上集中注册（推荐，≤5 人团队）

管理员让每位成员在自己**日常用的浏览器**（已登录千问办公）里打开授权链接即可——device flow 的授权动作发生在成员浏览器里，与链接在哪台机器上生成无关。

```bash
ssh root@server
# 以服务用户身份执行（读写 /var/lib/qwenwork-gateway）
sudo -u qwg QWENWORK_GATEWAY_HOME=/var/lib/qwenwork-gateway \
  node /opt/qwenwork-gateway/bin/qwenwork-gateway.mjs add-user --name 张三 --email zhangsan@corp.cn
```

把终端里打印的授权链接发给张三（微信/钉钉都行）：

```
张三在【自己已登录千问办公的浏览器】打开链接 → 选账号 → 选【有企业套餐的团队】→ 确认
```

授权完成后服务器终端会打印该成员的 API key（`qwg_...`），管理员通过**安全渠道**（密码管理器/密管系统，别用群聊明文）发给成员。重复以上步骤注册其他成员。

> ⚠️ 一次性授权链接 5 分钟过期；进程被杀链接即作废（会报 `DEVICE_FLOW_REPLAYED`），重新 add-user 生成新链接即可。

### 方式 B：服务器上开一个 Web 登录路由（团队较大时，可选扩展）

给每位成员发一条命令，他们在自己机器上执行、浏览器自动弹授权页：

```bash
# 成员本机执行（curl 或浏览器打开）
ssh member@server "sudo -u qwg QWENWORK_GATEWAY_HOME=... node .../add-user --name 李四"
```

即方式 A 的 SSH 包装——可以封一个内部脚本 `qwg-register` 给成员自助执行（需要给成员开受限 SSH 账号，只允许跑这一条命令，用 `command=` 限定）。

### 方式 C：成员本机登录后导入凭据文件（无 SSH 权限时）

成员在本机（任何装了 Node 的机器）：

```bash
git clone <your-repo> && cd qwenwork-gateway
node bin/qwenwork-gateway.mjs add-user --name 王五   # 浏览器授权
# 凭据会写到本机 ~/.qwenwork-gateway/creds/<uid>.json
```

把生成的凭据文件（`creds/*.json`，内含 token，**走加密渠道**）发给管理员；管理员放到服务器：

```bash
# 管理员在服务器上：手工把凭据文件收进数据目录并登记
sudo -u qwg cp 王五的凭据.json /var/lib/qwenwork-gateway/creds/u_wangwu.json
sudo -u qwg QWENWORK_GATEWAY_HOME=/var/lib/qwenwork-gateway \
  node /opt/qwenwork-gateway/bin/qwenwork-gateway.mjs import-user \
  --name 王五 --email wangwu@corp.cn --credential-file /var/lib/qwenwork-gateway/creds/u_wangwu.json
# （import-user 命令见下文「补充工具」）
```

## 三、成员客户端配置

管理员发这个命令的输出即可（成员照抄）：

```bash
sudo -u qwg QWENWORK_GATEWAY_HOME=/var/lib/qwenwork-gateway \
  node /opt/qwenwork-gateway/bin/qwenwork-gateway.mjs print-config <成员的key> https://qwg.your-corp.com
```

输出即成员各自机器上的配置样例：

**Claude Code**：
```bash
export ANTHROPIC_BASE_URL="https://qwg.your-corp.com"
export ANTHROPIC_AUTH_TOKEN="qwg_xxxxxxxx"   # 自己的 key
claude
```

**Codex**（`~/.codex/config.toml`）：
```toml
model = "pro"
model_provider = "qwenwork"

[model_providers.qwenwork]
name = "QwenWork Gateway"
base_url = "https://qwg.your-corp.com"
env_key = "QWENWORK_GATEWAY_KEY"
```
```bash
export QWENWORK_GATEWAY_KEY="qwg_xxxxxxxx"
codex "your task"
```

模型映射：`claude-opus/sonnet*` → `pro`（x1.0），`claude-haiku*` → `flash`（x0.1）；Codex 直接用 `pro` / `qwen3.8-flash` / `qwen4-max` / `glm-5.3` 等模型 ID。

## 四、日常运维

```bash
# 服务管理
systemctl status|restart|stop qwenwork-gateway
journalctl -u qwenwork-gateway -f              # 实时日志

# 成员管理
sudo -u qwg QWENWORK_GATEWAY_HOME=/var/lib/qwenwork-gateway node /opt/qwenwork-gateway/bin/qwenwork-gateway.mjs list-users
sudo -u qwg ... remove-user u_xxxxx            # 离职移除（同时删凭据）
sudo -u qwg ... rotate-key u_xxxxx             # key 疑似泄露时重置

# 升级
cd /opt/qwenwork-gateway && git pull && systemctl restart qwenwork-gateway
```

**Token 自动续期**：凭据里的 token 过期前会自动刷新（服务端轮换 refresh_token 并回写凭据文件），无需人工干预。若某成员账号长期未用导致 refresh token 失效（表现为该成员请求 401），让他重新走一次 add-user 即可（先 remove-user 旧的）。

## 五、故障排查

| 症状 | 排查 |
|---|---|
| 成员 401 | key 错误/被 rotate；`list-users` 核对，必要时 `rotate-key` 重发 |
| 单个成员 401（网关日志 401）| 该成员 refresh token 失效 → remove-user + 重新 add-user |
| 全员 502/超时 | 上游网关协议变更或网关挂了：`journalctl -u qwenwork-gateway`，看 `/tmp/dsh-qwenwork-connect-trace.log`（shim 级时序） |
| Claude Code 卡死无输出 | 检查 Nginx 是否 `proxy_buffering off`（SSE 被缓冲的典型症状） |
| 流式中断（长思考）| 确认 Nginx `proxy_read_timeout 300s`；上游看门狗上限也是 300s |
| 目录缺新模型 | 目录 5 分钟自动刷新；`curl -H "Authorization: Bearer <key>" https://.../v1/models` 触发 |

## 六、合规与风险须知（务必内部确认）

- 本网关通过**逆向的私有协议**访问千问办公网关（`gateway.qwenwork.cn`），非官方产品；协议变更即失效，且需确认贵司企业协议是否允许账号的自动化/共享代理使用
- 所有成员的对话内容都经由此网关与服务器（明文进程内存中转），敏感代码场景建议网关部署在贵司自有内网/合规云区域
- 成员 API key 等同于其千问账号的使用权，务必走安全渠道分发，离职及时 `remove-user`
