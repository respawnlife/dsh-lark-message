// 设置页 RPC 通道：把 /lark-notify/<endpoint> 挂到 Host 自己的 webServer 上。
//
// 为什么不用 ctx.connection.rpc.handle：
//   当前 DSH（0.2.1-rc.2）里 connection.rpc.handle 的注册路径依赖调用方上下文
//   注入 webServer，插件里直接调用拿不到浏览器通道，注册会失败，客户端就表现为
//   “transport failure for /lark-notify/status: HTTP 405”。这里按
//   dsh-client-connection 的 /api 传输语义自己复刻最小实现：
//   1. 用 connection.requestRejection(req) 做浏览器认证 + Host/Origin 信任检查；
//   2. 只接受 POST /lark-notify/<endpoint>，请求体是
//      { rpcId: string, method: string, payload?: any }；
//   3. 响应体是 { type: "server-response", rpcId, result }，
//      其中 result 就是 RPC handler 的 { ok, value } / { ok, error } 信封。
const MAX_BODY_BYTES = 64 * 1024;
const ENDPOINT_PATTERN = /^[A-Za-z0-9_$.-]+$/;

function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function sendServerResponse(res, rpcId, result) {
  const body = JSON.stringify({ type: 'server-response', rpcId, result });
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function badRequest(message) {
  return {
    ok: false,
    error: { code: 'bad-request', message, details: { issues: [{ message }] } },
  };
}

/**
 * 挂载 RPC 通道。返回 webServer.register 的 disposer。
 * @param {{ webServer: any, connection?: any, channel: string, handler: Function, log?: any }} options
 */
export function mountRpcRoute({ webServer, connection, channel, handler, log = console }) {
  const route = {
    kind: 'prefix',
    path: channel,
    handler: async (req, res) => {
      // 浏览器认证 + Host/Origin 信任栅栏。必须持有 connection 本体以方法形式调用，
      // 抽出裸函数会丢 this，导致所有请求被误判 403。
      if (connection && typeof connection.requestRejection === 'function') {
        let rejection;
        try {
          rejection = connection.requestRejection(req);
        } catch (error) {
          log.warn?.('[lark-notify] requestRejection 异常', error?.message ?? error);
          rejection = 403;
        }
        if (rejection !== undefined) {
          sendText(res, rejection, rejection === 401 ? 'unauthorized' : 'forbidden');
          return;
        }
      }

      if (req.method !== 'POST') {
        sendText(res, 405, 'method not allowed');
        return;
      }

      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const endpoint = url.pathname.startsWith(`${channel}/`)
        ? url.pathname.slice(channel.length + 1)
        : '';
      if (endpoint === '' || !ENDPOINT_PATTERN.test(endpoint)) {
        sendText(res, 404, 'not found');
        return;
      }

      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendText(res, 400, error?.message ?? 'bad body');
        return;
      }
      const rpcId = typeof body?.rpcId === 'string' ? body.rpcId : 'invalid-request';
      const method = typeof body?.method === 'string' ? body.method : null;
      if (method === null || method !== endpoint) {
        sendServerResponse(res, rpcId, badRequest('invalid client-request message'));
        return;
      }
      try {
        const result = await handler(endpoint, body?.payload, req);
        sendServerResponse(res, rpcId, result);
      } catch (error) {
        log.warn?.(`[lark-notify] RPC ${endpoint} 异常`, error?.message ?? error);
        sendServerResponse(res, rpcId, badRequest(String(error?.message ?? error)));
      }
    },
  };
  return webServer.register(route);
}
