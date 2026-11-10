// 飞书入站：WebSocket 长连接收消息 → 注入对应的 DSH 会话 → 把回复发回飞书。
//
// 会话模型（按聊天隔离：私聊与每个群各自独立，不共用上下文）：
//   - 私聊：固定复用 config.sessionId（默认 "feishu-main"）；
//   - 群聊：每个群一个独立会话 "feishu-group-<chat_id>"，互不串上下文；
//   - 所有会话共用同一个工作区（默认 $DSH_HOME/workspaces/feishu），
//     并自动 attach 进「飞书」工作区。
//
// 常用能力：
//   - 文字、图片、文件入站（图片/文件下载到 <cwd>/inbound 后把路径交给模型）；
//   - 引用回复：读取被引用的消息并作为上下文前缀；
//   - 审批转发：需要批准的回合把「工具 + 原因」发到触发它的那个聊天，回「同意/拒绝」即可；
//   - 处理中占位消息（8 秒后出现），最终回复编辑同一条消息；
//   - 会话专属回复工具 send_lark_text / send_lark_image / send_lark_file；
//   - 发送失败进 outbox 重试队列。
//
// DSH 的包（@deepseek-ai/dsh-llm 等）不能从插件目录 import（插件是 workspace 里的
// 符号链接，按真实路径解析拿不到 profile 的依赖），所以这里手工构造等价的
// UserMessage：{ id, role: "user", content, source }。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';
import { createClient, readMessageText, updateTextMessage } from './lark.js';
import { downloadInboundMedia } from './inbound-media.js';
import { createReplyTools } from './reply-tools.js';

const SESSION_SOURCE = 'plugin:lark-notify';
const MAX_CHUNK = 2800;
const DSH_HOME = process.env.DSH_HOME ?? path.join(process.env.HOME ?? process.cwd(), '.dsh');
const DEFAULT_CWD = path.join(DSH_HOME, 'workspaces', 'feishu');
const DEFAULT_SESSION_ID = 'feishu-main';
const DEFAULT_GROUP_SESSION_PREFIX = 'feishu-group-';
const DEFAULT_DM_SESSION_PREFIX = 'feishu-dm-';
const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
const TYPING_DELAY_MS = 8000;
const MEMBER_REFRESH_MIN_MS = 60_000;

const YES_RE = /^(同意|允许|批准|确认|可以|好的?|是|yes|y|ok|allow|approve)$/i;
const NO_RE = /^(拒绝|不同意|不允许|不行|不要|否|no|n|reject|deny)$/i;

/** 飞书会话专用的系统提示：用户不在电脑前，AI 应自行判断而不是弹交互问题。 */
export const FEISHU_GUIDANCE = `你正在通过飞书和用户对话。用户多半在手机上，看不到这台电脑上的 Web 界面。

规则：
1. 你的最终回复会自动转发到飞书，写成自然、简短的中文；飞书文字消息不渲染 Markdown，少用表格、代码块和复杂排版。
2. 绝对不要使用 ask_user_question 之类的交互式提问，也不要要求用户"在界面上选择"。信息不足时按最合理的假设直接作答，并用一句话说明你的假设，让用户下一条消息纠正你。
3. 需要给用户发图片、文件或更完整的报告时，优先调用 send_lark_text / send_lark_image / send_lark_file（它们直接发到当前飞书对话）；调用后不要再重复输出同样的文字。
4. 删除、覆盖、花钱、对外发送这类不可逆操作，先用一句话说明你要做什么并等用户下一条消息确认。
5. 时间一律用用户本地时区（宿主进程所在时区），不要用 UTC。
6. 如果当前是群聊，你的回复会发到群里、所有人可见：只回答被问到的内容，不要输出与提问者无关的隐私或本机敏感信息。
7. 群聊消息开头会有「[群聊·发送者：名字（open_id）]」前缀，标明这条消息是谁发的；回答时可以按名字称呼对方，但不要把这个前缀原样复述给用户。
8. 群聊回复默认不需要 @ 任何人（不要每条都 @）。需要点名时：
   - @ 提问者：调用 send_lark_text 并传 mention_sender: true；
   - @ 其他成员：先用 list_lark_members 查到 open_id，再调用 send_lark_text 并传 mentions: ["ou_xxx"]（可多个）。
   不要自己写 at 标签语法（飞书文本消息不会渲染手写标签）。
9. 群聊里如果用户问「群里还有谁」或你需要知道其他成员是谁，调用 list_lark_members 工具获取成员名单（名字 + open_id），不要凭空猜。`;

function textOfContent(content) {
  if (typeof content !== 'string' || content === '') return '';
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed?.text === 'string') return parsed.text;
  } catch {
    // 非 JSON 内容，忽略
  }
  return '';
}

function splitText(text) {
  const chunks = [];
  let rest = String(text ?? '').trim();
  while (rest !== '') {
    if (rest.length <= MAX_CHUNK) {
      chunks.push(rest);
      break;
    }
    let cut = rest.lastIndexOf('\n', MAX_CHUNK);
    if (cut < MAX_CHUNK * 0.5) cut = MAX_CHUNK;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  return chunks;
}

function assistantText(message) {
  const blocks = message?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/**
 * 取出飞书 post（富文本）消息的行结构。两种形态都要兼容：
 *   1. 接收消息的扁平形态：{ title, content: [[{tag,...}], ...], content_v2?: ... }
 *   2. 多语言包裹形态：{ zh_cn: { title, content: [[...]] }, en_us: {...} }
 */
function postRows(content) {
  let parsed = content;
  if (typeof content === 'string') {
    try {
      parsed = JSON.parse(content);
    } catch {
      return [];
    }
  }
  if (Array.isArray(parsed?.content)) return parsed.content;
  if (Array.isArray(parsed?.content_v2)) return parsed.content_v2;
  for (const lang of Object.values(parsed ?? {})) {
    if (lang && Array.isArray(lang.content)) return lang.content;
  }
  return [];
}

function extractPostText(content) {
  const lines = [];
  for (const row of postRows(content)) {
    if (!Array.isArray(row)) continue;
    for (const node of row) {
      if ((node?.tag === 'text' || node?.tag === 'a') && typeof node.text === 'string') lines.push(node.text);
    }
  }
  return lines.join('');
}

function extractPostImageKeys(content) {
  const keys = [];
  for (const row of postRows(content)) {
    if (!Array.isArray(row)) continue;
    for (const node of row) {
      if (node?.tag === 'img' && typeof node.image_key === 'string' && node.image_key !== '') {
        keys.push(node.image_key);
      }
    }
  }
  return keys;
}

function mentionKeys(message) {
  const mentions = Array.isArray(message?.mentions) ? message.mentions : [];
  return mentions.map((mention) => mention?.key).filter((key) => typeof key === 'string' && key !== '');
}

function stripMentionKeys(text, message) {
  let out = String(text ?? '');
  for (const key of mentionKeys(message)) out = out.split(key).join('');
  return out.trim();
}

const AT_TAG_RE = /<at\b[^>]*>[\s\S]*?<\/at>/gi;
const AT_OPEN_ID_RE = /user_id\s*=\s*["“”']?(ou_[A-Za-z0-9_-]+)["“”']?/i;
const AT_INNER_RE = /<at\b[^>]*>([\s\S]*?)<\/at>/i;

/**
 * 模型自动转发的正文里如果出现手写 at 标签（包括中文引号），
 * 统一抽成 (open_id, name) 再用规范语法重拼；没有 open_id 的标签丢弃。
 */
function fixAtTags(text, turn) {
  const raw = String(text ?? '');
  if (!AT_TAG_RE.test(raw)) return raw;
  AT_TAG_RE.lastIndex = 0;
  const mentions = [];
  const cleaned = raw.replace(AT_TAG_RE, (tag) => {
    const openId = AT_OPEN_ID_RE.exec(tag)?.[1];
    const name = (AT_INNER_RE.exec(tag)?.[1] ?? '').trim();
    if (openId) mentions.push({ openId, name });
    return '';
  }).replace(/[ \t]{2,}/g, ' ').trim();
  if (mentions.length === 0) {
    const sender = turn?.sender;
    if (turn?.isGroup && sender && typeof sender.openId === 'string' && sender.openId !== '') {
      mentions.push({ openId: sender.openId, name: sender.name ?? '' });
    }
  }
  const seen = new Set();
  const unique = mentions.filter((mention) => {
    if (!mention.openId || seen.has(mention.openId)) return false;
    seen.add(mention.openId);
    return true;
  });
  if (unique.length === 0) return cleaned;
  const prefix = unique.map((mention) => `<at user_id="${mention.openId}">${mention.name}</at>`).join(' ');
  return `${prefix} ${cleaned}`;
}

function parseApprovalReply(text) {
  const trimmed = String(text ?? '').trim().replace(/[\s，。！!？?,.、；;：:]+$/g, '');
  if (YES_RE.test(trimmed)) return 'yes';
  if (NO_RE.test(trimmed)) return 'no';
  return null;
}

export class FeishuInbound {
  constructor({ ctx, log = console, config = {}, getCreds, getAgents = null, sendTo, flushOutbox, enqueue, eventsFile = null, approvalsFile = null }) {
    this.ctx = ctx;
    this.log = log;
    this.config = config;
    this.getCreds = getCreds;
    this.getAgents = typeof getAgents === 'function' ? getAgents : null;
    this.sendTo = sendTo;
    this.flushOutbox = typeof flushOutbox === 'function' ? flushOutbox : null;
    this.enqueue = typeof enqueue === 'function' ? enqueue : null;
    this.cwd = typeof config.cwd === 'string' && config.cwd.trim() !== '' ? config.cwd.trim() : DEFAULT_CWD;
    this.privateSessionId = typeof config.sessionId === 'string' && config.sessionId.trim() !== ''
      ? config.sessionId.trim()
      : DEFAULT_SESSION_ID;
    this.groupSessionPrefix = typeof config.groupSessionPrefix === 'string' && config.groupSessionPrefix.trim() !== ''
      ? config.groupSessionPrefix.trim()
      : DEFAULT_GROUP_SESSION_PREFIX;
    this.dmSessionPrefix = typeof config.dmSessionPrefix === 'string' && config.dmSessionPrefix.trim() !== ''
      ? config.dmSessionPrefix.trim()
      : DEFAULT_DM_SESSION_PREFIX;
    this.approvalTimeoutMs = Number.isFinite(config.approvalTimeoutMs) && config.approvalTimeoutMs >= 0
      ? config.approvalTimeoutMs
      : DEFAULT_APPROVAL_TIMEOUT_MS;
    // 群聊模式：mention = 只在被 @ 时回复（默认）；all = 群里每条消息都回。
    this.groupMode = config.groupMode === 'all' ? 'all' : 'mention';
    // Markdown 渲染：auto = 检测到 Markdown 语法才发卡片；always = 文字回复一律卡片；off = 纯文本。
    this.markdownMode = config.markdownMode === 'always' ? 'always' : config.markdownMode === 'off' ? 'off' : 'auto';
    // 可选白名单：只响应这些群（chat_id，oc_ 开头）；空数组 = 不限制。
    this.allowGroups = Array.isArray(config.allowGroups)
      ? config.allowGroups.filter((id) => typeof id === 'string' && id !== '')
      : [];
    this.ws = null;
    this.connected = false;
    this.lastInboundAt = null;
    this.lastEventAt = null;
    this.lastEventType = null;
    this.lastError = null;
    this.eventsFile = eventsFile;
    this.approvalsFile = approvalsFile;
    this.seen = new Set();
    /** chatId:openId -> 展示名（null 表示查过但没有） */
    this.memberNames = new Map();
    this.workspaceReady = false;
    this.ruled = new WeakSet();
    /** sessionId -> 每会话状态（chatTarget / pending / turn / handle / replyTools） */
    this.states = new Map();
    /** sessionId -> 待审批条目 */
    this.pendingApprovals = new Map();
  }

  status() {
    return {
      enabled: this.config.enabled !== false,
      connected: this.connected,
      sessionId: this.privateSessionId,
      groupSessionPrefix: this.groupSessionPrefix,
      dmSessionPrefix: this.dmSessionPrefix,
      sessions: [...this.states.keys()],
      cwd: this.cwd,
      lastInboundAt: this.lastInboundAt,
      lastEventAt: this.lastEventAt,
      lastEventType: this.lastEventType,
      lastError: this.lastError,
    };
  }

  /** 该 sessionId 是否属于本插件管理的飞书会话（含尚未建 state 的群/私聊会话）。 */
  isOwnSession(id) {
    const value = String(id ?? '');
    return value === this.privateSessionId
      || this.states.has(value)
      || value.startsWith(this.groupSessionPrefix)
      || value.startsWith(this.dmSessionPrefix);
  }

  /**
   * 每个聊天一个会话：
   *   - 群聊：feishu-group-<chat_id>（同一个群里所有人共享该群会话）；
   *   - 私聊：绑定者本人仍是 feishu-main；其他成员各自 feishu-dm-<open_id>，互不串。
   */
  sessionIdFor(message, sender) {
    if (message?.chat_type === 'group') return `${this.groupSessionPrefix}${message.chat_id}`;
    const openId = sender?.sender_id?.open_id;
    const ownerOpenId = this.getCreds()?.target?.id;
    if (typeof openId === 'string' && openId !== '' && ownerOpenId !== undefined && openId !== ownerOpenId) {
      return `${this.dmSessionPrefix}${openId}`;
    }
    return this.privateSessionId;
  }

  /** 取（或创建）一个会话的运行时状态。 */
  stateFor(sessionId) {
    let state = this.states.get(sessionId);
    if (state) return state;
    state = {
      sessionId,
      chatTarget: null,
      pending: null,
      turn: null,
      handle: null,
      workspaceAttached: false,
      titleResolved: false,
      currentSender: null,
      isGroupChat: false,
      chatId: null,
      members: [],
      membersFetchedAt: 0,
      membersRefreshedAt: 0,
    };
    state.replyTools = createReplyTools({
      log: this.log,
      getTarget: () => state.chatTarget,
      getMention: () => state.currentSender,
      resolveMentions: (tokens) => this.resolveMentionTokens(state, tokens),
      sendText: (target, text) => this.sendReplyText(target, text),
      sendImage: (target, imagePath, caption) =>
        this.sendTo(target, caption ? { imagePath, text: caption } : { imagePath }),
      sendFile: (target, filePath, caption) =>
        this.sendTo(target, caption ? { filePath, text: caption } : { filePath }),
    });
    this.states.set(sessionId, state);
    return state;
  }

  /** 记录诊断事件（入站/占位消息/引用等）。 */
  logEvent(entry) {
    if (this.eventsFile === null) return;
    try {
      fs.appendFileSync(this.eventsFile, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
    } catch {
      // 诊断失败不影响主流程
    }
  }

  /** 把收到的事件类型落到本地，方便排查「事件到底有没有到」。 */
  recordEvent(message, sessionId) {
    this.lastEventAt = new Date().toISOString();
    this.lastEventType = message?.message_type ?? 'unknown';
    if (this.eventsFile === null) return;
    try {
      const line = `${JSON.stringify({
        at: this.lastEventAt,
        type: this.lastEventType,
        chat_type: message?.chat_type ?? null,
        chat_id: message?.chat_id ?? null,
        session: sessionId ?? null,
        message_id: message?.message_id ?? null,
      })}\n`;
      fs.appendFileSync(this.eventsFile, line, { mode: 0o600 });
      const content = fs.readFileSync(this.eventsFile, 'utf8').trim().split('\n');
      if (content.length > 200) {
        fs.writeFileSync(this.eventsFile, `${content.slice(-200).join('\n')}\n`, { mode: 0o600 });
      }
    } catch {
      // 诊断日志写失败不影响主流程
    }
  }

  client() {
    const creds = this.getCreds();
    if (!creds) throw new Error('还没有绑定飞书应用');
    return createClient(creds);
  }

  start() {
    const creds = this.getCreds();
    if (!creds) {
      this.log.info?.('[lark-notify] 未绑定飞书应用，入站不启动');
      return;
    }
    this.stop();
    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': (data) => this.onMessage(data),
    });
    const ws = new lark.WSClient({
      appId: creds.appId,
      appSecret: creds.appSecret,
      loggerLevel: lark.LoggerLevel.warn,
      source: 'dsh-lark-notify',
      onReady: () => {
        this.connected = true;
        this.lastError = null;
        this.log.info?.('[lark-notify] 飞书长连接就绪，可以接收消息');
      },
      onError: (error) => {
        this.connected = false;
        this.lastError = error?.message ?? String(error);
        this.log.warn?.('[lark-notify] 飞书长连接失败', this.lastError);
      },
      onReconnecting: () => {
        this.connected = false;
        this.log.warn?.('[lark-notify] 飞书长连接断开，正在重连');
      },
      onReconnected: () => {
        this.connected = true;
        this.log.info?.('[lark-notify] 飞书长连接已恢复');
      },
    });
    this.ws = ws;
    void this.attachSessionToWorkspace(this.stateFor(this.privateSessionId));
    Promise.resolve(ws.start({ eventDispatcher: dispatcher })).catch((error) => {
      this.connected = false;
      this.lastError = error?.message ?? String(error);
      this.log.warn?.('[lark-notify] 启动飞书长连接失败', this.lastError);
    });
  }

  restart() {
    this.start();
  }

  /** 停止长连接，并释放本插件持有的全部 agent（会话日志随之关闭，便于删除）。 */
  async dispose() {
    this.stop();
    const handles = [];
    for (const state of this.states.values()) {
      if (state.handle) handles.push(state.handle);
      state.handle = null;
      state.workspaceAttached = false;
    }
    this.states.clear();
    for (const handle of handles) {
      try {
        await handle.dispose();
      } catch (error) {
        this.log.warn?.('[lark-notify] 释放飞书会话失败（继续删除）', error?.message ?? error);
      }
    }
  }

  stop() {
    if (this.ws) {
      try {
        this.ws.close({ force: true });
      } catch (error) {
        this.log.warn?.('[lark-notify] 关闭飞书长连接失败', error?.message ?? error);
      }
      this.ws = null;
    }
    this.connected = false;
    for (const state of this.states.values()) {
      state.pending = null;
      state.turn = null;
      this.clearApproval(state.sessionId);
    }
  }

  // ------------------------------------------------------------ 会话与工具

  /**
   * 飞书会话里禁用交互式提问工具（ask_user_question），这是用户明确要求的：
   * 拿不准就自己判断，不要把选择题丢回给手机上的用户。
   */
  installSessionRules(agentCtx, state) {
    if (!agentCtx || this.ruled.has(agentCtx)) return;
    this.ruled.add(agentCtx);
    try {
      const tools = agentCtx.tools;
      if (typeof tools?.restrict !== 'function') {
        this.log.warn?.('[lark-notify] tools.restrict 不可用，交互提问工具仍可能出现在飞书会话');
      } else {
        for (const name of ['ask_user_question']) {
          try {
            tools.restrict({ deny: [name] });
          } catch (error) {
            this.log.warn?.(`[lark-notify] 禁用工具 ${name} 失败（跳过）`, error?.message ?? error);
          }
        }
      }
      state.replyTools.register(agentCtx);
      this.registerMemberTool(agentCtx, state);
      this.logApproval({ phase: 'rules-installed', agentId: state.sessionId });
    } catch (error) {
      this.log.warn?.('[lark-notify] 安装飞书会话工具规则失败（非致命）', error?.message ?? error);
    }
  }

  async ensureWorkspace() {
    if (this.workspaceReady) return;
    try {
      fs.mkdirSync(this.cwd, { recursive: true });
    } catch (error) {
      this.log.warn?.('[lark-notify] 创建工作目录失败', error?.message ?? error);
    }
    try {
      const registry = this.ctx.get('workspaceRegistry');
      if (registry) {
        const existing = await registry.resolveByPath?.(this.cwd);
        if (!existing) await registry.create?.(this.cwd, '飞书');
      }
      this.workspaceReady = true;
    } catch (error) {
      this.log.warn?.('[lark-notify] 注册飞书工作区失败（不影响对话）', error?.message ?? error);
    }
  }

  /**
   * 把一个飞书会话登记进「飞书」工作区。
   *
   * DSH 只自动登记“经由工作区流程创建”的会话；bot 自己用 agents.create/resume
   * 建的会话必须显式 attachSession，否则侧边栏里会掉进「未分组」。
   * 私聊与每个群聊共用同一个工作区，各自是独立会话。
   */
  async attachSessionToWorkspace(state) {
    if (state.workspaceAttached) return;
    try {
      const registry = this.ctx.get('workspaceRegistry');
      if (!registry) return;
      try {
        fs.mkdirSync(this.cwd, { recursive: true });
      } catch {
        // 目录已存在或创建失败，交给 resolve/attach 报错
      }
      let workspace = await registry.resolveByPath?.(this.cwd);
      if (!workspace) {
        workspace = await registry.create?.(this.cwd, '飞书');
        workspace = workspace ?? (await registry.resolveByPath?.(this.cwd));
      }
      if (!workspace || typeof workspace.attachSession !== 'function') return;
      await workspace.attachSession(state.sessionId);
      state.workspaceAttached = true;
      this.logEvent({ type: 'workspace-attached', session: state.sessionId, workspaceId: String(workspace.id ?? '') });
    } catch (error) {
      this.logEvent({ type: 'workspace-attach-failed', session: state.sessionId, error: error?.message ?? String(error) });
    }
  }

  /** 群名/人名截断用的短后缀。 */
  shortId(value) {
    const text = String(value ?? '');
    return text.length <= 8 ? text : text.slice(-8);
  }

  /**
   * 取会话的展示名：群聊用群名，私聊用对方的名字；拿不到就退回 id 尾号。
   * 需要租户权限 im:chat:readonly（群名）与 contact:user.base:readonly（用户名）。
   */
  async resolveSessionTitle(message, sender) {
    const client = this.client();
    const isGroup = message?.chat_type === 'group';
    const openId = sender?.sender_id?.open_id;
    if (isGroup) {
      try {
        const res = await client.im.chat.get({ path: { chat_id: message.chat_id } });
        const name = typeof res?.data?.name === 'string' ? res.data.name.trim() : '';
        if (name !== '') return name;
      } catch (error) {
        this.logEvent({ type: 'title-chat-error', error: error?.message ?? String(error) });
      }
      return `群聊 ${this.shortId(message.chat_id)}`;
    }
    if (typeof openId === 'string' && openId !== '') {
      try {
        const res = await client.contact.v3.user.get({
          path: { user_id: openId },
          params: { user_id_type: 'open_id' },
        });
        const name = typeof res?.data?.user?.name === 'string' ? res.data.user.name.trim() : '';
        if (name !== '') return name;
      } catch (error) {
        this.logEvent({ type: 'title-user-error', error: error?.message ?? String(error) });
      }
      // 通讯录权限常常拿不到：改从群成员列表里找这个人（单聊也有一条成员记录）。
      try {
        const res = await client.im.chatMembers.get({
          path: { chat_id: message.chat_id },
          params: { member_id_type: 'open_id', page_size: 50 },
        });
        const items = Array.isArray(res?.data?.items) ? res.data.items : [];
        const self = items.find((item) => item?.member_id === openId);
        const name = typeof self?.name === 'string' ? self.name.trim() : '';
        if (name !== '') return name;
        this.logEvent({ type: 'title-members-no-name', chat_id: message.chat_id });
      } catch (error) {
        this.logEvent({ type: 'title-members-error', error: error?.message ?? String(error) });
      }
    }
    // 退一步：单聊 chat_id 的 chat.get 有时也能拿到名字
    try {
      const res = await client.im.chat.get({ path: { chat_id: message.chat_id } });
      const name = typeof res?.data?.name === 'string' ? res.data.name.trim() : '';
      if (name !== '') return name;
    } catch {
      // 忽略
    }
    return `私聊 ${this.shortId(openId ?? message.chat_id)}`;
  }

  /** 首次对话时把会话标题改成群名/人名（user 来源标题会钉住，不被自动标题覆盖）。 */
  async ensureSessionTitle(state, agent, message, sender) {
    if (state.titleResolved) return;
    state.titleResolved = true;
    try {
      const title = await this.resolveSessionTitle(message, sender);
      if (typeof title !== 'string' || title.trim() === '') return;
      const sessionTitle = this.ctx.get('sessionTitle');
      if (!sessionTitle || typeof sessionTitle.rename !== 'function') return;
      sessionTitle.rename(agent.session, title.trim());
      this.logEvent({ type: 'session-renamed', session: state.sessionId, title: title.trim() });
    } catch (error) {
      this.logEvent({ type: 'session-rename-failed', session: state.sessionId, error: error?.message ?? String(error) });
    }
  }

  async ensureAgent(sessionId) {
    const state = this.stateFor(sessionId);
    const agents = this.getAgents?.() ?? this.ctx.get('agents');
    if (!agents) {
      this.lastError = '当前 DSH 没有 agents 服务，无法建立飞书会话';
      return undefined;
    }
    const live = agents.get(sessionId);
    if (live) {
      this.installSessionRules(live.ctx, state);
      void this.attachSessionToWorkspace(state);
      return live;
    }
    if (state.handle) return state.handle.agent;

    await this.ensureWorkspace();
    try {
      await this.ctx.get('loader')?.await?.();
    } catch {
      // loader 不存在时直接继续
    }

    const setup = async (agentCtx) => {
      this.installSessionRules(agentCtx, state);
      try {
        const presets = agentCtx.get?.('agentPresets');
        if (presets) await presets.mount(agentCtx);
      } catch (error) {
        this.log.warn?.('[lark-notify] 挂载默认 Agent 预设失败（会话可能没有工具）', error?.message ?? error);
      }
    };
    const selection = this.ctx.get('agentDefaultModel')?.currentSelection?.();
    const agentOptions = selection
      ? {
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
        }
      : undefined;

    try {
      // 必须带 agentOptions：部署的 persona 提示词里引用了 {{model}}，而变量
      // provider 取的是 context.agent?.options.model；resume 不传就会得到
      // "prompt variable {{model}} has no value" 的组装错误。
      state.handle = await agents.resume({ resumeSessionId: sessionId, agentOptions, setup });
      void this.attachSessionToWorkspace(state);
      this.log.info?.('[lark-notify] 已恢复飞书会话', sessionId);
      return state.handle.agent;
    } catch (resumeError) {
      try {
        state.handle = await agents.create({
          sessionId,
          meta: { cwd: this.cwd },
          agentOptions,
          setup,
        });
        void this.attachSessionToWorkspace(state);
        this.log.info?.('[lark-notify] 已创建飞书会话', sessionId, '（cwd:', this.cwd, '）');
        return state.handle.agent;
      } catch (createError) {
        if (/already exists/i.test(String(createError)) || createError?.name === 'SessionAlreadyExistsError') {
          try {
            state.handle = await agents.resume({ resumeSessionId: sessionId, agentOptions, setup });
            return state.handle.agent;
          } catch (retryError) {
            this.lastError = retryError?.message ?? String(retryError);
            this.log.warn?.('[lark-notify] 恢复飞书会话失败', this.lastError);
            return undefined;
          }
        }
        this.lastError = createError?.message ?? String(createError);
        this.log.warn?.('[lark-notify] 创建飞书会话失败', this.lastError, '（resume 也失败：', resumeError?.message ?? resumeError, '）');
        return undefined;
      }
    }
  }

  // ------------------------------------------------------------ 入站消息

  async onMessage(data) {
    try {
      const message = data?.message;
      const sender = data?.sender;
      if (!message?.message_id || !message?.chat_id) return;
      const isGroup = message.chat_type === 'group';
      const sessionId = this.sessionIdFor(message, sender);
      this.recordEvent(message, sessionId);
      if (sender?.sender_type === 'app') return; // 机器人自己/其他应用的消息
      if (this.seen.has(message.message_id)) return;
      this.seen.add(message.message_id);
      if (this.seen.size > 300) {
        const first = this.seen.values().next().value;
        this.seen.delete(first);
      }
      if (!isGroup && message.chat_type !== 'p2p') {
        this.log.info?.('[lark-notify] 忽略非私聊/群聊消息', message.chat_type);
        return;
      }
      if (isGroup) {
        if (this.allowGroups.length > 0 && !this.allowGroups.includes(message.chat_id)) {
          this.log.info?.('[lark-notify] 群不在白名单，忽略', message.chat_id);
          return;
        }
        if (this.groupMode === 'mention' && mentionKeys(message).length === 0) {
          this.log.info?.('[lark-notify] 群里没有 @机器人，忽略', message.chat_id);
          return;
        }
      }

      // 顺手重试上次失败的发送（不阻塞本条消息处理）。
      void this.flushOutbox?.();
      const state = this.stateFor(sessionId);
      state.chatTarget = { type: 'chat_id', id: message.chat_id };
      state.isGroupChat = isGroup;
      state.chatId = message.chat_id;
      const rawText = this.extractText(message);
      const text = isGroup ? stripMentionKeys(rawText, message) : rawText;
      const mediaDir = path.join(this.cwd, 'inbound');
      const medias = [];
      if (message.message_type === 'image' || message.message_type === 'file') {
        const media = await downloadInboundMedia({
          client: this.client(),
          message,
          dir: mediaDir,
          log: this.log,
        });
        if (!media) {
          await this.replyChunks(state.chatTarget, [
            '⚠️ 收到图片/文件但下载失败了。',
            '最常见原因是飞书应用缺少「获取单聊、群组消息」权限（im:message:readonly）。',
            '请在 DSH 设置 → 飞书通知 里点「补全权限」，用飞书扫码确认后重发一次。',
          ].join('\n'));
          return;
        }
        medias.push(media);
      } else if (message.message_type === 'post') {
        // 富文本（图文混排）：文字走 extractText，里面的图片单独下载。
        const imageKeys = extractPostImageKeys(message.content);
        for (const imageKey of imageKeys) {
          const media = await downloadInboundMedia({
            client: this.client(),
            message: { ...message, message_type: 'image', content: JSON.stringify({ image_key: imageKey }) },
            dir: mediaDir,
            log: this.log,
          });
          if (media) medias.push(media);
        }
        if (imageKeys.length > 0 && medias.length === 0) {
          await this.replyChunks(state.chatTarget, '⚠️ 收到图文消息，但图片下载失败（缺少 im:message:readonly 权限或接口异常）。');
          return;
        }
      }
      const supportedTypes = new Set(['text', 'post', 'image', 'file']);
      if (!supportedTypes.has(message.message_type)) {
        await this.replyChunks(state.chatTarget, `暂时只支持文字、图片和文件消息（收到的是 ${message.message_type}）。`);
        return;
      }

      // 审批进行中且用户回复了同意/拒绝：消费这条消息，不再注入。
      if (this.pendingApprovals.has(sessionId)) {
        const decision = parseApprovalReply(text);
        if (decision !== null) {
          this.answerApproval(sessionId, decision);
          return;
        }
      }

      let body = text;
      if (medias.length > 0) {
        const hints = medias.map((media) => {
          const label = media.kind === 'image' ? '图片' : '文件';
          return `[飞书${label}] 已保存到：${media.path}`;
        });
        body = body === '' ? hints.join('\n') : `${hints.join('\n')}\n\n${body}`;
      }
      if (body.trim() === '') {
        this.log.info?.('[lark-notify] 忽略空消息', message.message_type);
        return;
      }

      const quote = await this.readQuote(message);
      if (quote !== null && quote.trim() !== '') body = `（引用：${quote.trim()}）\n\n${body}`;

      // 发送者身份：群聊里必须告诉模型「是谁在说话」，回复时也 @ 回这个人。
      const senderOpenId = sender?.sender_id?.open_id;
      const senderName = typeof senderOpenId === 'string'
        ? await this.resolveSenderName(state, message.chat_id, senderOpenId)
        : null;
      state.currentSender = senderOpenId
        ? { openId: senderOpenId, name: senderName ?? '未知成员' }
        : null;
      if (isGroup) {
        const who = senderName ?? (typeof senderOpenId === 'string' ? `未知成员(${senderOpenId.slice(-8)})` : '未知成员');
        const idHint = typeof senderOpenId === 'string' && senderOpenId !== '' ? `（${senderOpenId}）` : '';
        body = `[群聊·发送者：${who}${idHint}]\n\n${body}`;
      }

      const agent = await this.ensureAgent(sessionId);
      if (!agent) return;
      await this.ensureSessionTitle(state, agent, message, sender);
      this.lastInboundAt = new Date().toISOString();
      state.pending = { target: state.chatTarget, sender: state.currentSender, isGroup };

      const userMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: body }],
        source: { kind: SESSION_SOURCE },
      };
      if (agent.status === 'running') agent.steer(userMessage);
      else agent.followup(userMessage);
      this.log.info?.(`[lark-notify] 收到飞书消息（${message.message_type}/${sessionId}）并注入会话`);
    } catch (error) {
      this.lastError = error?.message ?? String(error);
      this.log.warn?.('[lark-notify] 处理飞书入站消息失败', this.lastError);
    }
  }

  extractText(message) {
    if (message.message_type === 'text') return textOfContent(message.content);
    if (message.message_type === 'post') return extractPostText(message.content);
    return '';
  }

  async readQuote(message) {
    const parentId = typeof message.parent_id === 'string' && message.parent_id !== '' ? message.parent_id : null;
    this.logEvent({ type: 'quote-check', parent_id: parentId, root_id: message.root_id ?? null });
    if (parentId === null) return null;
    try {
      const text = await readMessageText(this.getCreds(), parentId);
      this.logEvent({ type: 'quote-fetched', parent_id: parentId, hasText: typeof text === 'string' && text.length > 0 });
      return text;
    } catch (error) {
      this.log.warn?.('[lark-notify] 读取引用消息失败', error?.message ?? error);
      this.logEvent({ type: 'quote-error', parent_id: parentId, error: error?.message ?? String(error) });
      return null;
    }
  }

  // ------------------------------------------------------------ 成员列表

  /**
   * 成员缓存（按群/聊天独立）：
   *   - 有缓存时直接用，不刷新；
   *   - 只有「查找某人没找到」时才触发刷新；
   *   - 刷新动作本身限流：同一个聊天最多每 60 秒刷新一次。
   */
  async refreshChatMembers(state, { force = false } = {}) {
    const chatId = state.chatId;
    if (typeof chatId !== 'string' || chatId === '') throw new Error('当前没有可用的飞书聊天');
    const now = Date.now();
    const hasCache = state.membersFetchedAt > 0;
    const withinLimit = now - state.membersRefreshedAt < MEMBER_REFRESH_MIN_MS;
    if (!force && withinLimit) return state.members;
    // 先记下“刷新动作时间”，即使下面接口失败，1 分钟内也不再重试，避免刷爆接口。
    state.membersRefreshedAt = now;
    const client = this.client();
    const members = [];
    let pageToken;
    for (let page = 0; page < 5; page += 1) {
      const res = await client.im.chatMembers.get({
        path: { chat_id: chatId },
        params: {
          member_id_type: 'open_id',
          page_size: 100,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
      const items = Array.isArray(res?.data?.items) ? res.data.items : [];
      for (const item of items) {
        const openId = typeof item?.member_id === 'string' ? item.member_id : '';
        if (openId === '') continue;
        members.push({ openId, name: typeof item?.name === 'string' ? item.name : '' });
      }
      const hasMore = res?.data?.has_more === true && typeof res?.data?.page_token === 'string';
      if (!hasMore) break;
      pageToken = res.data.page_token;
    }
    state.members = members;
    state.membersFetchedAt = now;
    this.logEvent({ type: 'members-refreshed', session: state.sessionId, count: members.length });
    return members;
  }

  /** 拿成员列表：有缓存直接返回，没缓存才拉一次。 */
  async getChatMembers(state, { force = false } = {}) {
    if (!force && state.membersFetchedAt > 0) return state.members;
    return this.refreshChatMembers(state, { force });
  }

  /** 在缓存里找成员（open_id 精确 / 名字精确 / 名字包含）。 */
  findMember(state, token) {
    const value = String(token ?? '').trim();
    if (value === '') return null;
    if (value.startsWith('ou_')) return state.members.find((member) => member.openId === value) ?? null;
    return state.members.find((member) => member.name === value)
      ?? state.members.find((member) => member.name !== '' && member.name.includes(value))
      ?? null;
  }

  /** 先查缓存；没命中才刷新（刷新受 60 秒限流），再查一次。 */
  async lookupMember(state, token) {
    const hit = this.findMember(state, token);
    if (hit) return hit;
    await this.refreshChatMembers(state);
    return this.findMember(state, token);
  }

  /** 把「open_id 或名字」列表解析成 {openId, name}。 */
  async resolveMentionTokens(state, tokens) {
    const resolved = [];
    for (const token of tokens ?? []) {
      const value = String(token ?? '').trim();
      if (value === '') continue;
      const member = await this.lookupMember(state, value);
      if (member) {
        resolved.push({ openId: member.openId, name: member.name });
        continue;
      }
      // 显式给了 open_id 但缓存里没有：仍然按 open_id @，名字留空。
      if (value.startsWith('ou_')) resolved.push({ openId: value, name: '' });
    }
    return resolved;
  }

  registerMemberTool(agentCtx, state) {
    const self = this;
    try {
      const tools = agentCtx.tools;
      if (!tools || typeof tools.register !== 'function') return;
      const definition = {
        name: 'list_lark_members',
        description:
          '列出当前飞书聊天（群聊或私聊）的成员：名字 + open_id。用户问「群里还有谁」或需要点名某个成员时使用。默认读缓存，传 refresh: true 可强制刷新。',
        parameters: {
          type: 'object',
          properties: {
            refresh: { type: 'boolean', description: '是否强制刷新成员缓存（默认 false，读缓存）' },
          },
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              chat_id: { type: 'string' },
              count: { type: 'number' },
              cached: { type: 'boolean' },
              members: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { name: { type: 'string' }, open_id: { type: 'string' } },
                  additionalProperties: false,
                },
              },
              error: { type: 'string' },
            },
            additionalProperties: true,
          },
          render(args, value) {
            if (value?.ok !== true) return [{ type: 'text', text: `获取成员失败：${value?.error ?? '未知错误'}` }];
            const members = Array.isArray(value.members) ? value.members : [];
            const text = members
              .map((member) => {
                const openId = member?.open_id ?? member?.openId ?? '';
                return `${member?.name || '未命名'}（${openId || '无 open_id'}）`;
              })
              .join('、');
            const suffix = value.cached === true ? '（缓存）' : '';
            return [{ type: 'text', text: `群成员 ${value.count ?? members.length} 人${suffix}：${text}` }];
          },
        },
        timeoutMs: 30_000,
        async execute(args) {
          try {
            const hadCache = state.membersFetchedAt > 0;
            const members = await self.getChatMembers(state, { force: args?.refresh === true });
            return {
              ok: true,
              chat_id: state.chatId ?? '',
              count: members.length,
              cached: hadCache && args?.refresh !== true,
              members: members.map((member) => ({ name: member.name, open_id: member.openId })),
            };
          } catch (error) {
            return { ok: false, error: error?.message ?? String(error) };
          }
        },
      };
      if (typeof agentCtx.effect === 'function') {
        agentCtx.effect(() => tools.register(definition), 'lark-notify: list_lark_members');
      } else {
        tools.register(definition);
      }
    } catch (error) {
      this.log.warn?.('[lark-notify] 注册成员列表工具失败（非致命）', error?.message ?? error);
    }
  }

  // ------------------------------------------------------------ 发送者身份

  /**
   * 解析某条消息的发送者展示名。
   * 先查该聊天的成员缓存；没命中才刷新（60 秒限流），再退到通讯录接口。
   */
  async resolveSenderName(state, chatId, openId) {
    if (typeof openId !== 'string' || openId === '') return null;
    const key = `${chatId}:${openId}`;
    if (this.memberNames.has(key)) return this.memberNames.get(key);

    const cached = this.findMember(state, openId);
    let name = cached?.name ? cached.name : null;
    if (name === null) {
      try {
        const member = await this.lookupMember(state, openId);
        if (member?.name) name = member.name;
      } catch (error) {
        this.logEvent({ type: 'sender-members-error', error: error?.message ?? String(error) });
      }
    }
    if (name === null) {
      try {
        const res = await this.client().contact.v3.user.get({
          path: { user_id: openId },
          params: { user_id_type: 'open_id' },
        });
        const value = typeof res?.data?.user?.name === 'string' ? res.data.user.name.trim() : '';
        if (value !== '') name = value;
      } catch (error) {
        this.logEvent({ type: 'sender-user-error', error: error?.message ?? String(error) });
      }
    }
    this.memberNames.set(key, name);
    if (name === null) this.logEvent({ type: 'sender-name-missing', chat_id: chatId, open_id: openId });
    return name;
  }

  // ------------------------------------------------------------ 审批

  logApproval(entry) {
    if (this.approvalsFile === null) return;
    try {
      fs.appendFileSync(this.approvalsFile, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
    } catch {
      // 诊断日志失败不影响审批
    }
  }

  /** approval/request 瀑布处理器（插件根上下文注册，prepend 优先）。 */
  async onApprovalRequest(req, next) {
    const agentId = req?.agent?.id ? String(req.agent.id) : null;
    const state = agentId === null ? undefined : this.states.get(agentId);
    this.logApproval({
      phase: 'request',
      agentId,
      toolName: req?.toolName ?? null,
      reason: req?.reason ?? null,
      matches: state !== undefined,
      hasChatTarget: Boolean(state?.chatTarget),
    });
    const finish = (outcome) => {
      this.logApproval({ phase: 'outcome', agentId, toolName: req?.toolName ?? null, outcome });
      return outcome;
    };
    if (!state) return finish(next());
    if (!state.chatTarget) {
      this.log.warn?.('[lark-notify] 审批请求没有活跃的飞书对话，回退到 Web 界面');
      return finish('unavailable');
    }
    const target = state.chatTarget;
    const question = [
      '【DSH 权限请求】',
      `工具：${req.toolName}`,
      `原因：${req.reason ?? '（未提供）'}`,
      '回复：同意 / 拒绝',
    ].join('\n');
    try {
      await this.sendTo(target, { text: question });
    } catch (error) {
      this.log.warn?.('[lark-notify] 发送审批请求失败', error?.message ?? error);
      return finish('unavailable');
    }
    if (req.signal?.aborted) return finish('cancelled');

    return new Promise((resolveOutcome) => {
      let settled = false;
      const settle = (outcome) => {
        if (settled) return;
        settled = true;
        this.clearApproval(state.sessionId);
        resolveOutcome(finish(outcome));
      };
      const withdraw = () => {
        this.clearApproval(state.sessionId);
        settle('cancelled');
      };
      const entry = {
        target,
        signal: req.signal,
        resolve: (decision) => {
          if (settled) return;
          void this.sendTo(target, { text: decision === 'yes' ? '已批准。' : '已拒绝。' }).catch(() => {});
          settle(decision === 'yes' ? 'allowed-once' : 'rejected');
        },
      };
      this.clearApproval(state.sessionId);
      this.pendingApprovals.set(state.sessionId, { entry, withdraw, timer: null });
      req.signal?.addEventListener('abort', withdraw, { once: true });
      if (this.approvalTimeoutMs > 0) {
        const timer = setTimeout(withdraw, this.approvalTimeoutMs);
        timer.unref?.();
        this.pendingApprovals.get(state.sessionId).timer = timer;
      }
    });
  }

  answerApproval(sessionId, decision) {
    const pending = this.pendingApprovals.get(sessionId);
    if (!pending) return;
    pending.entry.resolve(decision);
  }

  clearApproval(sessionId) {
    const pending = this.pendingApprovals.get(sessionId);
    this.pendingApprovals.delete(sessionId);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    try {
      pending.entry.signal?.removeEventListener?.('abort', pending.withdraw);
    } catch {
      // 忽略
    }
  }

  // ------------------------------------------------------------ 回合生命周期

  /** ctx.on("session/event") 的回调。 */
  onSessionEvent(session, event) {
    const sessionId = String(session?.id ?? '');
    const state = this.states.get(sessionId);
    if (!state) return;
    if (event.type === 'turn/start') {
      state.replyTools.resetTurn();
      if (state.pending) {
        state.turn = {
          target: state.pending.target,
          sender: state.pending.sender ?? null,
          isGroup: state.pending.isGroup === true,
          texts: [],
          replied: false,
          placeholderId: null,
          timer: null,
        };
        state.pending = null;
        this.scheduleTyping(state);
      } else {
        state.turn = null; // GUI 发起的轮次不回发飞书
      }
      return;
    }
    if (!state.turn) return;
    if (event.type === 'tool/call') {
      const name = event.data?.name;
      if (typeof name === 'string' && (name === 'lark_notify' || name.startsWith('send_lark'))) {
        state.turn.replied = true;
      }
      return;
    }
    if (event.type === 'assistant/message') {
      const text = assistantText(event.data?.message);
      if (text !== '') state.turn.texts.push(text);
      return;
    }
    if (event.type === 'turn/end') {
      const turn = state.turn;
      state.turn = null;
      this.clearTypingTimer(turn);
      const reason = event.data?.reason?.kind;
      const text = turn.texts.join('\n\n').trim();
      const answered = turn.replied || state.replyTools.answered();
      void this.finishTurn(turn, { text, answered, reason });
    }
  }

  scheduleTyping(state) {
    const turn = state.turn;
    turn.timer = setTimeout(() => {
      if (state.turn !== turn || turn.placeholderId !== null) return;
      void this.sendTo(turn.target, { text: '⏳ 收到，正在处理…' })
        .then((result) => {
          if (result?.messageId) {
            turn.placeholderId = result.messageId;
            this.logEvent({ type: 'placeholder-created', messageId: result.messageId });
          } else {
            this.logEvent({ type: 'placeholder-missing-id' });
          }
        })
        .catch(() => {});
    }, TYPING_DELAY_MS);
    turn.timer.unref?.();
  }

  clearTypingTimer(turn) {
    if (turn?.timer) {
      clearTimeout(turn.timer);
      turn.timer = null;
    }
  }

  async finishTurn(turn, { text, answered, reason }) {
    // 有占位消息时尽量编辑它，避免多一条「正在处理…」。
    const placeholderId = turn.placeholderId;
    if (answered) {
      if (placeholderId) {
        await this.tryUpdate(placeholderId, '✅ 已处理，结果见上一条消息。');
      }
      return;
    }
    if (reason === 'error' && text === '') {
      const message = '⚠️ 处理失败，请稍后再试。';
      if (placeholderId) {
        const updated = await this.tryUpdate(placeholderId, message);
        if (updated) return;
      }
      await this.replyChunks(turn.target, message);
      return;
    }
    if (text === '') {
      if (placeholderId) await this.tryUpdate(placeholderId, '（这一轮没有产生可发送的文字回复）');
      return;
    }
    const finalText = fixAtTags(text, turn);
    if (this.shouldMarkdown(finalText)) {
      if (placeholderId) await this.tryUpdate(placeholderId, '✅ 已处理，结果见下一条消息。');
      try {
        await this.sendReplyText(turn.target, finalText);
      } catch (error) {
        this.lastError = error?.message ?? String(error);
        this.log.warn?.('[lark-notify] 发送 Markdown 回复失败', this.lastError);
      }
      return;
    }
    const chunks = splitText(finalText);
    if (placeholderId && chunks.length > 0) {
      const updated = await this.tryUpdate(placeholderId, chunks[0]);
      if (updated) {
        for (const chunk of chunks.slice(1)) await this.replyChunks(turn.target, chunk);
        return;
      }
    }
    for (const chunk of chunks) await this.replyChunks(turn.target, chunk);
  }

  async tryUpdate(messageId, text) {
    try {
      await updateTextMessage(this.getCreds(), messageId, text);
      this.logEvent({ type: 'placeholder-updated', messageId });
      return true;
    } catch (error) {
      this.log.warn?.('[lark-notify] 编辑占位消息失败', error?.message ?? error);
      this.logEvent({ type: 'placeholder-update-failed', messageId, error: error?.message ?? String(error) });
      return false;
    }
  }

  /** 文字回复是否该按 Markdown 卡片发送。 */
  shouldMarkdown(text) {
    if (this.markdownMode === 'off') return false;
    const raw = String(text ?? '');
    if (this.markdownMode === 'always') return raw.trim() !== '';
    return /(^|\n)\s{0,3}#{1,6}\s/.test(raw)
      || /\*\*[^*\n]+\*\*/.test(raw)
      || /```/.test(raw)
      || /(^|\n)\s*([-*+]|\d+\.)\s+\S/.test(raw)
      || /(^|\n)\s*\|.+\|/.test(raw)
      || /`[^`\n]+`/.test(raw)
      || /\[[^\]\n]+\]\([^)\n]+\)/.test(raw)
      || /(^|\n)>\s/.test(raw);
  }

  /** 回复文字：命中 Markdown 时走卡片 2.0，否则普通文本。 */
  async sendReplyText(target, text) {
    const body = String(text ?? '');
    if (this.shouldMarkdown(body)) return this.sendTo(target, { markdown: body });
    return this.sendTo(target, { text: body });
  }

  async replyChunks(target, text) {
    try {
      await this.sendTo(target, { text });
    } catch (error) {
      this.lastError = error?.message ?? String(error);
      this.log.warn?.('[lark-notify] 回发飞书失败，已进入重试队列', this.lastError);
      try {
        this.enqueue?.(target, { text });
      } catch {
        // 入队失败也只能记日志
      }
    }
  }
}

export { DEFAULT_CWD, DEFAULT_SESSION_ID, DEFAULT_GROUP_SESSION_PREFIX, SESSION_SOURCE };
