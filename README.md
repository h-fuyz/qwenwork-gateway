# qwenwork-gateway

把企业版**千问办公（QwenWork）**的团队模型接入 **Claude Code** 和 **Codex** 的共享网关。

```
Claude Code ──Anthropic /v1/messages──┐
                                      ├──▶ qwenwork-gateway ──per-user shim──▶ gateway.qwenwork.cn
Codex ──OpenAI /v1/responses──────────┘        (API key 鉴权)   (COSY 签名)
```

## 它是怎么来的

基于社区项目 [`AlaIchhe/dsh-qwenwork-connect`](https://github.com/AlaIchhe/dsh-qwenwork-connect)（MIT）二次开发：

- **复用**其全部上游协议核心（COSY 信封签名、device-flow 登录、token 刷新、双层 SSE 解析、四层超时看门狗）——这些是经过实测打磨的部分，未做改动；
- **新增**团队网关层：多用户凭据隔离、API key 鉴权、Anthropic Messages 适配（Claude Code）、OpenAI Responses 适配（Codex）；
- **修复**了上游审计发现的三个 bug：
  1. `Cosy-Organization-Id` 头因 snake_case/camelCase 字段漂移永不发出（**企业 VPC 租户直接受影响**）→ 同时接受两种命名；
  2. token 刷新无并发保护，并发请求可把登录态刷死 → 增加 single-flight；
  3. 动态模型目录的能力位（is_vl）只查静态兜底目录 → 接入动态查询；
  4. 请求的 `max_tokens` 被忽略恒发 32000 → 透传并夹取到安全区间。

⚠️ **合规提示**：本项目通过逆向的私有协议访问千问办公网关，非官方产品，可能违反其服务条款；协议变更即失效。请确认贵司的使用授权范围后再部署。

## 部署（团队共享服务器）

要求 Node.js ≥ 22.19。网关本身零依赖。

```bash
# 1. 在服务器上安装（本仓库）
git clone <this-repo> && cd qwenwork-gateway

# 2. 注册每个成员的千问办公账号（每人一次）
bin/qwenwork-gateway.mjs add-user --name 张三 --email zhangsan@corp.cn
# → 打开终端输出的链接，选择【有企业套餐的团队】授权
# → 输出该用户的 API key（qwg_...，仅显示一次）

# 3. 启动网关
bin/qwenwork-gateway.mjs serve
# 监听 http://127.0.0.1:8787
```

建议用 systemd + Nginx（TLS）托管：

```ini
# /etc/systemd/system/qwenwork-gateway.service
[Service]
ExecStart=/usr/bin/node /opt/qwenwork-gateway/bin/qwenwork-gateway.mjs serve
Environment=QWENWORK_GATEWAY_BIND_PORT=8787
# 绑定 127.0.0.1，由 Nginx 反代对外；或绑定内网网卡直连
Restart=always
```

管理命令：`list-users` / `remove-user <id>` / `rotate-key <id>`（key 泄露时重置）/ `print-config <key> <base-url>`（打印客户端配置样例）。

## 客户端配置

### Claude Code（每台开发机）

```bash
export ANTHROPIC_BASE_URL="https://gw.your-corp.cn"
export ANTHROPIC_AUTH_TOKEN="qwg_xxxxxxxx"
claude
```

模型名映射：`claude-opus/sonnet*` → `pro`，`claude-haiku*` → `flash`（积分 1/10）；也可直接在 Claude Code 里选 `qwen3.8-flash` 等 QwenWork 模型 ID。

### Codex（每台开发机）

```toml
# ~/.codex/config.toml
model = "pro"
model_provider = "qwenwork"

[model_providers.qwenwork]
name = "QwenWork Gateway"
base_url = "https://gw.your-corp.cn"
env_key = "QWENWORK_GATEWAY_KEY"
```

```bash
export QWENWORK_GATEWAY_KEY="qwg_xxxxxxxx"
codex "your task"
```

模型可用值：`pro`（x1.00）、`qwen3.8-flash`（x0.10，日常推荐）、`frontier-1`、`qwen3.8-max-preview`，以及企业账号目录里的其他模型（每 5 分钟自动同步）。

## 架构说明

```
src/
  vendor/            ← 上游插件的协议核心（改动处均有「gateway 修复」注释标记）
    cosy.js            COSY 信封签名（AES-128-CBC + RSA 包裹 + MD5）
    chat-shim.js       OpenAI↔QwenWork 翻译 + 四层看门狗（每用户一个实例）
    auth.js            token 刷新（已加 single-flight）
    ...
  gateway/server.js  ← 对外 HTTP 服务：鉴权 + 路由 + per-user shim 生命周期
  protocol/
    anthropic.js       Anthropic Messages ↔ OpenAI（含流式事件序 + ping 保活）
    openai-responses.js OpenAI Responses ↔ OpenAI（Codex 专用）
  users/
    store.js           用户注册表（API key 只存 SHA-256 哈希，凭据 0600）
    session.js         每用户凭据 → shim 装配
test/smoke.mjs       ← 协议翻译/鉴权/用户管理的冒烟测试（node test/smoke.mjs）
```

安全边界：对外端口只收 API key（不碰千问凭据）；千问凭据只存在于服务器本地文件（0600）与进程内存；per-user shim 只绑 127.0.0.1 随机端口且带共享密钥鉴权。

## 运行测试

```bash
node test/smoke.mjs
```

## License

MIT。上游致谢与第三方声明见 `THIRD-PARTY-NOTICES.md` 与 `LICENSE`。
