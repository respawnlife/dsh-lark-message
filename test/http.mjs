// HTTP 接口冒烟测试：用真实 node:http 包住插件注册的路由，验证鉴权与未绑定行为。
// 运行：DSH_HOME=/tmp/lark-notify-http node test/http.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { apply } from '../index.js';

const routes = [];
const listeners = {};
const fakeWebServer = {
  getOrigin: () => 'http://127.0.0.1:0',
  register: (route) => {
    routes.push(route);
    return () => {};
  },
};

const ctx = {
  on: (event, listener) => { listeners[event] = listener; return () => {}; },
  get: () => fakeWebServer,
  effect: (fn) => {
    const disposer = fn();
    return typeof disposer === 'function' ? disposer : () => {};
  },
  inject: (deps, callback) => {
    callback({
      effect: ctx.effect,
      on: (event, listener) => { listeners[event] = listener; return () => {}; },
      connection: { rpc: { handle: () => () => {} } },
      webServer: fakeWebServer,
      systemPrompt: { section: () => () => {} },
      tools: { register: () => () => {} },
    });
  },
};

apply(ctx, {});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const route = routes.find((item) => item.path === url.pathname);
  if (!route) {
    res.writeHead(404).end('not found');
    return;
  }
  await route.handler(req, res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const health = await fetch(`${base}/plugins/lark-notify/health`);
assert.equal(health.status, 200);
const healthBody = await health.json();
assert.equal(healthBody.ok, true);
assert.equal(healthBody.bound, false);

const noAuth = await fetch(`${base}/plugins/lark-notify/notify`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'hi' }),
});
assert.equal(noAuth.status, 401);

const no = await fetch(`${base}/plugins/lark-notify/notify`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-token' },
  body: JSON.stringify({ text: 'hi' }),
});
assert.equal(no.status, 401);

const token = (await import('node:fs')).readFileSync(
  `${process.env.DSH_HOME}/integrations/lark-notify/http-token`,
  'utf8',
).trim();
const auth = await fetch(`${base}/plugins/lark-notify/notify`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ text: 'hi' }),
});
assert.equal(auth.status, 200);
const authBody = await auth.json();
assert.equal(authBody.ok, false);
assert.match(authBody.error, /还没有绑定/);

const badJson = await fetch(`${base}/plugins/lark-notify/notify`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: '{oops',
});
assert.equal(badJson.status, 400);

const getNotify = await fetch(`${base}/plugins/lark-notify/notify`);
assert.equal(getNotify.status, 405);

console.log('HTTP OK');
server.close();
process.exit(0);
