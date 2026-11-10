// 本地单元测试：会话回复工具 + 发送重试队列。
// 全部用注入的假回调，不联网、不依赖真实飞书。
// 运行：node test/reply.mjs（成功打印 REPLY OK 并退出 0）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReplyTools } from '../lib/reply-tools.js';
import { createOutbox } from '../lib/outbox.js';

const silentLog = { info() {}, warn() {}, error() {} };
const TARGET = { type: 'chat_id', id: 'oc_test_chat' };
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-reply-test-'));
process.on('exit', () => {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // 清理失败不影响测试结论
  }
});

function fakeAgentCtx(registry) {
  const disposers = [];
  return {
    disposers,
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
    tools: {
      register(definition) {
        registry.push(definition);
        return () => {
          const index = registry.indexOf(definition);
          if (index >= 0) registry.splice(index, 1);
        };
      },
    },
  };
}

function toolByName(definitions, name) {
  const found = definitions.find((definition) => definition.name === name);
  assert.ok(found, `缺少工具 ${name}`);
  return found;
}

function makeReplyTools(overrides = {}) {
  const registry = [];
  const ctx = fakeAgentCtx(registry);
  const tools = createReplyTools({
    getTarget: () => TARGET,
    sendText: async () => {},
    sendImage: async () => {},
    sendFile: async () => {},
    log: silentLog,
    ...overrides,
  });
  tools.register(ctx);
  return { tools, registry, ctx };
}

// ---------------- 会话专属回复工具 ----------------
{
  const sends = [];
  const { tools, registry, ctx } = makeReplyTools({
    sendText: async (target, text) => sends.push({ kind: 'text', target, text }),
    sendImage: async (target, imagePath) => sends.push({ kind: 'image', target, imagePath }),
    sendFile: async (target, filePath) => sends.push({ kind: 'file', target, filePath }),
  });

  assert.equal(tools.answered(), false, '初始未回复');
  assert.equal(registry.length, 3, '注册 3 个工具');
  assert.deepEqual(
    registry.map((definition) => definition.name).sort(),
    ['send_lark_file', 'send_lark_image', 'send_lark_text'],
  );
  assert.equal(ctx.disposers.length, 3, '通过 agentCtx.effect 注册并拿到 disposer');

  tools.register(ctx);
  assert.equal(registry.length, 3, '同一个 agentCtx 重复 register 幂等');
  const otherCtx = fakeAgentCtx([]);
  tools.register(otherCtx);
  assert.equal(otherCtx.tools ? otherCtx.disposers.length : 0, 3, '另一个 agentCtx 各自注册一份');

  const textTool = toolByName(registry, 'send_lark_text');
  assert.equal(textTool.parameters.required[0], 'text');
  assert.equal(typeof textTool.output.render, 'function');
  assert.equal(textTool.output.render({ text: 'hi' }, { ok: true })[0].type, 'text');
  assert.match(textTool.output.render({}, { ok: false, error: 'x' })[0].text, /失败/);

  // 发文字
  assert.deepEqual(await textTool.execute({ text: '  你好 飞书 ' }), { ok: true });
  assert.deepEqual(sends[0], { kind: 'text', target: TARGET, text: '你好 飞书' });
  assert.equal(tools.answered(), true, '成功后 answered=true');

  // 空 text 不发送
  assert.equal((await textTool.execute({ text: '   ' })).ok, false);
  assert.equal(sends.length, 1);

  // resetTurn 清空标记
  tools.resetTurn();
  assert.equal(tools.answered(), false);

  // 发图片 + caption：先图后文
  const imageTool = toolByName(registry, 'send_lark_image');
  assert.deepEqual(await imageTool.execute({ image_path: '/tmp/chart.png', caption: '收盘 K 线' }), { ok: true });
  assert.deepEqual(sends.slice(1), [
    { kind: 'image', target: TARGET, imagePath: '/tmp/chart.png' },
    { kind: 'text', target: TARGET, text: '收盘 K 线' },
  ]);
  assert.equal(tools.answered(), true);

  // 发文件 + caption
  tools.resetTurn();
  const fileTool = toolByName(registry, 'send_lark_file');
  assert.deepEqual(await fileTool.execute({ file_path: '/tmp/report.pdf', caption: '报告' }), { ok: true });
  assert.deepEqual(sends.slice(-2), [
    { kind: 'file', target: TARGET, filePath: '/tmp/report.pdf' },
    { kind: 'text', target: TARGET, text: '报告' },
  ]);
  assert.equal(tools.answered(), true);

  // 参数校验：媒体路径为空
  assert.equal((await imageTool.execute({})).ok, false);
  assert.equal((await fileTool.execute({})).ok, false);

  // 发送失败：工具不抛，返回 ok:false，answered 不计入
  tools.resetTurn();
  const failingTarget = { ...TARGET };
  const failing = makeReplyTools({
    getTarget: () => failingTarget,
    sendText: async () => {
      throw new Error('网络断了');
    },
  });
  const failure = await toolByName(failing.registry, 'send_lark_text').execute({ text: 'x' });
  assert.deepEqual(failure, { ok: false, error: '网络断了' });
  assert.equal(failing.tools.answered(), false, '失败不算已回复');

  // 媒体已发出但配文失败 → ok:true + warning，answered=true（模型不应重发图片）
  const partial = makeReplyTools({
    sendText: async () => {
      throw new Error('配文通道断了');
    },
  });
  const partialResult = await toolByName(partial.registry, 'send_lark_image').execute({
    image_path: '/tmp/a.png',
    caption: '配文',
  });
  assert.equal(partialResult.ok, true);
  assert.match(partialResult.warning, /配文未发送/);
  assert.equal(partial.tools.answered(), true);

  // 没有目标
  const noTarget = makeReplyTools({ getTarget: () => null });
  const noTargetText = await toolByName(noTarget.registry, 'send_lark_text').execute({ text: 'hi' });
  assert.equal(noTargetText.ok, false);
  assert.equal(noTargetText.error, '当前没有飞书对话目标');
  const noTargetImage = await toolByName(noTarget.registry, 'send_lark_image').execute({ image_path: '/tmp/a.png' });
  assert.equal(noTargetImage.error, '当前没有飞书对话目标');
  assert.equal(noTarget.tools.answered(), false);

  // 没有 sendFile 实现：明确报错而不是抛
  const noFile = makeReplyTools({ sendFile: undefined });
  const noFileResult = await toolByName(noFile.registry, 'send_lark_file').execute({ file_path: '/tmp/a.pdf' });
  assert.equal(noFileResult.ok, false);
  assert.match(noFileResult.error, /不支持发送文件/);

  // 没有 tools 服务的 ctx 不崩
  assert.doesNotThrow(() => tools.register({}));
  console.log('reply tools OK');
}

// ---------------- 发送重试队列：入队/去重/成功清空 ----------------
{
  const file = path.join(tempRoot, 'outbox.jsonl');
  const sends = [];
  const outbox = createOutbox({ file, send: async (item) => sends.push(item), log: silentLog });

  assert.equal(outbox.pendingCount(), 0);
  assert.equal(outbox.enqueue({ target: TARGET, text: '第一条' }), 1);
  assert.equal(outbox.enqueue({ target: TARGET, text: '第一条' }), 0, '同内容去重');
  assert.equal(outbox.enqueue({ target: { type: 'chat_id', id: 'oc_other' }, text: '第一条' }), 1, '不同 target 不算重复');
  assert.equal(outbox.pendingCount(), 2);
  assert.equal(outbox.items().length, 2);
  assert.equal(outbox.enqueue({ target: TARGET }), 0, '空内容不入队');
  assert.equal(outbox.enqueue({ target: null, text: 'x' }), 0, '无 target 不入队');
  assert.equal(outbox.enqueue({ target: { type: 'nope', id: 'x' }, text: 'x' }), 0, '不支持的目标类型不入队');
  assert.equal(outbox.pendingCount(), 2);
  assert.equal(outbox.enqueue({ target: TARGET, text: '第一条' }), 0, '重复项仍不入队');

  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'JSONL 权限 0600');
  }
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, 'JSONL 一行一条');

  // 重启后从文件加载
  const reloadedOutbox = createOutbox({ file, send: async () => {}, log: silentLog });
  assert.equal(reloadedOutbox.pendingCount(), 2, '初始化时加载已有队列');

  const first = await outbox.flush();
  assert.deepEqual(first, { sent: 2, failed: 0, remaining: 0 });
  assert.equal(outbox.pendingCount(), 0);
  assert.equal(fs.readFileSync(file, 'utf8'), '', '全部成功后队列文件清空');
  assert.equal(sends[0].text, '第一条');
  assert.ok(sends[0].target && sends[0].target.id === TARGET.id, 'send 回调收到完整 item');

  // ids 内容不被外部修改影响
  const itemsCopy = outbox.items();
  itemsCopy.push({ target: TARGET, text: '伪造' });
  assert.equal(outbox.pendingCount(), 0);
}

// ---------------- 发送重试队列：失败保留 + 不中断整批 ----------------
{
  const file = path.join(tempRoot, 'outbox-fail.jsonl');
  const outbox = createOutbox({
    file,
    send: async (item) => {
      if (item.text === '坏消息') throw new Error('网络断了');
    },
    log: silentLog,
  });
  outbox.enqueue({ target: TARGET, text: '坏消息' });
  outbox.enqueue({ target: TARGET, text: '好消息' });

  const result = await outbox.flush();
  assert.deepEqual(result, { sent: 1, failed: 1, remaining: 1 });
  assert.equal(outbox.pendingCount(), 1);
  assert.match(outbox.lastError(), /网络断了/);
  assert.equal(outbox.items()[0].text, '坏消息', '失败的条目留在队首');

  const reloaded = createOutbox({ file, send: async () => {}, log: silentLog });
  assert.equal(reloaded.pendingCount(), 1, '失败条目已落盘，重启后可重试');
  assert.deepEqual(await reloaded.flush(), { sent: 1, failed: 0, remaining: 0 });
  assert.equal(reloaded.lastError(), null, '成功后清空 lastError');
}

// ---------------- 发送重试队列：损坏行跳过并重写 ----------------
{
  const file = path.join(tempRoot, 'outbox-corrupt.jsonl');
  const good = JSON.stringify({ target: TARGET, text: '好的' });
  fs.writeFileSync(file, `${good}\n这不是 JSON\n{"target":{}}\n${good}\n`, { mode: 0o600 });
  const outbox = createOutbox({ file, send: async () => {}, log: silentLog });
  assert.equal(outbox.pendingCount(), 1, '坏行与重复行被跳过');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, '加载时立即重写成干净内容');
  assert.deepEqual(JSON.parse(lines[0]), { target: TARGET, text: '好的' });
  assert.deepEqual(await outbox.flush(), { sent: 1, failed: 0, remaining: 0 });
  assert.equal(fs.readFileSync(file, 'utf8'), '');
}

// ---------------- 发送重试队列：max 上限与最老优先 ----------------
{
  const file = path.join(tempRoot, 'outbox-limit.jsonl');
  const calls = [];
  const outbox = createOutbox({ file, send: async (item) => calls.push(item.text), log: silentLog });
  for (let index = 0; index < 3; index += 1) outbox.enqueue({ target: TARGET, text: `第${index}条` });

  const first = await outbox.flush(2);
  assert.deepEqual(first, { sent: 2, failed: 0, remaining: 1 });
  assert.deepEqual(calls, ['第0条', '第1条'], '最老优先');
  assert.deepEqual(await outbox.flush(), { sent: 1, failed: 0, remaining: 0 });
  assert.deepEqual(calls, ['第0条', '第1条', '第2条']);
}

// ---------------- 发送重试队列：并发 flush 互斥 ----------------
{
  const file = path.join(tempRoot, 'outbox-concurrent.jsonl');
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  const outbox = createOutbox({
    file,
    send: async (item) => {
      calls.push(item.text);
      await gate;
    },
    log: silentLog,
  });
  outbox.enqueue({ target: TARGET, text: '慢消息' });

  const firstFlush = outbox.flush(5);
  const second = await outbox.flush(5);
  assert.equal(second.busy, true, '并发 flush 被 in-flight 标记挡住');
  assert.equal(second.sent, 0);
  release();
  assert.deepEqual(await firstFlush, { sent: 1, failed: 0, remaining: 0 });
  assert.deepEqual(calls, ['慢消息'], '同一条只发一次');
}

// ---------------- 发送重试队列：构造参数校验 ----------------
{
  assert.throws(() => createOutbox({ send: async () => {} }), /file/);
  assert.throws(() => createOutbox({ file: path.join(tempRoot, 'x.jsonl') }), /send/);
}

console.log('REPLY OK');
