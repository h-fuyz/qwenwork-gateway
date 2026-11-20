/**
 * 多用户凭据仓：团队共享服务器形态下，为每个成员保存一份 QwenWork 凭据。
 *
 * 存储布局（QWENWORK_GATEWAY_HOME，默认 ~/.qwenwork-gateway/）：
 *   users.json     —— 用户注册表 { users: [{ id, name, email, apiKeyHash,
 *                                            credentialFile, createdAt }] }
 *   creds/<id>.json —— 每用户一份 device-flow 凭据（0600，明文 JSON，
 *                       与上游插件 ~/.dsh/qwenwork-desktop.json 同构）
 *
 * API key：每用户一个 32 字节随机 key（qwg_ 前缀），只存 SHA-256 哈希。
 * 请求到达网关时按 Bearer key 反查用户，再把该用户的凭据文件路径
 * 经 QWENWORK_CREDENTIAL_FILE 环境变量交给 vendored loadCredentials。
 *
 * @module qwenwork-gateway/users
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const DEFAULT_HOME = () => path.join(os.homedir(), '.qwenwork-gateway');

export function gatewayHome(env = process.env) {
  const v = env.QWENWORK_GATEWAY_HOME;
  return v && v.trim() !== '' ? path.resolve(v) : DEFAULT_HOME();
}

export function usersFilePath(env = process.env) {
  return path.join(gatewayHome(env), 'users.json');
}

export function credsDir(env = process.env) {
  return path.join(gatewayHome(env), 'creds');
}

function ensureDirs(env = process.env) {
  fs.mkdirSync(credsDir(env), { recursive: true });
}

function hashApiKey(apiKey) {
  return crypto.createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

export function loadRegistry(env = process.env) {
  const file = usersFilePath(env);
  if (!fs.existsSync(file)) return { users: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { users: Array.isArray(raw.users) ? raw.users : [] };
  } catch {
    return { users: [] };
  }
}

function saveRegistry(reg, env = process.env) {
  ensureDirs(env);
  const file = usersFilePath(env);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** 生成新的 API key（仅此一次明文返回，只落盘哈希）。 */
export function generateApiKey() {
  return 'qwg_' + crypto.randomBytes(24).toString('base64url');
}

/** 注册用户：写入凭据对象，生成 API key。返回 { user, apiKey }。 */
export function registerUser({ name, email, credential }, env = process.env) {
  if (!credential || typeof credential !== 'object' || !credential.token) {
    throw new Error('credential 必须是含 token 的 device-flow 凭据对象');
  }
  ensureDirs(env);
  const reg = loadRegistry(env);
  const id = 'u_' + crypto.randomBytes(6).toString('hex');
  const credentialFile = path.join(credsDir(env), id + '.json');
  fs.writeFileSync(credentialFile, JSON.stringify(credential, null, 2), { mode: 0o600 });
  const apiKey = generateApiKey();
  const user = {
    id,
    name: name ?? credential.user?.name ?? '(unnamed)',
    email: email ?? credential.user?.email ?? null,
    apiKeyHash: hashApiKey(apiKey),
    credentialFile,
    createdAt: new Date().toISOString(),
  };
  reg.users.push(user);
  saveRegistry(reg, env);
  return { user, apiKey };
}

/** 按 API key 找用户（SHA-256 常量比较）。找不到返回 null。 */
export function findUserByApiKey(apiKey, env = process.env) {
  if (typeof apiKey !== 'string' || apiKey === '') return null;
  const h = hashApiKey(apiKey);
  const reg = loadRegistry(env);
  const user = reg.users.find((u) => u.apiKeyHash === h) ?? null;
  if (!user) return null;
  const expected = Buffer.from(h, 'hex');
  const actual = Buffer.from(user.apiKeyHash, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual) ? user : null;
}

export function listUsers(env = process.env) {
  return loadRegistry(env).users.map(({ apiKeyHash, ...rest }) => rest);
}

/** 移除用户并删除其凭据文件。 */
export function removeUser(userId, env = process.env) {
  const reg = loadRegistry(env);
  const idx = reg.users.findIndex((u) => u.id === userId);
  if (idx === -1) return false;
  const [user] = reg.users.splice(idx, 1);
  saveRegistry(reg, env);
  try {
    if (user.credentialFile && fs.existsSync(user.credentialFile)) {
      fs.rmSync(user.credentialFile);
    }
  } catch {
    /* 尽力删除 */
  }
  return true;
}

/** 重置用户 API key（返回新明文 key）。 */
export function rotateApiKey(userId, env = process.env) {
  const reg = loadRegistry(env);
  const user = reg.users.find((u) => u.id === userId);
  if (!user) return null;
  const apiKey = generateApiKey();
  user.apiKeyHash = hashApiKey(apiKey);
  saveRegistry(reg, env);
  return apiKey;
}
