// 飞书入站媒体模块自测：用假 client 验证下载/落盘/命名/上限/容错。
// 运行：node test/media.mjs   —— 通过时打印 MEDIA OK 并退出 0。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { downloadInboundMedia } from '../lib/inbound-media.js';

const MAX_BYTES = 30 * 1024 * 1024;

// ---------------------------------------------------------------- 测试工具

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake-png-body'),
]);

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake-jpeg-body')]);

function makeLog() {
  const warns = [];
  return {
    warns,
    info() {},
    debug() {},
    warn(...args) {
      warns.push(args.join(' '));
    },
  };
}

function streamClient(buffer, calls = []) {
  return {
    im: {
      messageResource: {
        get: async (payload) => {
          calls.push(payload);
          return { getReadableStream: () => Readable.from([buffer]), headers: {} };
        },
      },
    },
  };
}

function writeFileClient(buffer, calls = []) {
  return {
    im: {
      messageResource: {
        get: async (payload) => {
          calls.push(payload);
          return {
            writeFile: async (filePath) => {
              fs.writeFileSync(filePath, buffer);
              return filePath;
            },
            headers: {},
          };
        },
      },
    },
  };
}

function readBodyClient(buffer, calls = []) {
  return {
    im: {
      messageResource: {
        get: async (payload) => {
          calls.push(payload);
          return { readBody: async () => Buffer.from(buffer), headers: {} };
        },
      },
    },
  };
}

function messageOf(type, content) {
  return {
    message_id: 'om_test_0001',
    message_type: type,
    content: typeof content === 'string' ? content : JSON.stringify(content),
  };
}

function assertFileMode(filePath) {
  const mode = fs.statSync(filePath).mode & 0o777;
  assert.equal(mode, 0o600, `落盘权限应为 0600，实际 ${mode.toString(8)}`);
}

function assertInside(dir, filePath) {
  const rel = path.relative(dir, path.resolve(filePath));
  assert.ok(rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel), `${filePath} 应位于 ${dir} 内`);
}

let checks = 0;
function ok(label) {
  checks += 1;
  console.log(`ok ${checks} - ${label}`);
}

// ---------------------------------------------------------------- 用例

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-inbound-media-'));

try {
  // 1) 图片：流式下载 + PNG 魔数 + 目录自动创建
  {
    const dir = path.join(root, 'auto', 'created', 'inbound');
    assert.equal(fs.existsSync(dir), false, '测试目录起初不应存在');
    const calls = [];
    const log = makeLog();
    const media = await downloadInboundMedia({
      client: streamClient(PNG, calls),
      message: messageOf('image', { image_key: 'img_v3_abc' }),
      dir,
      log,
    });

    assert.ok(media, '图片应下载成功');
    assert.equal(media.kind, 'image');
    assert.equal(media.size, PNG.length);
    assert.equal(media.mime, 'image/png');
    assert.equal(path.extname(media.path), '.png');
    assert.ok(path.isAbsolute(media.path), 'path 应是绝对路径');
    assert.equal(media.name, path.basename(media.path));
    assert.match(path.basename(media.path), /^\d{13}-[0-9a-f]+-image\.png$/, '文件名应带时间戳前缀');
    assert.equal(fs.existsSync(media.path), true, '图片应已落盘');
    assert.equal(fs.readFileSync(media.path).equals(PNG), true, '落盘内容应与下载内容一致');
    assertFileMode(media.path);
    assertInside(dir, media.path);
    assert.equal(fs.existsSync(dir), true, '目录应自动创建');
    assert.deepEqual(calls[0], {
      path: { message_id: 'om_test_0001', file_key: 'img_v3_abc' },
      params: { type: 'image' },
    });
    ok('image：流式下载、PNG 嗅探、目录自动创建、0600 落盘');
  }

  // 2) 图片：JPEG 魔数嗅探为 .jpg
  {
    const dir = path.join(root, 'jpeg');
    const media = await downloadInboundMedia({
      client: streamClient(JPEG),
      message: messageOf('image', '{"image_key":"img_v3_jpg"}'),
      dir,
      log: makeLog(),
    });
    assert.ok(media);
    assert.equal(path.extname(media.path), '.jpg');
    assert.equal(media.mime, 'image/jpeg');
    ok('image：JPEG 魔数嗅探为 .jpg');
  }

  // 3) 文件：writeFile 兜底 + 原始文件名消毒（路径穿越/控制字符）+ 保留扩展名
  {
    const dir = path.join(root, 'file-writefile');
    const calls = [];
    const media = await downloadInboundMedia({
      client: writeFileClient(Buffer.from('hello pdf bytes'), calls),
      message: messageOf('file', {
        file_key: 'file_v3_abc',
        file_name: '../../evil/报告\u0000 v1.pdf',
      }),
      dir,
      log: makeLog(),
    });
    assert.ok(media, '文件应下载成功');
    assert.equal(media.kind, 'file');
    assert.equal(media.name, '报告 v1.pdf', 'name 应是消毒后保留扩展名的原文件名');
    assert.equal(media.size, 'hello pdf bytes'.length);
    assert.equal(media.mime, 'application/pdf');
    assert.ok(path.basename(media.path).endsWith('-报告 v1.pdf'), '落盘文件名应保留原文件名');
    assert.match(path.basename(media.path), /^\d{13}-/);
    assert.equal(fs.readFileSync(media.path, 'utf8'), 'hello pdf bytes');
    assertFileMode(media.path);
    assertInside(dir, media.path);
    assert.deepEqual(calls[0].params, { type: 'file' });
    ok('file：writeFile 兜底、文件名消毒、保留 .pdf、0600 落盘');
  }

  // 4) 文件：readBody 兜底 + 无扩展名补 .bin
  {
    const dir = path.join(root, 'file-readbody');
    const media = await downloadInboundMedia({
      client: readBodyClient(Buffer.from('plain text')),
      message: messageOf('file', { file_key: 'file_v3_txt', file_name: 'README' }),
      dir,
      log: makeLog(),
    });
    assert.ok(media);
    assert.equal(media.name, 'README.bin');
    assert.equal(path.extname(media.path), '.bin');
    assert.equal(fs.readFileSync(media.path, 'utf8'), 'plain text');
    ok('file：readBody 兜底、无扩展名补 .bin');
  }

  // 5) 不支持的消息类型：直接 null，且不调用飞书接口
  {
    const dir = path.join(root, 'unsupported');
    const media = await downloadInboundMedia({
      client: {
        im: {
          messageResource: {
            get: async () => {
              throw new Error('不应该被调用');
            },
          },
        },
      },
      message: messageOf('text', '{"text":"hi"}'),
      dir,
      log: makeLog(),
    });
    assert.equal(media, null);
    assert.equal(fs.existsSync(dir), false, '不支持的类型不应创建目录');
    ok('不支持的类型返回 null（不调用接口）');
  }

  // 6) 超过 30MB：返回 null、目录内无文件、有 warn
  {
    const dir = path.join(root, 'oversize');
    const log = makeLog();
    const huge = Buffer.alloc(MAX_BYTES + 1, 0x41);
    const media = await downloadInboundMedia({
      client: streamClient(huge),
      message: messageOf('image', { image_key: 'img_v3_big' }),
      dir,
      log,
    });
    assert.equal(media, null);
    assert.deepEqual(fs.readdirSync(dir), [], '超限时不应留下文件');
    assert.ok(log.warns.some((line) => /超过上限/.test(line)), `warn 应提示超过上限：${log.warns.join(' | ')}`);
    ok('超过 30MB 返回 null、无残留文件、有 warn');
  }

  // 7) Content-Length 已超限：不读流直接拒绝
  {
    const dir = path.join(root, 'oversize-header');
    const log = makeLog();
    let streamOpened = false;
    const media = await downloadInboundMedia({
      client: {
        im: {
          messageResource: {
            get: async () => ({
              headers: { 'content-length': String(MAX_BYTES + 5) },
              getReadableStream: () => {
                streamOpened = true;
                return Readable.from([PNG]);
              },
            }),
          },
        },
      },
      message: messageOf('image', { image_key: 'img_v3_hdr' }),
      dir,
      log,
    });
    assert.equal(media, null);
    assert.equal(streamOpened, false, 'Content-Length 超限时不应打开流');
    assert.ok(log.warns.some((line) => /超过上限/.test(line)));
    ok('Content-Length 超限直接返回 null（不读流）');
  }

  // 8) 下载抛错：捕获后返回 null，不向调用方抛异常
  {
    const dir = path.join(root, 'error');
    const log = makeLog();
    const media = await downloadInboundMedia({
      client: {
        im: {
          messageResource: {
            get: async () => {
              throw new Error('mock boom');
            },
          },
        },
      },
      message: messageOf('file', { file_key: 'file_v3_err', file_name: 'a.txt' }),
      dir,
      log,
    });
    assert.equal(media, null);
    assert.ok(log.warns.some((line) => line.includes('mock boom')), 'warn 应包含底层错误信息');
    ok('下载抛错时返回 null 并 warn，不抛给调用方');
  }

  // 9) 缺 file_key / content 非法：返回 null
  {
    const dir = path.join(root, 'bad-content');
    const client = {
      im: {
        messageResource: {
          get: async () => {
            throw new Error('不应该被调用');
          },
        },
      },
    };
    const missingKey = await downloadInboundMedia({
      client,
      message: messageOf('file', {}),
      dir,
      log: makeLog(),
    });
    assert.equal(missingKey, null);
    const badJson = await downloadInboundMedia({
      client,
      message: messageOf('image', 'not-json'),
      dir,
      log: makeLog(),
    });
    assert.equal(badJson, null);
    const missingId = await downloadInboundMedia({
      client,
      message: { message_type: 'image', content: '{"image_key":"img_v3_x"}' },
      dir,
      log: makeLog(),
    });
    assert.equal(missingId, null);
    ok('缺 file_key / content 非法 / 缺 message_id 均返回 null');
  }

  // 10) client 不可用、参数为空：返回 null 且不抛
  {
    const dir = path.join(root, 'no-client');
    assert.equal(
      await downloadInboundMedia({ client: null, message: messageOf('image', { image_key: 'img_v3_x' }), dir, log: makeLog() }),
      null,
    );
    assert.equal(await downloadInboundMedia(), null);
    ok('client 缺失 / 空参数返回 null，不抛异常');
  }

  console.log('MEDIA OK');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
