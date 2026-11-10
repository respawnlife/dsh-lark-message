// 飞书发送端：文字 + 图片，全部走官方 Node SDK（自动缓存 tenant_access_token）。
import fs from 'node:fs';
import * as lark from '@larksuiteoapi/node-sdk';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function domainOf(creds) {
  return creds?.tenantBrand === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu;
}

export function createClient(creds) {
  return new lark.Client({
    appId: creds.appId,
    appSecret: creds.appSecret,
    appType: lark.AppType.SelfBuild,
    domain: domainOf(creds),
    loggerLevel: lark.LoggerLevel.warn,
  });
}

function sdkError(res, action) {
  const code = res?.code ?? '?';
  const msg = res?.msg || res?.message || '未知错误';
  return new Error(`${action}失败（code=${code}）：${msg}`);
}

/** 用 tenant_access_token 校验 App ID / App Secret 是否可用。 */
export async function verifyCredentials({ appId, appSecret, tenantBrand = 'feishu' }) {
  if (!appId || !appSecret) throw new Error('App ID / App Secret 不能为空');
  const client = createClient({ appId, appSecret, tenantBrand });
  const res = await client.auth.v3.tenantAccessToken.internal({
    data: { app_id: appId, app_secret: appSecret },
  });
  if (res?.code !== 0) throw sdkError(res, '凭据校验');
  return true;
}

function requireTarget(creds, override) {
  const target = override ?? creds?.target;
  if (!target || typeof target.id !== 'string' || target.id === '') {
    throw new Error('还没有绑定发送目标（目标用户 open_id）');
  }
  if (target.type !== 'open_id' && target.type !== 'chat_id') {
    throw new Error(`不支持的发送目标类型：${target.type}`);
  }
  return target;
}

export async function sendText(creds, text, targetOverride) {
  const body = String(text ?? '').trim();
  if (body === '') throw new Error('消息正文不能为空');
  const target = requireTarget(creds, targetOverride);
  const client = createClient(creds);
  const res = await client.im.message.create({
    params: { receive_id_type: target.type },
    data: {
      receive_id: target.id,
      msg_type: 'text',
      content: JSON.stringify({ text: body }),
    },
  });
  if (res?.code !== 0) throw sdkError(res, '发送文字消息');
  return { messageId: res?.data?.message_id ?? '' };
}

export async function sendImage(creds, imagePath, targetOverride) {
  const target = requireTarget(creds, targetOverride);
  let stat;
  try {
    stat = fs.statSync(imagePath);
  } catch {
    throw new Error(`图片不存在或不可读：${imagePath}`);
  }
  if (!stat.isFile()) throw new Error(`不是文件：${imagePath}`);
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new Error(`图片超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB 上限`);
  }
  const client = createClient(creds);
  // 注意：im/v1/images 的成功响应被 SDK 直接摊平成 { image_key }，没有 code/data 包一层；
  // 其他 im 接口是 { code, msg, data }。这里两种形状都兼容。
  const upload = await client.im.image.create({
    data: { image_type: 'message', image: fs.createReadStream(imagePath) },
  });
  if (upload?.code !== undefined && upload.code !== 0) throw sdkError(upload, '上传图片');
  const imageKey = upload?.image_key ?? upload?.data?.image_key;
  if (!imageKey) {
    throw new Error(`上传图片成功但响应里没有 image_key：${JSON.stringify(upload).slice(0, 300)}`);
  }
  const res = await client.im.message.create({
    params: { receive_id_type: target.type },
    data: {
      receive_id: target.id,
      msg_type: 'image',
      content: JSON.stringify({ image_key: imageKey }),
    },
  });
  if (res?.code !== 0) throw sdkError(res, '发送图片消息');
  return { messageId: res?.data?.message_id ?? '' };
}

const MAX_FILE_BYTES = 30 * 1024 * 1024;

/** 发送本地文件（PDF/Office/压缩包等）。 */
export async function sendFile(creds, filePath, targetOverride) {
  const target = requireTarget(creds, targetOverride);
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error(`文件不存在或不可读：${filePath}`);
  }
  if (!stat.isFile()) throw new Error(`不是文件：${filePath}`);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`文件超过 ${MAX_FILE_BYTES / 1024 / 1024}MB 上限`);
  const client = createClient(creds);
  const upload = await client.im.file.create({
    data: {
      file_type: 'stream',
      file_name: filePath.split('/').pop() || 'file.bin',
      file: fs.createReadStream(filePath),
    },
  });
  if (upload?.code !== undefined && upload.code !== 0) throw sdkError(upload, '上传文件');
  const fileKey = upload?.file_key ?? upload?.data?.file_key;
  if (!fileKey) throw new Error(`上传文件成功但响应里没有 file_key：${JSON.stringify(upload).slice(0, 200)}`);
  const res = await client.im.message.create({
    params: { receive_id_type: target.type },
    data: {
      receive_id: target.id,
      msg_type: 'file',
      content: JSON.stringify({ file_key: fileKey }),
    },
  });
  if (res?.code !== 0) throw sdkError(res, '发送文件消息');
  return { messageId: res?.data?.message_id ?? '' };
}

/** 编辑机器人自己发过的文本消息（用于「处理中…」占位消息）。 */
export async function updateTextMessage(creds, messageId, text) {
  const client = createClient(creds);
  const res = await client.im.message.update({
    path: { message_id: messageId },
    data: { msg_type: 'text', content: JSON.stringify({ text: String(text ?? '') }) },
  });
  if (res?.code !== undefined && res.code !== 0) throw sdkError(res, '编辑消息');
  return true;
}

/** 读取一条消息的纯文本内容（用于理解引用回复）。 */
export async function readMessageText(creds, messageId) {
  const client = createClient(creds);
  const res = await client.im.message.get({ path: { message_id: messageId } });
  if (res?.code !== undefined && res.code !== 0) throw sdkError(res, '读取消息');
  const item = res?.data?.items?.[0];
  const raw = item?.body?.content;
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.text === 'string') return parsed.text;
    if (typeof parsed?.content === 'string') return parsed.content;
  } catch {
    // 非文本消息
  }
  return null;
}

/** 列出机器人所在的群（不含单聊；单聊请用 open_id 直接投递）。 */
export async function listChats(creds) {
  const client = createClient(creds);
  const chats = [];
  let pageToken;
  for (let page = 0; page < 5; page += 1) {
    const res = await client.im.chat.list({
      params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
    });
    if (res?.code !== undefined && res.code !== 0) throw sdkError(res, '获取群列表');
    const items = Array.isArray(res?.data?.items) ? res.data.items : [];
    for (const item of items) {
      chats.push({
        chat_id: item?.chat_id ?? '',
        name: item?.name ?? '',
        chat_mode: item?.chat_mode ?? '',
        external: item?.external === true,
      });
    }
    const hasMore = res?.data?.has_more === true && typeof res?.data?.page_token === 'string';
    if (!hasMore) break;
    pageToken = res.data.page_token;
  }
  return chats;
}

const CARD_MARKDOWN_MAX = 12000;

/** 文本消息里的 @ 语法 → 卡片 markdown 的 @ 语法。 */
function toCardMentionSyntax(markdown) {
  return String(markdown ?? '').replace(
    /<at\b[^>]*user_id\s*=\s*["“”']?(ou_[A-Za-z0-9_-]+)["“”']?[^>]*>[\s\S]*?<\/at>/gi,
    (_tag, openId) => `<at id=${openId}></at>`,
  );
}

function splitMarkdown(markdown) {
  const chunks = [];
  let rest = String(markdown ?? '').trim();
  while (rest.length > CARD_MARKDOWN_MAX) {
    let cut = rest.lastIndexOf('\n', CARD_MARKDOWN_MAX);
    if (cut < CARD_MARKDOWN_MAX * 0.5) cut = CARD_MARKDOWN_MAX;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest !== '') chunks.push(rest);
  return chunks;
}

/**
 * 用「卡片 JSON 2.0 + markdown 组件」发送 Markdown（飞书纯文本消息不渲染 Markdown）。
 * 返回 { messageId }；内容过长时拆成多条卡片。
 */
export async function sendMarkdown(creds, markdown, targetOverride) {
  const body = String(markdown ?? '').trim();
  if (body === '') throw new Error('Markdown 内容不能为空');
  const target = requireTarget(creds, targetOverride);
  const client = createClient(creds);
  const chunks = splitMarkdown(toCardMentionSyntax(body));
  let lastMessageId = '';
  for (const chunk of chunks) {
    const card = {
      schema: '2.0',
      body: { elements: [{ tag: 'markdown', content: chunk }] },
    };
    const res = await client.im.message.create({
      params: { receive_id_type: target.type },
      data: {
        receive_id: target.id,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    });
    if (res?.code !== 0) throw sdkError(res, '发送 Markdown 卡片');
    lastMessageId = res?.data?.message_id ?? '';
  }
  return { messageId: lastMessageId };
}
