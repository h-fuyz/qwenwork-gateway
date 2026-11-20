/**
 * 每用户一个上游会话包装：把 vendored 的 chat-shim（协议翻译 + 看门狗）
 * 与该用户的凭据文件接在一起。
 *
 * 关键点：vendored loadCredentials 支持 QWENWORK_CREDENTIAL_FILE 环境变量
 * 指定凭据路径；我们不用全局 env（多用户并发会串），而是走
 * credentials-seam 的多路径探测接缝构造一个 per-user 的凭据模块视图。
 *
 * 更直接的做法：chat-shim 的 deps.getCredential 由我们实现——
 * 直接 import vendored auth.getValidToken({ credentials: loadCredentials({...}) })，
 * 其中 loadCredentials 传 env 覆盖。credentials.js 的 loadCredentials(opts)
 * 接受 opts.env，我们用这个口子注入每用户独立的 QWENWORK_CREDENTIAL_FILE。
 *
 * @module qwenwork-gateway/users/session
 */
import { loadCredentials } from '../vendor/credentials.js';
import { getValidToken } from '../vendor/auth.js';
import { startChatShim } from '../vendor/chat-shim.js';
import { resolveGatewayEndpoint } from '../vendor/endpoint.js';

/**
 * @param {object} user store.registerUser 返回的用户记录（含 credentialFile）
 * @param {{ logger?: object, modelLookup?: Function }} [opts]
 */
export function createUserUpstream(user, opts = {}) {
  const userEnv = { ...process.env, QWENWORK_CREDENTIAL_FILE: user.credentialFile };

  async function getCredential() {
    const credentials = loadCredentials({ env: userEnv });
    const result = await getValidToken({ credentials, env: userEnv });
    return result.credentials;
  }

  /** 起一个只绑 127.0.0.1 的 per-user 翻译 shim。 */
  async function start() {
    return startChatShim({
      getCredential,
      logger: opts.logger,
      ...(opts.modelLookup ? { modelLookup: opts.modelLookup } : {}),
    });
  }

  return {
    user,
    getCredential,
    resolveEndpoint: async () => {
      const credential = await getCredential();
      return resolveGatewayEndpoint(credential);
    },
    start,
  };
}
