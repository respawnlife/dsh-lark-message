// 本地冒烟测试：用最小假 ctx 加载 Host 插件，再用真实 node:http 走一遍
// /lark-notify/<endpoint> 的 RPC 传输协议（client-request → server-response）。
// 运行：DSH_HOME=/tmp/lark-notify-smoke node test/smoke.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { apply } from '../index.js';

const routes = [];
const listeners = {};
const tools = [];

const fakeWebServer = {
  getOrigin: () => 'http://127.0.0.1:0',
  register: (route) => {
    routes.push(route);
    return () => {};
  },
};

const ctx = {
  on: (event, listener) => { listeners[event] = listener; return () => {}; },
  get(name) {
    if (name === 'webServer') return fakeWebServer;
    if (name === 'connection') {
      return {
        requestRejection: (req) => (req.headers['x-test-reject'] === '401' ? 401 : undefined),
      };
    }
    return undefined;
  },
  effect(fn) {
    const disposer = fn();
    return typeof disposer === 'function' ? disposer : () => {};
  },
  inject(deps, callback) {
    callback({
      effect: ctx.effect,
      on: (event, listener) => { listeners[event] = listener; return () => {}; },
      get: (name) => ctx.get(name),
      webServer: fakeWebServer,
      systemPrompt: { section: () => () => {} },
      tools: { register: (definition) => { tools.push(definition); return () => {}; } },
    });
  },
};

apply(ctx, {});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const route = routes.find((item) => {
    if (item.kind === 'exact') return item.path === url.pathname;
    return url.pathname === item.path || url.pathname.startsWith(`${item.path}/`);
  });
  if (!route) {
    res.writeHead(404).end('not found');
    return;
  }
  await route.handler(req, res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

let rpcSeq = 0;
async function rpc(endpoint, payload = {}, headers = {}) {
  rpcSeq += 1;
  const rpcId = `rpc-${rpcSeq}`;
  const response = await fetch(`${base}/lark-notify/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ rpcId, method: endpoint, payload }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, `${endpoint} HTTP ${response.status}: ${text}`);
  const envelope = JSON.parse(text);
  assert.equal(envelope.type, 'server-response');
  assert.equal(envelope.rpcId, rpcId);
  return envelope.result;
}

const status = await rpc('status');
assert.equal(status.ok, true);
assert.equal(status.value.bound, false);
assert.ok(Array.isArray(status.value.history));
assert.match(status.value.httpEndpoint, /\/plugins\/lark-notify\/notify$/);
assert.match(status.value.httpTokenPath, /http-token$/);

const start = await rpc('bindStart');
assert.equal(start.ok, true);
assert.equal(start.value.state, 'waiting');
assert.match(start.value.qr, /^data:image\/png;base64,/);
assert.match(start.value.url, /^https:\/\/open\.feishu\.cn\//);
console.log('bindStart 二维码 OK，链接：', start.value.url.slice(0, 80));

const waiting = await rpc('bindStatus');
assert.equal(waiting.value.state, 'waiting');
assert.equal(waiting.value.qr, start.value.qr, '重复 bindStart/bindStatus 复用同一个二维码');

await rpc('bindCancel');
const idle = await rpc('bindStatus');
assert.equal(idle.value.state, 'idle');

const history = await rpc('history', { limit: 5 });
assert.deepEqual(history.value.items, []);

const unknown = await rpc('nope');
assert.equal(unknown.ok, false);
assert.equal(unknown.error.code, 'bad-request');

// 方法不匹配 → 仍是 200 + bad-request 信封
const mismatch = await fetch(`${base}/lark-notify/status`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ rpcId: 'x', method: 'bindStatus' }),
});
assert.equal(mismatch.status, 200);
assert.equal((await mismatch.json()).result.ok, false);

// GET 方法 → 405
const get = await fetch(`${base}/lark-notify/status`);
assert.equal(get.status, 405);

// 浏览器认证拒绝 → 401
const rejected = await fetch(`${base}/lark-notify/status`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-test-reject': '401' },
  body: JSON.stringify({ rpcId: 'x', method: 'status' }),
});
assert.equal(rejected.status, 401);

assert.equal(routes.filter((route) => route.kind === 'exact').length, 6, 'notify/health/inbound/reset/chats/dsh-send 六条普通 HTTP 路由');
assert.deepEqual(
  routes.filter((route) => route.kind === 'exact').map((route) => route.path).sort(),
  ['/plugins/lark-notify/chats', '/plugins/lark-notify/dsh-send', '/plugins/lark-notify/health', '/plugins/lark-notify/inbound', '/plugins/lark-notify/notify', '/plugins/lark-notify/reset'],
);
assert.equal(routes.filter((route) => route.kind === 'prefix').length, 1);
assert.equal(routes.find((route) => route.kind === 'prefix').path, '/lark-notify');
assert.equal(tools.length, 1);
assert.equal(tools[0].name, 'lark_notify');

console.log('SMOKE OK');
server.close();
process.exit(0);
