// dsh-lark-message Host 一半：
//  - 扫码绑定飞书自建应用（registerApp，OAuth Device Grant）
//  - 发送文字 / 图片（官方 Node SDK）
//  - 设置页 RPC 频道 /lark-notify
//  - 给本地脚本用的 HTTP 推送接口 /plugins/lark-notify/notify（Bearer token）
//  - 给 Agent 用的 lark_notify 工具
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BindFlow } from './lib/registration.js';
import { FeishuInbound, FEISHU_GUIDANCE } from './lib/inbound.js';
import * as larkApi from './lib/lark.js';
import { mountRpcRoute } from './lib/rpc-route.js';
import { createOutbox } from './lib/outbox.js';
import {
  appendHistory,
  clearCredentials,
  ensureHttpToken,
  mask,
  previewText,
  outboxPath,
  readCredentials,
  approvalsPath,
  clearRuntimeState,
  dshHome,
  eventsPath,
  readHistory,
  tokenPath,
  writeCredentials,
  writeEndpoint,
} from './lib/store.js';

export const name = 'dsh-lark-message';

const CHANNEL = '/lark-notify';
const HTTP_PREFIX = '/plugins/lark-notify';
const MAX_BODY_BYTES = 64 * 1024;

const ok = (value) => ({ ok: true, value });
const fail = (message, code = 'bad-request') => ({
  ok: false,
  error: {
    code,
    message: String(message ?? '未知错误'),
    details: code === 'bad-request' ? { issues: [{ message: String(message ?? '') }] } : {},
  },
});

function nowText() {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date());
  } catch {
    return new Date().toISOString();
  }
}

function readBody(req, limit = MAX_BODY_BYTES) {
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
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * 规范化投递目标：{ type, id }。
 * 默认（不传）= 绑定者私聊 open_id；传了就必须是 chat_id(oc_...) 或 open_id(ou_...)。
 */
function normalizeTarget(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object') return null;
  const type = value.type;
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  if ((type !== 'chat_id' && type !== 'open_id') || id === '') return null;
  return { type, id };
}

function bearerMatches(req, expected) {
  const header = req.headers?.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const actual = header.slice('Bearer '.length).trim();
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function apply(ctx, config = {}) {
  const log = {
    info: (...args) => console.log('[lark-notify]', ...args),
    warn: (...args) => console.warn('[lark-notify]', ...args),
    error: (...args) => console.error('[lark-notify]', ...args),
  };

  let creds = readCredentials();
  // 通过 scoped context 取 agents（带 Cordis 调用追踪），让会话/agent 的作用域
  // 归属到本插件，审批事件才能按作用域派发到监听器。
  let agentsService = null;
  ctx.inject(['agents'], (scoped) => {
    agentsService = scoped.agents;
  });
  let lastError = null;
  const httpToken = ensureHttpToken();

  const flow = new BindFlow({
    log,
    onBound: (next) => {
      creds = next;
      lastError = null;
      inbound.restart();
    },
    onError: (message) => {
      lastError = message;
    },
  });

  const inbound = new FeishuInbound({
    ctx,
    log,
    config: {
      enabled: config.autoStart !== false,
      ...(typeof config.cwd === 'string' ? { cwd: config.cwd } : {}),
      ...(typeof config.sessionId === 'string' ? { sessionId: config.sessionId } : {}),
      ...(typeof config.groupSessionPrefix === 'string' ? { groupSessionPrefix: config.groupSessionPrefix } : {}),
      ...(typeof config.dmSessionPrefix === 'string' ? { dmSessionPrefix: config.dmSessionPrefix } : {}),
      ...(config.groupMode === 'all' ? { groupMode: 'all' } : {}),
      ...(Array.isArray(config.allowGroups) ? { allowGroups: config.allowGroups } : {}),
      ...(Number.isFinite(config.approvalTimeoutMs) ? { approvalTimeoutMs: config.approvalTimeoutMs } : {}),
    },
    getCreds: () => creds,
    getAgents: () => agentsService,
    eventsFile: eventsPath(),
    approvalsFile: approvalsPath(),
    sendTo: (target, payload) => deliver(payload, target),
    flushOutbox: () => outbox.flush(3),
    enqueue: (target, payload) => outbox.enqueue({ ...payload, target }),
  });

  // 发送失败重试队列：本地 JSONL 持久化，30 秒试一次，收到新消息时也会顺手重试。
  const outbox = createOutbox({
    file: outboxPath(),
    send: (item) => deliver(item, item.target),
    log,
  });
  ctx.effect(
    () => {
      const timer = setInterval(() => {
        void outbox.flush(3);
      }, 30_000);
      timer.unref?.();
      return () => clearInterval(timer);
    },
    'lark-notify: outbox retry timer',
  );

  function origin() {
    try {
      const webServer = ctx.get('webServer');
      if (webServer && typeof webServer.getOrigin === 'function') return webServer.getOrigin();
    } catch {
      // headless / 无 webServer
    }
    return '';
  }

  function httpEndpoint() {
    return `${origin()}${HTTP_PREFIX}/notify`;
  }

  /** 本地脚本靠这个文件找到接口，不必猜 DSH 端口。 */
  function rememberEndpoint() {
    try {
      writeEndpoint(httpEndpoint());
    } catch {
      // 端点文件只是便利信息，写失败不影响功能
    }
  }

  function statusPayload() {
    const target = creds?.target ?? null;
    rememberEndpoint();
    return {
      bound: Boolean(creds?.appId && creds?.appSecret),
      appId: creds?.appId ? mask(creds.appId) : null,
      boundAt: creds?.boundAt ?? null,
      tenantBrand: creds?.tenantBrand ?? null,
      target: target ? { type: target.type, id: mask(target.id) } : null,
      scopesRepairedAt: creds?.scopesRepairedAt ?? null,
      lastError,
      history: readHistory(20),
      httpTokenPath: tokenPath(),
      httpEndpoint: httpEndpoint(),
      inbound: inbound.status(),
      outboxPending: outbox.pendingCount(),
    };
  }

  async function deliver(payload = {}, targetOverride) {
    if (!creds) throw new Error('还没有绑定飞书机器人，请先在「设置 → 飞书通知」扫码绑定');
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    const markdown = typeof payload.markdown === 'string' ? payload.markdown.trim() : '';
    const imagePath = typeof payload.imagePath === 'string' ? payload.imagePath.trim() : '';
    const filePath = typeof payload.filePath === 'string' ? payload.filePath.trim() : '';
    if (text === '' && markdown === '' && imagePath === '' && filePath === '') {
      throw new Error('text、markdown、imagePath、filePath 至少提供一个');
    }
    let sent = 0;
    let messageId = '';
    if (markdown !== '') {
      try {
        const result = await larkApi.sendMarkdown(creds, markdown, targetOverride);
        messageId = result?.messageId ?? '';
        sent += 1;
        lastError = null;
        appendHistory({ ok: true, kind: 'markdown', preview: previewText(markdown) });
      } catch (error) {
        lastError = error?.message ?? String(error);
        appendHistory({ ok: false, kind: 'markdown', preview: previewText(markdown), error: lastError });
        throw error;
      }
    }
    if (filePath !== '') {
      try {
        const result = await larkApi.sendFile(creds, filePath, targetOverride);
        messageId = result?.messageId ?? '';
        sent += 1;
        lastError = null;
        appendHistory({ ok: true, kind: 'file', preview: previewText(`文件 ${filePath.split('/').pop() ?? filePath}`) });
      } catch (error) {
        lastError = error?.message ?? String(error);
        appendHistory({ ok: false, kind: 'file', preview: previewText(filePath), error: lastError });
        throw error;
      }
    }
    if (imagePath !== '') {
      try {
        const result = await larkApi.sendImage(creds, imagePath, targetOverride);
        messageId = result?.messageId ?? '';
        sent += 1;
        lastError = null;
        appendHistory({
          ok: true,
          kind: 'image',
          preview: previewText(`图片 ${imagePath.split('/').pop() ?? imagePath}`),
        });
      } catch (error) {
        lastError = error?.message ?? String(error);
        appendHistory({ ok: false, kind: 'image', preview: previewText(imagePath), error: lastError });
        throw error;
      }
    }
    if (text !== '') {
      try {
        const result = await larkApi.sendText(creds, text, targetOverride);
        messageId = result?.messageId ?? '';
        sent += 1;
        lastError = null;
        appendHistory({ ok: true, kind: 'text', preview: previewText(text) });
      } catch (error) {
        lastError = error?.message ?? String(error);
        appendHistory({ ok: false, kind: 'text', preview: previewText(text), error: lastError });
        throw error;
      }
    }
    return { ok: true, at: new Date().toISOString(), sent, messageId };
  }

  async function manualBind(payload) {
    const appId = String(payload?.appId ?? '').trim();
    const appSecret = String(payload?.appSecret ?? '').trim();
    const targetType = payload?.targetType === 'chat_id' ? 'chat_id' : 'open_id';
    const targetId = String(payload?.targetId ?? '').trim();
    await larkApi.verifyCredentials({ appId, appSecret, tenantBrand: 'feishu' });
    const existingTarget = creds?.target ?? null;
    let target = null;
    if (targetId !== '') target = { type: targetType, id: targetId };
    else if (existingTarget) target = existingTarget;
    const next = {
      appId,
      appSecret,
      tenantBrand: 'feishu',
      target,
      boundAt: new Date().toISOString(),
      boundVia: 'manual',
    };
    writeCredentials(next);
    creds = next;
    lastError = null;
    flow.reset();
    inbound.restart();
    return { ok: true, target: target ? { type: target.type, id: mask(target.id) } : null };
  }

  /**
   * 彻底重置本地绑定：停长连接、释放会话、删会话日志/工作区/测试数据/凭据。
   * 只保留 http-token（插件自己的鉴权文件，不含业务信息）。
   */
  async function resetAll() {
    const summary = { stopped: false, workspace: 'skipped', sessionDirs: [], projCache: false, workspaceDir: false, stateFiles: 0 };
    await inbound.dispose();
    summary.stopped = true;

    // 1) 工作区登记
    try {
      const registry = ctx.get('workspaceRegistry');
      const workspace = await registry?.resolveByPath?.(inbound.cwd);
      if (workspace?.id !== undefined && typeof registry.delete === 'function') {
        summary.workspace = (await registry.delete(workspace.id)) ? 'deleted' : 'absent';
      }
    } catch (error) {
      summary.workspaceError = error?.message ?? String(error);
    }

    // 2) 会话日志目录（私聊 + 所有群聊会话）
    const isOwnSessionName = (name) =>
      name === inbound.privateSessionId
      || name.startsWith(inbound.groupSessionPrefix)
      || name.startsWith(inbound.dmSessionPrefix);
    try {
      const root = path.join(dshHome(), 'sessions');
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const groupDir = path.join(root, entry.name);
        let children = [];
        try {
          children = fs.readdirSync(groupDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const child of children) {
          if (!child.isDirectory() || !isOwnSessionName(child.name)) continue;
          const candidate = path.join(groupDir, child.name);
          fs.rmSync(candidate, { recursive: true, force: true });
          summary.sessionDirs.push(candidate);
        }
      }
    } catch (error) {
      summary.sessionError = error?.message ?? String(error);
    }

    // 3) 会话投影缓存（私聊 + 群聊）
    try {
      const cacheDir = path.join(dshHome(), 'storages', 'session_projcache', 'sessions');
      if (fs.existsSync(cacheDir)) {
        for (const name of fs.readdirSync(cacheDir)) {
          if (!isOwnSessionName(name.replace(/\.json$/, ''))) continue;
          fs.rmSync(path.join(cacheDir, name), { force: true });
          summary.projCache = true;
        }
      }
    } catch (error) {
      summary.projCacheError = error?.message ?? String(error);
    }

    // 4) 工作区目录本身（里面只有测试产物）
    try {
      if (inbound.cwd !== '' && fs.existsSync(inbound.cwd)) {
        fs.rmSync(inbound.cwd, { recursive: true, force: true });
        summary.workspaceDir = true;
      }
    } catch (error) {
      summary.workspaceDirError = error?.message ?? String(error);
    }

    // 5) 本地状态文件 + 内存凭据
    try {
      summary.stateFiles = clearRuntimeState().length;
    } catch (error) {
      summary.stateError = error?.message ?? String(error);
    }
    creds = null;
    lastError = null;
    inbound.workspaceReady = false;
    inbound.pendingApprovals.clear();
    log.info?.('[lark-notify] 本地绑定与测试数据已重置');
    return summary;
  }

  async function rpcHandler(endpoint, payload) {
    try {
      switch (endpoint) {
        case 'status':
          return ok(statusPayload());
        case 'bindStart':
          return ok(await flow.start());
        case 'repairStart': {
          if (!creds) throw new Error('还没有绑定飞书机器人，请先扫码绑定');
          return ok(await flow.start({ mode: 'update', appId: creds.appId, previous: creds, keepTarget: creds.target }));
        }
        case 'bindStatus':
          return ok(flow.snapshot());
        case 'bindCancel':
          flow.cancel();
          return ok({ ok: true });
        case 'unbind':
          clearCredentials();
          creds = null;
          lastError = null;
          flow.reset();
          inbound.stop();
          return ok({ ok: true });
        case 'manualBind':
          return ok(await manualBind(payload ?? {}));
        case 'testSend': {
          const result = await deliver({
            text: `✅ 飞书通知通道测试\n时间 ${nowText()}\n来自 DeepSeek Harness · dsh-lark-message\n收到这条消息说明扫码绑定和推送链路都通了。`,
          });
          return ok(result);
        }
        case 'send':
          return ok(await deliver(payload ?? {}));
        case 'history':
          return ok({ items: readHistory(payload?.limit ?? 20) });
        default:
          return fail(`未知 RPC 端点：${endpoint}`);
      }
    } catch (error) {
      lastError = error?.message ?? String(error);
      log.warn?.(`RPC ${endpoint} 失败`, error?.message ?? error);
      return fail(lastError);
    }
  }

  // ---------------- 设置页 RPC ----------------
  // 当前 DSH 的 connection.rpc.handle 在插件上下文里拿不到浏览器通道（会抛错，
  // 客户端表现为 HTTP 405），因此直接在自己的 webServer 上复刻最小 RPC 传输。
  const connection = ctx.get('connection');
  ctx.inject(['webServer'], (scoped) => {
    try {
      scoped.effect(
        () =>
          mountRpcRoute({
            webServer: scoped.webServer,
            connection,
            channel: CHANNEL,
            handler: rpcHandler,
            log,
          }),
        'lark-notify: settings rpc route',
      );
    } catch (error) {
      log.warn?.('注册设置页 RPC 失败', error?.message ?? error);
      try {
        if (connection?.rpc?.handle) {
          scoped.effect(
            () => connection.rpc.handle(CHANNEL, rpcHandler),
            'lark-notify: settings rpc fallback',
          );
        }
      } catch (fallbackError) {
        log.warn?.('注册设置页 RPC 回退失败', fallbackError?.message ?? fallbackError);
      }
    }
  });

  // ---------------- 本地脚本 HTTP 接口 ----------------
  ctx.inject(['webServer'], (scoped) => {
    try {
      scoped.effect(
        () =>
          scoped.webServer.register({
            kind: 'exact',
            path: `${HTTP_PREFIX}/notify`,
            handler: async (req, res) => {
              if (req.method !== 'POST') {
                sendJson(res, 405, { ok: false, error: '只支持 POST' });
                return;
              }
              if (!bearerMatches(req, httpToken)) {
                sendJson(res, 401, { ok: false, error: 'token 无效' });
                return;
              }
              let body = {};
              try {
                const raw = await readBody(req);
                body = raw.trim() === '' ? {} : JSON.parse(raw);
              } catch (error) {
                sendJson(res, 400, { ok: false, error: `请求体不是合法 JSON：${error?.message ?? error}` });
                return;
              }
              try {
                const target = normalizeTarget(body?.target);
                if (body?.target !== undefined && target === null) {
                  sendJson(res, 400, { ok: false, error: 'target 必须是 { type: "chat_id"|"open_id", id }' });
                  return;
                }
                const result = await deliver(body, target ?? undefined);
                sendJson(res, 200, { ok: true, sent: result.sent, at: result.at, messageId: result.messageId, target: target ?? 'owner-dm' });
              } catch (error) {
                sendJson(res, 200, { ok: false, error: error?.message ?? String(error) });
              }
            },
          }),
        'lark-notify: notify http route',
      );

      scoped.effect(
        () =>
          scoped.webServer.register({
            kind: 'exact',
            path: `${HTTP_PREFIX}/inbound`,
            handler: async (req, res) => {
              if (req.method !== 'GET' && req.method !== 'HEAD') {
                sendJson(res, 405, { ok: false, error: '只支持 GET' });
                return;
              }
              let approvals = [];
              try {
                approvals = fs.readFileSync(approvalsPath(), 'utf8').trim().split('\n').filter(Boolean).slice(-20);
              } catch {
                approvals = [];
              }
              let liveSessions = [];
              let liveAgents = [];
              try {
                const sessions = ctx.get('sessions');
                liveSessions = (sessions?.list?.() ?? []).map((session) => ({
                  id: String(session.id),
                  cwd: session.header?.cwd ?? null,
                }));
              } catch {
                liveSessions = [];
              }
              try {
                const agents = ctx.get('agents');
                liveAgents = (agents?.list?.() ?? []).map((agent) => ({ id: String(agent.id), status: agent.status }));
              } catch {
                liveAgents = [];
              }
              sendJson(res, 200, { ok: true, inbound: inbound.status(), approvals, liveSessions, liveAgents });
            },
          }),
        'lark-notify: inbound diagnostics route',
      );

      scoped.effect(
        () =>
          scoped.webServer.register({
            kind: 'exact',
            path: `${HTTP_PREFIX}/dsh-send`,
            handler: async (req, res) => {
              if (req.method !== 'POST') {
                sendJson(res, 405, { ok: false, error: '只支持 POST' });
                return;
              }
              if (!bearerMatches(req, httpToken)) {
                sendJson(res, 401, { ok: false, error: 'token 无效' });
                return;
              }
              let body = {};
              try {
                body = JSON.parse(await readBody(req));
              } catch (error) {
                sendJson(res, 400, { ok: false, error: `请求体不是合法 JSON：${error?.message ?? error}` });
                return;
              }
              const sessionId = typeof body?.session_id === 'string' ? body.session_id.trim() : '';
              const text = typeof body?.text === 'string' ? body.text.trim() : '';
              if (sessionId === '' || text === '') {
                sendJson(res, 400, { ok: false, error: '需要 session_id 和 text' });
                return;
              }
              try {
                let agent = ctx.get('agents')?.get(sessionId);
                if (agent === undefined) {
                  const controller = ctx.get('sessionController');
                  const resolved = await controller?.resolveAgent?.(sessionId);
                  if (resolved && 'agent' in resolved) agent = resolved.agent;
                }
                if (agent === undefined) {
                  sendJson(res, 200, { ok: false, error: `session ${sessionId} 不可用（未打开且无法唤醒）` });
                  return;
                }
                const message = {
                  id: crypto.randomUUID(),
                  role: 'user',
                  content: [{ type: 'text', text }],
                  source: { kind: 'plugin:lark-notify' },
                };
                const mode = agent.status === 'running' ? 'steer' : 'followup';
                if (mode === 'steer') agent.steer(message);
                else agent.followup(message);
                sendJson(res, 200, { ok: true, session_id: sessionId, mode });
              } catch (error) {
                sendJson(res, 200, { ok: false, error: error?.message ?? String(error) });
              }
            },
          }),
        'lark-notify: dsh-send route',
      );

      scoped.effect(
        () =>
          scoped.webServer.register({
            kind: 'exact',
            path: `${HTTP_PREFIX}/chats`,
            handler: async (req, res) => {
              if (req.method !== 'GET' && req.method !== 'HEAD') {
                sendJson(res, 405, { ok: false, error: '只支持 GET' });
                return;
              }
              if (!bearerMatches(req, httpToken)) {
                sendJson(res, 401, { ok: false, error: 'token 无效' });
                return;
              }
              try {
                const chats = await larkApi.listChats(creds);
                sendJson(res, 200, {
                  ok: true,
                  owner: { type: 'open_id', id: creds?.target?.id ?? null },
                  chats,
                });
              } catch (error) {
                sendJson(res, 200, { ok: false, error: error?.message ?? String(error) });
              }
            },
          }),
        'lark-notify: chats route',
      );

      scoped.effect(
        () =>
          scoped.webServer.register({
            kind: 'exact',
            path: `${HTTP_PREFIX}/reset`,
            handler: async (req, res) => {
              if (req.method !== 'POST') {
                sendJson(res, 405, { ok: false, error: '只支持 POST' });
                return;
              }
              if (!bearerMatches(req, httpToken)) {
                sendJson(res, 401, { ok: false, error: 'token 无效' });
                return;
              }
              try {
                const summary = await resetAll();
                sendJson(res, 200, { ok: true, ...summary });
              } catch (error) {
                sendJson(res, 500, { ok: false, error: error?.message ?? String(error) });
              }
            },
          }),
        'lark-notify: reset route',
      );

      scoped.effect(
        () =>
          scoped.webServer.register({
            kind: 'exact',
            path: `${HTTP_PREFIX}/health`,
            handler: async (req, res) => {
              if (req.method !== 'GET' && req.method !== 'HEAD') {
                sendJson(res, 405, { ok: false, error: '只支持 GET' });
                return;
              }
              sendJson(res, 200, {
                ok: true,
                bound: Boolean(creds?.appId),
                target: creds?.target ? { type: creds.target.type } : null,
              });
            },
          }),
        'lark-notify: health http route',
      );
    } catch (error) {
      log.warn?.('注册 HTTP 接口失败', error?.message ?? error);
    }
    // 尽量在插件加载时就把脚本端点写下来（此时 webServer 可能刚 bind，失败也无妨，
    // 打开设置页调用 status 时会再写一次）。
    rememberEndpoint();
  });

  // ---------------- Agent 工具 ----------------
  ctx.inject(['tools'], (scoped) => {
    try {
      scoped.effect(
        () =>
          scoped.tools.register({
            name: 'lark_notify',
            description:
              '通过已绑定的飞书机器人给用户发送一条通知。当用户要求提醒、推送、报警，或需要把任务结果主动送到用户手机上时使用。纯文本；可以附一张本地图片。',
            parameters: {
              type: 'object',
              properties: {
                text: { type: 'string', description: '通知正文，纯文本，可以含换行' },
                image_path: {
                  type: 'string',
                  description: '可选：要一起发送的本地图片绝对路径（PNG/JPEG，10MB 以内）',
                },
                chat_id: {
                  type: 'string',
                  description: '可选：目标群/会话的 chat_id（oc_...）。不填则发到绑定者的个人私聊。',
                },
                markdown: {
                  type: 'boolean',
                  description: '是否按 Markdown 渲染（飞书纯文本不渲染 Markdown；需要标题/列表/代码块/表格时传 true）。',
                },
              },
              required: ['text'],
              additionalProperties: false,
            },
            output: {
              schema: {
                type: 'object',
                properties: {
                  ok: { type: 'boolean' },
                  error: { type: 'string' },
                },
                additionalProperties: true,
              },
              render(args, value) {
                if (value?.ok) {
                  const preview = String(args?.text ?? '').replace(/\s+/g, ' ').slice(0, 60);
                  return [{ type: 'text', text: `已发送飞书通知：${preview}` }];
                }
                return [{ type: 'text', text: `飞书通知发送失败：${value?.error ?? '未知错误'}` }];
              },
            },
            timeoutMs: 30_000,
            async execute(args) {
              const text = String(args?.text ?? '').trim();
              if (text === '') throw new Error('text 不能为空');
              try {
                const chatId = typeof args?.chat_id === 'string' ? args.chat_id.trim() : '';
                const target = chatId !== '' ? { type: 'chat_id', id: chatId } : undefined;
                const payload = args?.markdown === true
                  ? { markdown: text, imagePath: args?.image_path }
                  : { text, imagePath: args?.image_path };
                const result = await deliver(payload, target);
                return { ok: true, sent: result.sent };
              } catch (error) {
                return { ok: false, error: error?.message ?? String(error) };
              }
            },
          }),
        'lark-notify: agent tool',
      );
    } catch (error) {
      log.warn?.('注册 lark_notify 工具失败', error?.message ?? error);
    }
  });

  // ---------------- 飞书消息入站 ----------------
  // 飞书会话专用系统提示：用户不在电脑前，AI 自行判断，不弹交互问题。
  ctx.inject(['systemPrompt'], (scoped) => {
    try {
      scoped.effect(
        () =>
          scoped.systemPrompt.section({
            name: 'lark-notify-feishu-guidance',
            order: 80,
            text: (context) => {
              const agent = context?.agent;
              if (!inbound.isOwnSession(agent?.session?.id)) return '';
              return FEISHU_GUIDANCE;
            },
          }),
        'lark-notify: feishu guidance',
      );
    } catch (error) {
      log.warn?.('注册飞书会话系统提示失败', error?.message ?? error);
    }
  });

  // 审批转发：需要批准的回合把问题发到飞书，等用户回「同意/拒绝」。
  // 审批事件：agent 作用域监听器为主（inbound.installSessionRules 里注册），
  // 插件根上下文再挂一个兜底，二者谁先给出非 next 结果谁生效。
  ctx.effect(
    () => ctx.on('approval/request', (request, next) => inbound.onApprovalRequest(request, next), { prepend: true }),
    'lark-notify: approval relay',
  );

  // 监听本会话的事件流，把助手回复回发到飞书；长连接本身在绑定后启动。
  ctx.effect(
    () => ctx.on('session/event', (session, event) => inbound.onSessionEvent(session, event)),
    'lark-notify: feishu inbound session events',
  );
  if (config.autoStart !== false) {
    try {
      inbound.start();
    } catch (error) {
      log.warn?.('启动飞书入站失败', error?.message ?? error);
    }
  }

  ctx.effect(
    () => () => {
      flow.cancel();
      void inbound.dispose();
    },
    'lark-notify: dispose bind flow',
  );

  log.info?.(`飞书通知通道已加载（${creds ? '已绑定' : '未绑定'}）`);
}
