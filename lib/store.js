// 本地状态：凭据、发送历史、脚本用 HTTP token。
// 全部落在 $DSH_HOME/integrations/lark-notify/ 下，权限 0600/0700，不进 profile 配置。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function dshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env.trim() !== '') return env.trim();
  return path.join(os.homedir(), '.dsh');
}

export function stateDir() {
  return path.join(dshHome(), 'integrations', 'lark-notify');
}

export function credentialsPath() {
  return path.join(stateDir(), 'credentials.json');
}

export function historyPath() {
  return path.join(stateDir(), 'history.jsonl');
}

export function tokenPath() {
  return path.join(stateDir(), 'http-token');
}

export function endpointPath() {
  return path.join(stateDir(), 'endpoint');
}

export function outboxPath() {
  return path.join(stateDir(), 'outbox.jsonl');
}

export function eventsPath() {
  return path.join(stateDir(), 'inbound-events.jsonl');
}

export function approvalsPath() {
  return path.join(stateDir(), 'approvals.jsonl');
}

function ensureDir() {
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  ensureDir();
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // 非 POSIX 文件系统忽略
  }
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // 同上
  }
}

export function readCredentials() {
  const creds = readJson(credentialsPath());
  if (creds === null || typeof creds !== 'object') return null;
  if (typeof creds.appId !== 'string' || typeof creds.appSecret !== 'string') return null;
  return creds;
}

export function writeCredentials(creds) {
  writeJsonAtomic(credentialsPath(), creds);
  return creds;
}

export function clearCredentials() {
  try {
    fs.unlinkSync(credentialsPath());
  } catch {
    // 本来就不存在
  }
}

/** 生成/读取脚本调用 HTTP 推送接口的 token（0600）。 */
export function ensureHttpToken() {
  const file = tokenPath();
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) {
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        // 忽略
      }
      return existing;
    }
  } catch {
    // 首次生成
  }
  const token = crypto.randomBytes(24).toString('hex');
  ensureDir();
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // 忽略
  }
  return token;
}

/** 把脚本调用地址写到 endpoint 文件，让本地脚本不必猜 DSH 端口。 */
export function writeEndpoint(endpoint) {
  const value = String(endpoint ?? '').trim();
  if (!/^https?:\/\//.test(value)) return null;
  ensureDir();
  const file = endpointPath();
  fs.writeFileSync(file, `${value}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // 忽略
  }
  return value;
}

/** 追加一条发送记录；返回落盘后的记录。 */
export function appendHistory(entry) {
  const row = { at: new Date().toISOString(), ok: false, kind: 'text', preview: '', ...entry };
  try {
    ensureDir();
    fs.appendFileSync(historyPath(), `${JSON.stringify(row)}\n`);
  } catch {
    // 历史不是关键路径，写失败不影响发送
  }
  return row;
}

/** 最近 limit 条，最新在前。 */
export function readHistory(limit = 20) {
  let text = '';
  try {
    text = fs.readFileSync(historyPath(), 'utf8');
  } catch {
    return [];
  }
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  const take = Math.max(1, Math.min(200, Number(limit) || 20));
  const items = [];
  for (const line of lines.slice(-take)) {
    try {
      items.push(JSON.parse(line));
    } catch {
      // 跳过坏行
    }
  }
  return items.reverse();
}

/** 清空运行数据（凭据 / 历史 / 诊断日志 / 重试队列 / 端点），但保留 http-token。 */
export function clearRuntimeState() {
  const files = [
    credentialsPath(),
    historyPath(),
    eventsPath(),
    approvalsPath(),
    outboxPath(),
    endpointPath(),
  ];
  const removed = [];
  for (const file of files) {
    try {
      fs.rmSync(file, { force: true });
      removed.push(file);
    } catch {
      // 删不掉就跳过
    }
  }
  return removed;
}

/** 打码：保留头尾便于辨认，不暴露完整凭据。 */
export function mask(value, head = 6, tail = 4) {
  const s = String(value ?? '');
  if (s === '') return '';
  if (s.length <= head + tail + 1) return `${s.slice(0, Math.max(1, Math.floor(s.length / 3)))}***`;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/** 历史预览：压平换行、截断。 */
export function previewText(text, max = 90) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
