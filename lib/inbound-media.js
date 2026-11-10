// 飞书入站媒体下载：把用户在私聊里发来的图片/文件下载到本地目录，
// 让模型可以拿到一个真实路径去读取（例如用视觉工具看图、读文档）。
//
// 只处理 im.message.receive_v1 里的 image / file 两种消息：
//   image: content = {"image_key":"img_v3_..."}
//   file:  content = {"file_key":"...","file_name":"..."}
// 其它类型、缺字段、超限、网络错误一律返回 null，绝不把异常抛给调用方。
import fs from 'node:fs';
import path from 'node:path';

/** 单文件上限：30 MB（飞书接口本身 100 MB，这里主动收紧，避免大文件拖垮会话）。 */
const MAX_BYTES = 30 * 1024 * 1024;
const LOG_PREFIX = '[lark-notify] 入站媒体';
/** 本模块支持的入站消息类型。 */
const MEDIA_TYPES = new Set(['image', 'file']);

/** 超限时用的内部错误，外层统一转成 warn + null。 */
class MediaTooLargeError extends Error {
  constructor(size) {
    super(`文件大小 ${size} 字节超过上限 ${MAX_BYTES} 字节`);
    this.name = 'MediaTooLargeError';
    this.size = size;
  }
}

/** 日志等级调用失败不能影响主流程（调用方可能只实现了部分方法）。 */
function logAt(log, level, ...args) {
  try {
    const fn = log?.[level];
    if (typeof fn === 'function') fn.call(log, LOG_PREFIX, ...args);
  } catch {
    // 忽略日志自身的错误
  }
}

/**
 * 从 SDK 的 messageResource.get 返回值里取二进制内容。
 * 真实 SDK 返回 { writeFile, getReadableStream, headers }；这里兼容
 * 其它形态（readBody / 直接给 Buffer），并把上限检查统一放在这里。
 */
async function fetchBuffer(client, messageId, fileKey, type, dir) {
  const response = await client.im.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type },
  });
  if (!response || typeof response !== 'object') {
    throw new Error('messageResource.get 返回为空');
  }

  // 有 Content-Length 时先拒绝超大文件，省得白下载一遍。
  const declaredSize = Number(response.headers?.['content-length'] ?? response.headers?.['Content-Length']);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_BYTES) {
    throw new MediaTooLargeError(declaredSize);
  }

  if (typeof response.getReadableStream === 'function') {
    return readStreamLimited(response.getReadableStream());
  }

  if (typeof response.readBody === 'function') {
    const body = await response.readBody();
    return ensureSize(toBuffer(body));
  }

  if (typeof response.writeFile === 'function') {
    // 只有 writeFile 时先落到临时文件，再读回来统一做嗅探/改名。
    const tempPath = path.join(dir, `.download-${Date.now()}-${randomHex(4)}.part`);
    try {
      await response.writeFile(tempPath);
      const stat = fs.statSync(tempPath);
      if (stat.size > MAX_BYTES) throw new MediaTooLargeError(stat.size);
      return fs.readFileSync(tempPath);
    } finally {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // 临时文件可能没创建成功
      }
    }
  }

  throw new Error('messageResource.get 返回值不支持 getReadableStream/writeFile/readBody');
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value);
  if (value && typeof value === 'object' && value.data !== undefined) return toBuffer(value.data);
  throw new Error('无法把下载结果转换成 Buffer');
}

function ensureSize(buffer) {
  if (buffer.length > MAX_BYTES) throw new MediaTooLargeError(buffer.length);
  return buffer;
}

/** 逐块读取流，边读边计数；超过上限立即停止，避免把超大文件全读进内存。 */
async function readStreamLimited(stream) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
    throw new Error('getReadableStream() 没有返回可读流');
  }
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_BYTES) throw new MediaTooLargeError(total);
      chunks.push(buffer);
    }
  } finally {
    if (total > MAX_BYTES && typeof stream.destroy === 'function') {
      try {
        stream.destroy();
      } catch {
        // 流已经结束/已销毁
      }
    }
  }
  return Buffer.concat(chunks, total);
}

/** 按魔数嗅探图片格式；识别不了就当 .bin。 */
function sniffImage(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: '.png', mime: 'image/png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: '.jpg', mime: 'image/jpeg' };
  }
  if (buffer.length >= 6) {
    const head = buffer.subarray(0, 6).toString('ascii');
    if (head === 'GIF87a' || head === 'GIF89a') return { ext: '.gif', mime: 'image/gif' };
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { ext: '.webp', mime: 'image/webp' };
  }
  return { ext: '.bin', mime: 'application/octet-stream' };
}

const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bin': 'application/octet-stream',
};

function mimeForName(name) {
  return MIME_BY_EXT[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

/** 文件名消毒：去掉目录部分、控制字符和文件系统敏感字符，并限长。 */
function sanitizeFileName(name) {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .trim();
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return '';
  return cleaned;
}

function randomHex(bytes) {
  return Math.random().toString(16).slice(2, 2 + bytes * 2).padEnd(bytes * 2, '0');
}

/** 时间戳 + 随机串前缀，既防重名又保留时间顺序。 */
function stamp() {
  return `${Date.now()}-${randomHex(4)}`;
}

function uniquePath(dir, fileName) {
  const ext = path.extname(fileName);
  const stem = ext === '' ? fileName : fileName.slice(0, -ext.length);
  let target = path.join(dir, fileName);
  for (let i = 1; i < 100 && fs.existsSync(target); i += 1) {
    target = path.join(dir, `${stem}-${i}${ext}`);
  }
  return target;
}

/** 落盘并强制 0600；返回最终绝对路径。 */
function saveFile(dir, fileName, buffer) {
  const target = uniquePath(dir, fileName);
  fs.writeFileSync(target, buffer, { mode: 0o600, flag: 'wx' });
  try {
    fs.chmodSync(target, 0o600); // 创建时的 mode 会被 umask 影响，再强制一次
  } catch {
    // 权限设置失败不阻塞下载（文件已落盘）
  }
  return target;
}

function parseContent(content) {
  if (content && typeof content === 'object') return content;
  if (typeof content !== 'string' || content.trim() === '') return null;
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 下载一条入站消息里的图片/文件。
 *
 * @param {{
 *   client?: { im?: { messageResource?: { get?: Function } } },
 *   message?: { message_id?: string, message_type?: string, content?: string },
 *   dir?: string,
 *   log?: { warn?: Function, info?: Function, debug?: Function },
 * }} options
 * @returns {Promise<null | { kind: 'image' | 'file', path: string, name: string, size: number, mime?: string }>}
 */
export async function downloadInboundMedia(options = {}) {
  const { client, message, dir, log = console } = options ?? {};
  try {
    const messageType = message?.message_type;
    if (!MEDIA_TYPES.has(messageType)) return null;

    const messageId = typeof message?.message_id === 'string' ? message.message_id.trim() : '';
    if (messageId === '') {
      logAt(log, 'warn', '消息缺少 message_id，跳过');
      return null;
    }

    const content = parseContent(message?.content);
    if (!content) {
      logAt(log, 'warn', `消息 ${messageId} 的 content 不是合法 JSON，跳过`);
      return null;
    }
    const fileKey = String(content[messageType === 'image' ? 'image_key' : 'file_key'] ?? '').trim();
    if (fileKey === '') {
      logAt(log, 'warn', `消息 ${messageId} 缺少 ${messageType === 'image' ? 'image_key' : 'file_key'}，跳过`);
      return null;
    }

    if (typeof dir !== 'string' || dir.trim() === '') {
      logAt(log, 'warn', '未提供保存目录，跳过');
      return null;
    }
    const baseDir = path.resolve(dir);
    fs.mkdirSync(baseDir, { recursive: true });

    if (!client || typeof client.im?.messageResource?.get !== 'function') {
      logAt(log, 'warn', 'client 不可用（缺少 im.messageResource.get），跳过');
      return null;
    }

    const buffer = await fetchBuffer(client, messageId, fileKey, messageType, baseDir);
    if (buffer.length === 0) {
      logAt(log, 'warn', `消息 ${messageId} 下载内容为空，跳过`);
      return null;
    }

    const prefix = stamp();
    if (messageType === 'image') {
      const { ext, mime } = sniffImage(buffer);
      const fileName = `${prefix}-image${ext}`;
      const filePath = saveFile(baseDir, fileName, buffer);
      logAt(log, 'debug', `图片已保存 ${filePath}（${buffer.length} 字节）`);
      logAt(log, 'info', `已保存飞书图片：${filePath}`);
      return { kind: 'image', path: filePath, name: path.basename(filePath), size: buffer.length, mime };
    }

    // file：保留原扩展名，无扩展名补 .bin；name 用消毒后的原始文件名。
    let originalName = sanitizeFileName(content.file_name);
    if (originalName === '') originalName = `file-${prefix}.bin`;
    else if (path.extname(originalName) === '') originalName = `${originalName}.bin`;
    const fileName = `${prefix}-${originalName}`;
    const filePath = saveFile(baseDir, fileName, buffer);
    const mime = mimeForName(originalName);
    logAt(log, 'debug', `文件已保存 ${filePath}（${buffer.length} 字节，${mime}）`);
    logAt(log, 'info', `已保存飞书文件：${filePath}`);
    return { kind: 'file', path: filePath, name: originalName, size: buffer.length, mime };
  } catch (error) {
    if (error instanceof MediaTooLargeError) {
      logAt(log, 'warn', `下载失败：${error.message}`);
    } else {
      logAt(log, 'warn', `下载失败：${error?.message ?? String(error)}`);
    }
    return null;
  }
}
