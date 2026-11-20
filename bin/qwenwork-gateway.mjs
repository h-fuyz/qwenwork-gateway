#!/usr/bin/env node
/**
 * qwenwork-gateway CLI
 *
 * 用法：
 *   qwenwork-gateway add-user [--name <名字>]    # device-flow 登录并注册用户，打印 API key
 *   qwenwork-gateway list-users                  # 列出已注册用户
 *   qwenwork-gateway remove-user <userId>        # 删除用户及其凭据
 *   qwenwork-gateway rotate-key <userId>         # 重置用户 API key
 *   qwenwork-gateway serve                       # 启动网关
 *   qwenwork-gateway print-config                # 打印 Claude Code / Codex 客户端配置样例
 */
import { startDeviceLogin, resolveCredentialPath, DEFAULT_MACHINE_ID_PATH } from '../src/vendor/login-device-flow.js';
import { resolveMachineId } from '../src/vendor/login-device-flow.js';
import {
  registerUser,
  listUsers,
  removeUser,
  rotateApiKey,
  gatewayHome,
} from '../src/users/store.js';

const HELP = `用法: qwenwork-gateway <command> [args]

命令:
  add-user [--name <名字>] [--email <邮箱>]   device-flow 登录千问办公并注册为网关用户
  import-user --name <名字> --credential-file <路径>  导入已有凭据文件注册用户
  list-users                                 列出所有用户（不显示密钥）
  remove-user <userId>                       删除用户及其凭据文件
  rotate-key <userId>                        重置用户 API key（打印新明文 key）
  serve                                      启动团队网关（默认 127.0.0.1:8787）
  print-config <apiKey> [base-url]           打印 Claude Code / Codex 客户端配置样例

环境变量:
  QWENWORK_GATEWAY_HOME      数据目录（默认 ~/.qwenwork-gateway）
  QWENWORK_GATEWAY_BIND_HOST 监听地址（默认 127.0.0.1；对外服务请配反代/TLS）
  QWENWORK_GATEWAY_BIND_PORT 监听端口（默认 8787）
  QWENWORK_CREDENTIAL_FILE   add-user 时的落盘路径（默认数据目录外的临时路径）`;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(HELP);
    process.exit(0);
  }

  const flag = (name) => {
    const i = args.indexOf(name);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
  };

  switch (cmd) {
    case 'import-user': {
      // 方式 C：成员本机 add-user 后把凭据文件交给管理员导入
      const name = flag('--name');
      const email = flag('--email');
      const file = flag('--credential-file');
      if (!file) {
        console.error('用法: import-user --name <名字> --credential-file <路径>');
        process.exit(1);
      }
      const fs = await import('node:fs');
      const credential = JSON.parse(fs.readFileSync(file, 'utf8'));
      const { user, apiKey } = registerUser({ name, email, credential });
      console.log('✅ 用户已导入');
      console.log(`   id:    ${user.id}`);
      console.log(`   name:  ${user.name}`);
      console.log(`   email: ${user.email ?? '(none)'}`);
      console.log('');
      console.log(`   API key（仅此一次显示，请妥善保存）: ${apiKey}`);
      break;
    }
    case 'add-user': {
      const name = flag('--name');
      const email = flag('--email');
      console.log('正在发起千问办公 device-flow 登录…');
      // 临时凭据文件放数据目录 tmp/，注册完成后立即删除
      const os = await import('node:os');
      const path = await import('node:path');
      const fs = await import('node:fs');
      const tmpDir = path.join(gatewayHome(), 'tmp');
      fs.mkdirSync(tmpDir, { recursive: true });
      const credentialPath = path.join(tmpDir, 'login-' + Date.now() + '.json');
      const machineId = resolveMachineId(DEFAULT_MACHINE_ID_PATH);
      const result = await startDeviceLogin({
        credentialPath,
        machineIdPath: DEFAULT_MACHINE_ID_PATH,
        onUrl: (url) => {
          console.log('');
          console.log('请在浏览器打开以下链接，选择有企业套餐的团队并授权：');
          console.log('  ' + url);
          console.log('');
          console.log('等待授权中（最长 5 分钟）…');
        },
      });
      const credential = result.credential;
      const { user, apiKey } = registerUser({ name, email, credential });
      try {
        fs.rmSync(credentialPath);
      } catch {}
      console.log('✅ 用户已注册');
      console.log(`   id:    ${user.id}`);
      console.log(`   name:  ${user.name}`);
      console.log(`   email: ${user.email ?? '(none)'}`);
      console.log('');
      console.log(`   API key（仅此一次显示，请妥善保存）: ${apiKey}`);
      break;
    }
    case 'list-users': {
      const users = listUsers();
      if (users.length === 0) {
        console.log('（无用户，先用 add-user 注册）');
        break;
      }
      for (const u of users) {
        console.log(`${u.id}  ${u.name}${u.email ? ' <' + u.email + '>' : ''}  ${u.createdAt}`);
      }
      break;
    }
    case 'remove-user': {
      const id = args[0];
      if (!id) {
        console.error('用法: remove-user <userId>');
        process.exit(1);
      }
      console.log(removeUser(id) ? `✅ 已删除 ${id}` : `❌ 未找到 ${id}`);
      break;
    }
    case 'rotate-key': {
      const id = args[0];
      if (!id) {
        console.error('用法: rotate-key <userId>');
        process.exit(1);
      }
      const key = rotateApiKey(id);
      if (!key) {
        console.error(`❌ 未找到 ${id}`);
        process.exit(1);
      }
      console.log(`✅ 新 API key（仅此一次显示）: ${key}`);
      break;
    }
    case 'serve': {
      const { serveCommand } = await import('../src/gateway/server.js');
      const gw = await serveCommand();
      const shutdown = async () => {
        console.log('\nshutting down…');
        await gw.close();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      break;
    }
    case 'print-config': {
      const apiKey = args[0] ?? 'YOUR_API_KEY';
      const base = args[1] ?? 'http://127.0.0.1:8787';
      console.log(printClientConfig(apiKey, base));
      break;
    }
    default:
      console.error(`未知命令: ${cmd}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

function printClientConfig(apiKey, base) {
  return `
━━━ Claude Code（每台开发机）━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# ~/.claude/settings.json 或环境变量：
export ANTHROPIC_BASE_URL="${base}"
export ANTHROPIC_AUTH_TOKEN="${apiKey}"
# 模型别名（可选，把 claude-* 映射到 QwenWork 模型）：
#   claude       → qwenwork pro
#   flash 模型   → qwenwork flash（Haiku 槽位）
claude   # 直接使用

━━━ Codex（每台开发机）━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# ~/.codex/config.toml:
model = "pro"
model_provider = "qwenwork"

[model_providers.qwenwork]
name = "QwenWork Gateway"
base_url = "${base}"
env_key = "QWENWORK_GATEWAY_KEY"

# shell:
export QWENWORK_GATEWAY_KEY="${apiKey}"
codex "your task"
`;
}

main().catch((e) => {
  console.error('❌ ' + (e?.stack ?? e));
  process.exit(1);
});
