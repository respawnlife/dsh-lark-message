// 会话专属回复工具：把「当前飞书对话」变成模型可以直接调用的三个工具。
//
// 与全局 lark_notify 的分工：
//   - lark_notify 注册在插件根作用域，任何会话都能主动推送到绑定的飞书目标；
//   - send_lark_{text,image,file} 只注册到飞书入站会话的 agent 作用域，目标是这一轮
//     消息所在的对话；发送成功后置 answered 标记，入站逻辑据此跳过
//     「回合结束自动回发文字」，避免同一句话发两遍。
//
// 回调签名（由 index.js / inbound.js 注入）：
//   getTarget()                  → { type: 'chat_id' | 'open_id', id: string } | null
//   sendText(target, text)       → Promise
//   sendImage(target, imagePath) → Promise
//   sendFile(target, filePath)   → Promise（可选，缺省时 send_lark_file 明确报错）
//
// 所有工具自身不抛错：成功 { ok: true }，失败 { ok: false, error }。
// 媒体已发出但配文失败时返回 { ok: true, warning }：图/文件已经送达，模型不应该重发。

const TARGET_ERROR = '当前没有飞书对话目标';
const MAX_PREVIEW = 60;

function messageOf(error) {
  return error?.message ?? String(error ?? '未知错误');
}

function previewText(value, max = MAX_PREVIEW) {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function baseName(value) {
  const parts = String(value ?? '')
    .split(/[\\/]/)
    .filter((part) => part !== '');
  return parts.length > 0 ? parts[parts.length - 1] : String(value ?? '');
}

function outputFor(label) {
  return {
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', description: '是否已发出' },
        error: { type: 'string', description: '失败原因' },
        warning: { type: 'string', description: '部分成功时的提示，例如媒体已发出但配文没发出去' },
      },
      required: ['ok'],
      additionalProperties: true,
    },
    render(args, value) {
      if (value?.ok) {
        const detail = label === '消息' ? previewText(args?.text) : baseName(args?.image_path ?? args?.file_path);
        return [{ type: 'text', text: `已发送飞书${label}：${detail}` }];
      }
      return [{ type: 'text', text: `飞书${label}发送失败：${value?.error ?? '未知错误'}` }];
    },
  };
}

const AT_TAG_RE = /<at\b[^>]*>[\s\S]*?<\/at>/gi;
const AT_OPEN_ID_RE = /user_id\s*=\s*["“”']?(ou_[A-Za-z0-9_-]+)["“”']?/i;
const AT_INNER_RE = /<at\b[^>]*>([\s\S]*?)<\/at>/i;

/**
 * 从模型可能写出的 at 标签里提取 open_id/名字，并把标签从正文剥掉。
 * 飞书文本消息不认手写标签（尤其模型爱用中文引号），必须由我们重拼。
 */
function extractAtMentions(text) {
  const mentions = [];
  const cleaned = String(text ?? '').replace(AT_TAG_RE, (tag) => {
    const openId = AT_OPEN_ID_RE.exec(tag)?.[1];
    const name = (AT_INNER_RE.exec(tag)?.[1] ?? '').trim();
    if (openId) mentions.push({ openId, name });
    return '';
  }).replace(/[ \t]{2,}/g, ' ').trim();
  return { cleaned, mentions };
}

function dedupeMentions(list) {
  const seen = new Set();
  const result = [];
  for (const mention of list) {
    if (!mention || typeof mention.openId !== 'string' || mention.openId === '') continue;
    if (seen.has(mention.openId)) continue;
    seen.add(mention.openId);
    result.push({ openId: mention.openId, name: typeof mention.name === 'string' ? mention.name : '' });
  }
  return result;
}

function renderMentions(mentions) {
  return mentions.map((mention) => `<at user_id="${mention.openId}">${mention.name}</at>`).join(' ');
}

export function createReplyTools({ getTarget, getMention = null, resolveMentions = null, sendText, sendImage, sendFile, log = console } = {}) {
  let replied = false;
  const registered = new WeakSet();
  const warn = typeof log?.warn === 'function' ? (...args) => log.warn(...args) : () => {};

  function markAnswered() {
    replied = true;
  }

  function resolveTarget() {
    let target = null;
    try {
      target = typeof getTarget === 'function' ? getTarget() : null;
    } catch (error) {
      warn('[lark-notify] 读取当前飞书目标失败', messageOf(error));
      return { error: TARGET_ERROR };
    }
    if (!target || typeof target.id !== 'string' || target.id.trim() === '') return { error: TARGET_ERROR };
    return { target: { type: target.type, id: target.id } };
  }

  /** 配文发送失败只降级成 warning：媒体已经送达，不能让模型把整条消息重发一遍。 */
  async function sendCaption(target, caption) {
    const text = typeof caption === 'string' ? caption.trim() : '';
    if (text === '') return null;
    if (typeof sendText !== 'function') return '配文未发送：当前没有文字发送能力';
    try {
      await sendText(target, text);
      return null;
    } catch (error) {
      warn('[lark-notify] 配文发送失败', messageOf(error));
      return `配文未发送：${messageOf(error)}`;
    }
  }

  /** 当前聊天里被回复的人；{ openId, name } 或 null。 */
  function mentionOf() {
    try {
      const mention = typeof getMention === 'function' ? getMention() : null;
      if (!mention || typeof mention.openId !== 'string' || mention.openId === '') return null;
      return mention;
    } catch (error) {
      warn('[lark-notify] 读取当前 @ 目标失败', messageOf(error));
      return null;
    }
  }

  function definitionText() {
    return {
      name: 'send_lark_text',
      description:
        '在当前飞书对话里发一条纯文本消息。用户正在飞书里和你聊天时，用它主动回复；飞书文字消息不渲染 Markdown。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '消息正文，纯文本，可以含换行' },
          mention_sender: {
            type: 'boolean',
            description: '是否在消息开头 @ 提问者。群聊里需要点名回复某人时才传 true，默认不 @。',
          },
          mentions: {
            type: 'array',
            description: '要 @ 的其他成员：可传 open_id（ou_...）或群成员名字。先用 list_lark_members 查 open_id 最稳。',
            items: { type: 'string' },
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
      output: outputFor('消息'),
      timeoutMs: 30_000,
      async execute(args) {
        try {
          const raw = String(args?.text ?? '').trim();
          if (raw === '') return { ok: false, error: 'text 不能为空' };
          const { target, error } = resolveTarget();
          if (error) return { ok: false, error };
          if (typeof sendText !== 'function') return { ok: false, error: '当前没有文字发送能力' };

          const { cleaned, mentions: inline } = extractAtMentions(raw);
          const wanted = [...inline];
          if (args?.mention_sender === true) {
            const sender = mentionOf();
            if (sender) wanted.push(sender);
          }
          const tokens = Array.isArray(args?.mentions) ? args.mentions.filter((token) => typeof token === 'string' && token.trim() !== '') : [];
          if (tokens.length > 0) {
            if (typeof resolveMentions === 'function') {
              try {
                const resolved = await resolveMentions(tokens);
                for (const mention of resolved ?? []) wanted.push(mention);
              } catch (resolveError) {
                warn('[lark-notify] 解析 @ 成员失败', messageOf(resolveError));
              }
            } else {
              for (const token of tokens) if (token.startsWith('ou_')) wanted.push({ openId: token, name: '' });
            }
          }
          const mentions = dedupeMentions(wanted);
          let text = cleaned;
          if (text === '' && mentions.length > 0) text = '（见上一条）';
          const prefix = renderMentions(mentions);
          await sendText(target, prefix === '' ? text : `${prefix} ${text}`);
          markAnswered();
          return { ok: true };
        } catch (error) {
          warn('[lark-notify] send_lark_text 失败', messageOf(error));
          return { ok: false, error: messageOf(error) };
        }
      },
    };
  }

  function definitionImage() {
    return {
      name: 'send_lark_image',
      description:
        '把一张本地图片发到当前飞书对话。caption 非空时，先发图片再发一条文字说明。',
      parameters: {
        type: 'object',
        properties: {
          image_path: {
            type: 'string',
            description: '本地图片绝对路径（PNG/JPEG/GIF/WebP，10MB 以内）',
          },
          caption: { type: 'string', description: '可选：图片之后的文字说明' },
        },
        required: ['image_path'],
        additionalProperties: false,
      },
      output: outputFor('图片'),
      timeoutMs: 60_000,
      async execute(args) {
        try {
          const imagePath = String(args?.image_path ?? '').trim();
          if (imagePath === '') return { ok: false, error: 'image_path 不能为空' };
          const { target, error } = resolveTarget();
          if (error) return { ok: false, error };
          if (typeof sendImage !== 'function') return { ok: false, error: '当前没有图片发送能力' };
          await sendImage(target, imagePath);
          markAnswered();
          const warning = await sendCaption(target, args?.caption);
          return warning ? { ok: true, warning } : { ok: true };
        } catch (error) {
          warn('[lark-notify] send_lark_image 失败', messageOf(error));
          return { ok: false, error: messageOf(error) };
        }
      },
    };
  }

  function definitionFile() {
    return {
      name: 'send_lark_file',
      description:
        '把一个本地文件发到当前飞书对话。caption 非空时，先发文件再发一条文字说明。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '本地文件绝对路径' },
          caption: { type: 'string', description: '可选：文件之后的文字说明' },
        },
        required: ['file_path'],
        additionalProperties: false,
      },
      output: outputFor('文件'),
      timeoutMs: 60_000,
      async execute(args) {
        try {
          const filePath = String(args?.file_path ?? '').trim();
          if (filePath === '') return { ok: false, error: 'file_path 不能为空' };
          const { target, error } = resolveTarget();
          if (error) return { ok: false, error };
          if (typeof sendFile !== 'function') return { ok: false, error: '当前版本不支持发送文件' };
          await sendFile(target, filePath);
          markAnswered();
          const warning = await sendCaption(target, args?.caption);
          return warning ? { ok: true, warning } : { ok: true };
        } catch (error) {
          warn('[lark-notify] send_lark_file 失败', messageOf(error));
          return { ok: false, error: messageOf(error) };
        }
      },
    };
  }

  function toolsOf(agentCtx) {
    if (typeof agentCtx.tools?.register === 'function') return agentCtx.tools;
    try {
      const viaGet = agentCtx.get?.('tools');
      if (typeof viaGet?.register === 'function') return viaGet;
    } catch {
      // 拿不到 tools 服务时按未注册处理
    }
    return null;
  }

  /** 在某个 agent 作用域注册工具。同一个 ctx 只注册一次。 */
  function register(agentCtx) {
    if (!agentCtx || (typeof agentCtx !== 'object' && typeof agentCtx !== 'function')) return;
    if (registered.has(agentCtx)) return;
    const tools = toolsOf(agentCtx);
    if (!tools) {
      warn('[lark-notify] agent 作用域没有可用的 tools.register，跳过回复工具注册');
      return;
    }
    registered.add(agentCtx);
    for (const definition of [definitionText(), definitionImage(), definitionFile()]) {
      try {
        if (typeof agentCtx.effect === 'function') {
          agentCtx.effect(() => tools.register(definition), `lark-notify: ${definition.name}`);
        } else {
          tools.register(definition);
        }
      } catch (error) {
        warn(`[lark-notify] 注册工具 ${definition.name} 失败`, messageOf(error));
      }
    }
  }

  return {
    register,
    /** 每个新回合开始时由入站逻辑调用。 */
    resetTurn() {
      replied = false;
    },
    /** 本回合是否已经通过这些工具回复过。 */
    answered() {
      return replied;
    },
  };
}
