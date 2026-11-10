// 发送重试队列：发不出去的消息先落成 JSONL，之后按最老优先重试。
//
// 设计要点：
//   - 单文件、逐行一条 item，文件权限 0600；同一内容（target + 正文/图片/文件）只入队一次；
//   - flush 顺序发送，单条失败只记录 lastError，不影响后续条目；失败条目留在队列里；
//   - flush 用 inFlight 标记互斥，避免并发重复发送；
//   - 文件里的坏行在加载时跳过，并立即重写成干净内容。
//
// item: { target: { type: 'chat_id'|'open_id', id: string }, text?, imagePath?, filePath? }
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function messageOf(error) {
  return error?.message ?? String(error ?? '未知错误');
}

function ensureParent(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalize(item) {
  if (!item || typeof item !== 'object') return null;
  const target = item.target;
  if (!target || typeof target !== 'object') return null;
  if (target.type !== 'chat_id' && target.type !== 'open_id') return null;
  if (typeof target.id !== 'string' || target.id.trim() === '') return null;
  const text = trimString(item.text);
  const imagePath = trimString(item.imagePath);
  const filePath = trimString(item.filePath);
  if (text === '' && imagePath === '' && filePath === '') return null;
  const normalized = { target: { type: target.type, id: target.id } };
  if (text !== '') normalized.text = text;
  if (imagePath !== '') normalized.imagePath = imagePath;
  if (filePath !== '') normalized.filePath = filePath;
  return normalized;
}

/** 内容指纹：同样的目标 + 同样的正文/媒体视为同一条，不重复入队。 */
function hashOf(item) {
  const canonical = JSON.stringify({
    target: { type: item.target.type, id: item.target.id },
    text: item.text ?? '',
    imagePath: item.imagePath ?? '',
    filePath: item.filePath ?? '',
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export function createOutbox({ file, send, log = console } = {}) {
  if (typeof file !== 'string' || file.trim() === '') throw new TypeError('createOutbox 需要 file 路径');
  if (typeof send !== 'function') throw new TypeError('createOutbox 需要 send 回调');

  const filePath = file;
  const warn = typeof log?.warn === 'function' ? (...args) => log.warn(...args) : () => {};
  const entries = [];
  const hashes = new Set();
  let inFlight = false;
  let lastErrorValue = null;

  function rewrite() {
    ensureParent(filePath);
    const body = entries.map((entry) => JSON.stringify(entry.item)).join('\n');
    const content = body === '' ? '' : `${body}\n`;
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      // 非 POSIX 文件系统忽略
    }
    fs.renameSync(tmp, filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // 同上
    }
  }

  function appendLine(item) {
    ensureParent(filePath);
    fs.appendFileSync(filePath, `${JSON.stringify(item)}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // 非 POSIX 文件系统忽略
    }
  }

  function load() {
    let raw = '';
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') warn('[lark-notify] 读取发送队列失败', messageOf(error));
      return;
    }
    let dirty = false;
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        dirty = true;
        continue;
      }
      const item = normalize(parsed);
      if (!item) {
        dirty = true;
        continue;
      }
      const hash = hashOf(item);
      if (hashes.has(hash)) {
        dirty = true;
        continue;
      }
      entries.push({ hash, item });
      hashes.add(hash);
    }
    if (dirty) {
      try {
        rewrite();
      } catch (error) {
        warn('[lark-notify] 重写发送队列失败', messageOf(error));
      }
    }
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // 非 POSIX 文件系统忽略
    }
  }

  /** 入队：写入 JSONL 并返回本次新增条数（去重/无效条目返回 0）。 */
  function enqueue(item) {
    const normalized = normalize(item);
    if (!normalized) {
      warn('[lark-notify] 发送队列忽略无效条目');
      return 0;
    }
    const hash = hashOf(normalized);
    if (hashes.has(hash)) return 0;
    entries.push({ hash, item: normalized });
    hashes.add(hash);
    try {
      appendLine(normalized);
    } catch (error) {
      warn('[lark-notify] 写入发送队列失败（仅保留在内存）', messageOf(error));
    }
    return 1;
  }

  /** 顺序重试最老的 max 条；单条失败不中断整批，返回本次结果与剩余条数。 */
  async function flush(max = 5) {
    const parsedMax = Number(max);
    const limit = Number.isFinite(parsedMax) && parsedMax >= 1 ? Math.min(100, Math.floor(parsedMax)) : 5;
    if (inFlight) return { sent: 0, failed: 0, remaining: entries.length, busy: true };
    inFlight = true;
    let sent = 0;
    let failed = 0;
    try {
      const batch = entries.slice(0, limit);
      for (const entry of batch) {
        try {
          await send({ ...entry.item, target: { ...entry.item.target } });
          sent += 1;
          const index = entries.indexOf(entry);
          if (index >= 0) entries.splice(index, 1);
          hashes.delete(entry.hash);
        } catch (error) {
          failed += 1;
          lastErrorValue = messageOf(error);
          warn('[lark-notify] 发送队列重试失败，保留该条', lastErrorValue);
        }
      }
      // 一批里只要有一条失败就保留错误；整批干净成功才清空。
      if (failed === 0 && sent > 0) lastErrorValue = null;
      if (sent > 0) {
        try {
          rewrite();
        } catch (error) {
          warn('[lark-notify] 重写发送队列失败', messageOf(error));
        }
      }
    } finally {
      inFlight = false;
    }
    return { sent, failed, remaining: entries.length };
  }

  /** 同步读取内存计数（初始化时已从文件加载）。 */
  function pendingCount() {
    return entries.length;
  }

  /** 当前队列内容（副本，调用方改不到内部状态）。 */
  function items() {
    return entries.map((entry) => ({ ...entry.item, target: { ...entry.item.target } }));
  }

  /** 最近一次失败的原因；一整批 flush 干净成功后清空。 */
  function lastError() {
    return lastErrorValue;
  }

  load();

  return { enqueue, flush, pendingCount, items, lastError };
}
