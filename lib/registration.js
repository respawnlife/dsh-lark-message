// 扫码绑定流程：调用官方 SDK 的 registerApp（OAuth 2.0 Device Authorization Grant）。
// 用户用飞书扫码确认后，SDK 返回 App ID / App Secret / 扫码者 open_id；
// 凭据直接写本地状态文件（0600），不经过 profile 配置、不经过浏览器持久化。
//
// 两种模式：
//   create —— 首次绑定：扫码创建新应用，预置发送/资源/接收消息权限；
//   update —— 补全权限：对已绑定的应用追加 im:message:readonly（下载用户发来的图片/文件必需），
//             用户扫码确认权限 diff 即可，不需要重新绑定。
import * as lark from '@larksuiteoapi/node-sdk';
import QRCode from 'qrcode';
import { writeCredentials } from './store.js';

const QR_WAIT_MS = 20_000;

/** 通知通道需要的租户权限。im:message:readonly 用于下载用户发来的图片/文件。 */
const TENANT_SCOPES = [
  'im:message:send_as_bot',
  'im:resource',
  'im:message:readonly',          // 下载用户发来的图片/文件
  'im:message.group_at_msg:readonly', // 群聊里 @机器人 的消息事件
  'im:chat:readonly',                 // 读取群名（会话自动命名）
  'contact:user.base:readonly',       // 读取私聊对方名字（会话自动命名，需通讯录权限）
  'im:chat.members:read',             // 群成员列表（读取私聊对方名字的备用通道）
];
const EVENT_ITEMS = ['im.message.receive_v1'];

function describeError(error) {
  const code = error?.code ?? '';
  const description = error?.description || error?.message || String(error);
  const map = {
    access_denied: '你在飞书里拒绝了授权，可以重新扫码',
    expired_token: '二维码已过期，请重新扫码',
    abort: '已取消',
  };
  return map[code] ? `${map[code]}（${code}）` : `授权失败：${description}`;
}

export class BindFlow {
  constructor({ onBound, onError, log = console } = {}) {
    this.onBound = onBound;
    this.onError = onError;
    this.log = log;
    this.state = 'idle';
    this.url = null;
    this.qr = null;
    this.expireIn = 0;
    this.error = null;
    this.controller = null;
    this.qrReady = null;
    this.resolveQr = null;
    this.mode = 'create';
  }

  snapshot() {
    return {
      state: this.state,
      mode: this.mode,
      ...(this.url ? { url: this.url } : {}),
      ...(this.qr ? { qr: this.qr } : {}),
      ...(this.expireIn ? { expireIn: this.expireIn } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  cancel() {
    try {
      this.controller?.abort();
    } catch {
      // 已经结束
    }
    this.controller = null;
    if (this.state === 'waiting') this.state = 'idle';
    this.url = null;
    this.qr = null;
    this.expireIn = 0;
  }

  reset() {
    this.cancel();
    if (this.state !== 'idle') this.state = 'idle';
    this.error = null;
  }

  /**
   * 开始扫码。
   * @param {{ mode?: 'create' | 'update', appId?: string, previous?: object, keepTarget?: object }} options
   */
  async start(options = {}) {
    const mode = options.mode === 'update' ? 'update' : 'create';
    if (mode === 'create') {
      if (this.state === 'bound') return this.snapshot();
      if (this.state === 'waiting') {
        if (this.qr) return this.snapshot();
        await this.qrReady;
        return this.snapshot();
      }
    } else {
      // 补全权限：即使已经绑定也要重新走一次扫码。
      this.reset();
    }

    this.mode = mode;
    this.state = 'waiting';
    this.error = null;
    this.url = null;
    this.qr = null;
    this.expireIn = 0;

    const controller = new AbortController();
    this.controller = controller;
    this.qrReady = new Promise((resolve) => {
      this.resolveQr = resolve;
    });

    void this.#run(controller, { ...options, mode });
    await Promise.race([
      this.qrReady,
      new Promise((resolve) => setTimeout(resolve, QR_WAIT_MS)),
    ]);
    if (!this.qr) {
      this.cancel();
      throw new Error('生成二维码超时，请检查本机网络后重试');
    }
    return this.snapshot();
  }

  async #run(controller, options) {
    const mode = options.mode === 'create' ? 'create' : 'update';
    const previous = options.previous ?? null;
    try {
      const result = await lark.registerApp({
        ...(mode === 'update'
          ? { appId: options.appId }
          : {
              createOnly: true,
              appPreset: {
                name: 'DSH 通知助手',
                desc: 'DeepSeek Harness 通知通道：把任务结果、提醒与告警推送到飞书。',
              },
            }),
        signal: controller.signal,
        addons: {
          preset: true,
          scopes: { tenant: TENANT_SCOPES },
          events: { items: { tenant: EVENT_ITEMS } },
        },
        onQRCodeReady: (info) => {
          if (controller.signal.aborted) return;
          this.url = info?.url ?? null;
          this.expireIn = Number(info?.expireIn) || 0;
          void QRCode.toDataURL(this.url, { margin: 1, width: 240, errorCorrectionLevel: 'M' })
            .then((dataUrl) => {
              if (controller.signal.aborted) return;
              this.qr = dataUrl;
              this.resolveQr?.();
            })
            .catch((error) => {
              this.log.warn?.('[lark-notify] 二维码生成失败', error);
              this.resolveQr?.();
            });
        },
        onStatusChange: (info) => {
          if (info?.status === 'domain_switched') this.log.info?.('[lark-notify] 已切换到 Lark 国际版认证域名');
        },
      });

      if (controller.signal.aborted) return;
      const openId = result?.user_info?.open_id;
      const appId = result?.client_id ?? options.appId ?? previous?.appId;
      const appSecret = result?.client_secret ?? previous?.appSecret;
      if (!appId || !appSecret) throw new Error('授权成功但没有拿到完整凭据（App ID / Secret）');
      const target = openId
        ? { type: 'open_id', id: openId }
        : (options.keepTarget ?? previous?.target ?? null);
      const now = new Date().toISOString();
      const creds = {
        appId,
        appSecret,
        tenantBrand: result?.user_info?.tenant_brand === 'lark'
          ? 'lark'
          : (previous?.tenantBrand ?? 'feishu'),
        target,
        boundAt: previous?.boundAt ?? now,
        boundVia: previous?.boundVia ?? (mode === 'create' ? 'qr' : 'manual'),
        ...(mode === 'update' ? { scopesRepairedAt: now } : {}),
        ...(mode === 'create' ? { scopesVersion: 2 } : (previous?.scopesVersion ? { scopesVersion: previous.scopesVersion } : {})),
      };
      writeCredentials(creds);
      this.state = 'bound';
      this.url = null;
      this.qr = null;
      this.expireIn = 0;
      this.onBound?.(creds);
      this.log.info?.(mode === 'update' ? '[lark-notify] 权限补全成功' : '[lark-notify] 扫码绑定成功', creds.appId);
    } catch (error) {
      if (controller.signal.aborted) {
        this.state = 'idle';
        return;
      }
      this.state = 'error';
      this.error = describeError(error);
      this.onError?.(this.error);
      this.log.warn?.('[lark-notify] 扫码授权失败', error);
    } finally {
      if (this.controller === controller) this.controller = null;
      this.resolveQr = null;
    }
  }
}
