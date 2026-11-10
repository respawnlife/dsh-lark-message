/**
 * dsh-lark-notify — browser half: the «设置 → 飞书通知» page.
 *
 * Plain hand-written JavaScript, no JSX and no build step on purpose: the host's
 * client module loader (`window.__ModuleLoader__`) hands `require` in and wants a
 * CommonJS-style factory, so React is pulled from the loader (`require("react")`)
 * and every element is written with `React.createElement`.
 *
 * The Host half is the sibling `index.js`; it owns the RPC channel
 * `/lark-notify` (see CONTRACT.md). `ctx.connection.rpc.call` resolves the raw
 * host envelope `{ ok: true, value } | { ok: false, error }` — it does not throw
 * on business errors and does not unwrap the value, so `rpc()` below checks
 * `res.ok` and only then reads `res.value`.
 *
 * The page is a `settings.section` contribution (id `lark-notify`, order 21).
 * The settings shell already supplies the scroll container and its padding; this
 * file renders cards only. Copy lives in the `zh`/`en` dictionaries registered
 * through `ctx.locale`, and every colour comes from a `--dsw-alias-*` theme
 * token so light/dark follows the app.
 */
window.__ModuleLoader__.load({
  id: "dsh-lark-notify",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    /** Locale namespace and RPC channel. */
    const NS = "lark-notify";
    const CHANNEL = "/lark-notify";
    /** The scan flow is polled while it waits for the user to confirm in Lark. */
    const BIND_POLL_MS = 2000;
    /** Status (badge + history) refresh interval while the page is open. */
    const STATUS_REFRESH_MS = 15000;
    /** How many history rows to render; `status.history` may carry more. */
    const HISTORY_LIMIT = 12;
    /** A two-step unbind confirmation resets itself after this delay. */
    const CONFIRM_UNBIND_MS = 4000;
    /** A transient success notice disappears after this delay. */
    const NOTICE_MS = 5000;

    // ------------------------------------------------------------------
    // Copy (zh is the fallback; en mirrors every key). Keys marked `${}` are
    // placeholders substituted by `t(key, params)`.
    // ------------------------------------------------------------------
    const zh = {
      section: "飞书通知",
      intro: "扫码把飞书机器人绑定到这台电脑，之后的 DSH 通知和本地脚本消息都会推送到飞书。",
      status: "状态",
      bound: "已绑定",
      unbound: "未绑定",
      bind: "扫码绑定机器人",
      rebind: "重新绑定",
      rebinding: "重新绑定中…",
      unbind: "解除绑定",
      unbinding: "解除中…",
      confirmUnbind: "确认解除",
      unbindHint: "解除绑定只删除本机保存的凭据，飞书里的应用和机器人不受影响。",
      unbindConfirmHint: "再点一次「确认解除」，4 秒后自动取消。",
      scanHint: "用飞书扫码，确认后自动创建并绑定机器人",
      waiting: "等待扫码确认…",
      waitingTitle: "等待扫码确认",
      binding: "正在生成二维码…",
      bindingHint: "首次生成可能需要十几秒，请稍候。",
      bindFailed: "绑定失败",
      qrAlt: "飞书绑定二维码",
      repairQrAlt: "飞书权限确认二维码",
      qrExpire: "二维码 {minutes} 分钟内有效",
      qrLinkHint: "扫不了码？用飞书打开这个链接：",
      cancel: "取消",
      retry: "重试",
      testSend: "发送测试消息",
      sending: "发送中…",
      testSent: "已发送测试消息（{time}）",
      actions: "操作",
      actionsHint: "绑定后可以随时发一条测试消息，确认整条链路是通的。",
      history: "最近发送",
      emptyHistory: "还没有发送记录",
      repair: "补全权限（图片/文件）",
      repairHint: "用飞书扫码并在确认页同意新增的图片/文件权限；机器人继续用现在这个应用。",
      repairFailed: "补全权限失败",
      repairDone: "权限已补全，可以给机器人发图片/文件了",
      scopesRepaired: "媒体权限已补全 · {time}",
      inbound: "消息接收",
      inboundHint: "在飞书里直接给机器人发消息，会在工作区「飞书」里创建/复用会话，回复自动发回飞书。",
      inboundBoundHint: "绑定机器人后即可接收飞书消息。",
      inboundConnected: "已连接",
      inboundDisconnected: "未连接",
      inboundDisabled: "未启用",
      workspace: "工作区",
      sessionId: "会话 ID",
      lastInbound: "最近收到",
      inboundErrorDetail: "入站错误：{message}",
      noInboundYet: "还没有收到消息",
      agoJustNow: "刚刚",
      agoSeconds: "{count} 秒前",
      agoMinutes: "{count} 分钟前",
      agoHours: "{count} 小时前",
      agoDays: "{count} 天前",
      scriptTitle: "脚本推送接口",
      endpoint: "接口地址",
      tokenPath: "凭据文件",
      httpHint: "本地脚本用这个凭据调用 HTTP 推送接口；请求要带 Authorization: Bearer <token>。",
      copy: "复制",
      copied: "已复制",
      copyFailed: "复制失败，请手动选中文本复制",
      manual: "手动填写 App ID / App Secret",
      collapse: "收起",
      expand: "展开",
      appId: "App ID",
      appSecret: "App Secret",
      appIdHint: "飞书开放平台应用的 App ID",
      appSecretHint: "只保存在本机，保存后不再回显",
      target: "发送目标",
      targetType: "目标类型",
      targetId: "目标 ID",
      targetIdHint: "留空则沿用扫码得到的 open_id",
      targetMissing: "还没设置",
      openId: "用户 open_id",
      chatId: "群 chat_id",
      lastError: "最近错误",
      loadFailedDetail: "读取状态失败：{message}",
      loading: "读取状态…",
      refresh: "刷新",
      refreshing: "刷新中…",
      ok: "成功",
      failed: "失败",
      save: "保存",
      saving: "保存中…",
      manualRequired: "请填写 App ID 和 App Secret",
      manualSaved: "已保存应用凭据",
      manualHint: "已经有飞书开放平台应用时，可以直接填凭据，不走扫码。",
      boundAt: "绑定时间",
      brandFeishu: "飞书",
      brandLark: "Lark",
      boundNotice: "机器人已绑定",
      unboundNotice: "已解除绑定",
      kindText: "文本",
      kindImage: "图片",
      dismiss: "关闭",
      unknownError: "未知错误",
    };

    const en = {
      section: "Lark Notify",
      intro: "Scan to link a Lark bot to this computer; DSH notifications and local script messages will then be delivered to Lark.",
      status: "Status",
      bound: "Connected",
      unbound: "Not connected",
      bind: "Link a bot",
      rebind: "Re-link",
      rebinding: "Re-linking…",
      unbind: "Disconnect",
      unbinding: "Disconnecting…",
      confirmUnbind: "Confirm disconnect",
      unbindHint: "Disconnecting only removes credentials stored on this computer; the Lark app and bot stay as they are.",
      unbindConfirmHint: "Click “Confirm disconnect” once more; it cancels after 4 seconds.",
      scanHint: "Scan with Lark to create and link a bot",
      waiting: "Waiting for confirmation…",
      waitingTitle: "Waiting for confirmation",
      binding: "Creating the QR code…",
      bindingHint: "The first QR code can take a few seconds to appear.",
      bindFailed: "Linking failed",
      qrAlt: "Lark link QR code",
      repairQrAlt: "Lark permission confirmation QR code",
      qrExpire: "The QR code is valid for {minutes} minutes",
      qrLinkHint: "Can’t scan? Open this link in Lark:",
      cancel: "Cancel",
      retry: "Retry",
      testSend: "Send test message",
      sending: "Sending…",
      testSent: "Test message sent ({time})",
      actions: "Actions",
      actionsHint: "After linking, send a test message at any time to confirm the whole path works.",
      history: "Recent sends",
      emptyHistory: "No messages yet",
      repair: "Grant media permissions",
      repairHint: "Scan with Lark and approve the added image/file permissions; the bot keeps using the current app.",
      repairFailed: "Could not grant media permissions",
      repairDone: "Media permissions granted; you can now send images and files to the bot",
      scopesRepaired: "Media permissions granted · {time}",
      inbound: "Message inbox",
      inboundHint: "Message the bot directly in Lark; a session is created or reused in the “Feishu” workspace and replies are sent back automatically.",
      inboundBoundHint: "Link a bot to start receiving Lark messages.",
      inboundConnected: "Connected",
      inboundDisconnected: "Not connected",
      inboundDisabled: "Disabled",
      workspace: "Workspace",
      sessionId: "Session ID",
      lastInbound: "Last received",
      inboundErrorDetail: "Inbound error: {message}",
      noInboundYet: "No messages received yet",
      agoJustNow: "just now",
      agoSeconds: "{count}s ago",
      agoMinutes: "{count} min ago",
      agoHours: "{count} h ago",
      agoDays: "{count} d ago",
      scriptTitle: "Script endpoint",
      endpoint: "Endpoint",
      tokenPath: "Token file",
      httpHint: "Local scripts call the HTTP endpoint with this token and an Authorization: Bearer header.",
      copy: "Copy",
      copied: "Copied",
      copyFailed: "Copy failed; select the text and copy it manually",
      manual: "Enter App ID / Secret manually",
      collapse: "Hide",
      expand: "Show",
      appId: "App ID",
      appSecret: "App Secret",
      appIdHint: "App ID from the Lark developer console",
      appSecretHint: "Stored locally and never shown again",
      target: "Target",
      targetType: "Target type",
      targetId: "Target ID",
      targetIdHint: "Leave blank to reuse the open_id from scanning",
      targetMissing: "Not set",
      openId: "User open_id",
      chatId: "Group chat_id",
      lastError: "Last error",
      loadFailedDetail: "Could not read status: {message}",
      loading: "Reading status…",
      refresh: "Refresh",
      refreshing: "Refreshing…",
      ok: "Sent",
      failed: "Failed",
      save: "Save",
      saving: "Saving…",
      manualRequired: "Enter both App ID and App Secret",
      manualSaved: "App credentials saved",
      manualHint: "If a Lark developer-console app already exists, enter its credentials instead of scanning.",
      boundAt: "Linked at",
      brandFeishu: "Feishu",
      brandLark: "Lark",
      boundNotice: "Bot linked",
      unboundNotice: "Disconnected",
      kindText: "Text",
      kindImage: "Image",
      dismiss: "Dismiss",
      unknownError: "Unknown error",
    };

    // ------------------------------------------------------------------
    // Class names (one `S` map keeps the CSS and the render tree in sync).
    // ------------------------------------------------------------------
    const cls = (name) => `larkn-${name}`;
    const S = {
      page: cls("page"),
      head: cls("head"),
      title: cls("title"),
      intro: cls("intro"),
      card: cls("card"),
      cardHead: cls("card-head"),
      dot: cls("dot"),
      dotOn: cls("dot-on"),
      cardTitle: cls("card-title"),
      badgeRow: cls("badge-row"),
      badge: cls("badge"),
      badgeOn: cls("badge-on"),
      badgeBad: cls("badge-bad"),
      rows: cls("rows"),
      row: cls("row"),
      rowLabel: cls("row-label"),
      rowValue: cls("row-value"),
      muted: cls("muted"),
      hint: cls("hint"),
      error: cls("error"),
      errorText: cls("error-text"),
      errorPlain: cls("error-plain"),
      notice: cls("notice"),
      bannerClose: cls("banner-close"),
      warn: cls("warn"),
      warnLabel: cls("warn-label"),
      warnText: cls("warn-text"),
      actions: cls("actions"),
      btn: cls("btn"),
      btnPrimary: cls("btn-primary"),
      btnDanger: cls("btn-danger"),
      cta: cls("cta"),
      qrRow: cls("qr-row"),
      qr: cls("qr"),
      qrSide: cls("qr-side"),
      link: cls("link"),
      waitingText: cls("waiting-text"),
      form: cls("form"),
      formRow: cls("form-row"),
      field: cls("field"),
      fieldLabel: cls("field-label"),
      input: cls("input"),
      codeRow: cls("code-row"),
      code: cls("code"),
      history: cls("history"),
      historyItem: cls("history-item"),
      historyTime: cls("history-time"),
      historyPreview: cls("history-preview"),
      historyError: cls("history-error"),
      stack: cls("stack"),
      inlineError: cls("inline-error"),
    };

    const CSS = `
.${S.page} { display: flex; flex-direction: column; gap: 12px; width: 100%;
  max-width: 720px; color: var(--dsw-alias-label-primary); }
.${S.head} { display: flex; flex-direction: column; gap: 4px; margin: 2px 0 4px; }
.${S.title} { margin: 0; color: var(--dsw-alias-label-primary); font-size: 16px;
  font-weight: 500; line-height: 24px; }
.${S.intro} { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 14px;
  line-height: 22px; }
.${S.card} { display: flex; flex-direction: column; gap: 12px; padding: 14px 16px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px;
  background: var(--dsw-alias-bg-layer-3); }
.${S.cardHead} { display: flex; align-items: center; gap: 8px; min-width: 0; }
.${S.dot} { flex: none; width: 8px; height: 8px; border-radius: 50%;
  background: var(--dsw-alias-label-tertiary); }
.${S.dotOn} { background: var(--dsw-alias-state-success-primary); }
.${S.cardTitle} { flex: 1; min-width: 0; margin: 0; color: var(--dsw-alias-label-primary);
  font-size: 14px; font-weight: 600; line-height: 20px; }
.${S.badgeRow} { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.${S.badge} { white-space: nowrap; padding: 1px 8px; border-radius: 999px;
  background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary);
  font-size: 11px; font-weight: 500; line-height: 17px; }
.${S.badgeOn} { color: var(--dsw-alias-state-success-primary); }
.${S.badgeBad} { color: var(--dsw-alias-state-error-primary); }
.${S.rows} { display: flex; flex-direction: column; }
.${S.row} { display: flex; align-items: baseline; gap: 12px; padding: 8px 0;
  border-top: 1px solid var(--dsw-alias-border-l2); }
.${S.row}:first-child { padding-top: 0; border-top: none; }
.${S.rowLabel} { flex: none; width: 88px; color: var(--dsw-alias-label-tertiary);
  font-size: 12px; line-height: 18px; }
.${S.rowValue} { flex: 1; min-width: 0; color: var(--dsw-alias-label-primary);
  font-size: 13px; line-height: 18px; word-break: break-all; }
.${S.muted} { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px;
  line-height: 1.5; }
.${S.hint} { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px;
  line-height: 1.5; }
.${S.error} { display: flex; align-items: flex-start; gap: 8px; margin: 0;
  padding: 8px 12px; border: 1px solid var(--dsw-alias-state-error-primary);
  border-radius: 8px; color: var(--dsw-alias-state-error-primary);
  font-size: 13px; line-height: 1.5; word-break: break-word; }
.${S.errorText} { flex: 1; min-width: 0; }
.${S.errorPlain} { margin: 0; color: var(--dsw-alias-state-error-primary);
  font-size: 12px; line-height: 1.5; word-break: break-word; }
.${S.notice} { margin: 0; padding: 8px 12px;
  border: 1px solid var(--dsw-alias-state-success-primary); border-radius: 8px;
  color: var(--dsw-alias-state-success-primary); font-size: 13px; line-height: 1.5; }
.${S.bannerClose} { appearance: none; flex: none; padding: 0 2px; border: 0;
  background: 0 0; color: inherit; cursor: pointer; font: inherit; font-size: 14px;
  line-height: 1.4; opacity: .7; }
.${S.bannerClose}:hover { opacity: 1; }
.${S.warn} { display: flex; flex-direction: column; gap: 2px; padding-top: 10px;
  border-top: 1px solid var(--dsw-alias-border-l2); }
.${S.warnLabel} { color: var(--dsw-alias-state-warn-label, var(--dsw-alias-label-secondary));
  font-size: 12px; font-weight: 500; line-height: 18px; }
.${S.warnText} { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px;
  line-height: 1.5; word-break: break-word; }
.${S.actions} { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.${S.btn} { appearance: none; flex: none; padding: 5px 14px; border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px; background: 0 0; color: var(--dsw-alias-label-secondary);
  cursor: pointer; font: inherit; font-size: 13px; line-height: 1.5; }
.${S.btn}:hover:not(:disabled) { color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-label-dimmed); }
.${S.btn}:disabled { opacity: .45; cursor: default; }
.${S.btnPrimary} { border-color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-primary-foreground, #fff); font-weight: 500; }
.${S.btnPrimary}:hover:not(:disabled) { color: var(--dsw-alias-label-primary-foreground, #fff);
  opacity: .92; }
.${S.btnDanger} { color: var(--dsw-alias-state-error-primary); }
.${S.btnDanger}:hover:not(:disabled) { color: var(--dsw-alias-state-error-primary);
  border-color: var(--dsw-alias-state-error-primary); }
.${S.cta} { appearance: none; display: inline-flex; align-self: flex-start;
  align-items: center; justify-content: center; height: 40px; padding: 0 20px;
  border: 1px solid var(--dsw-alias-brand-primary); border-radius: 10px;
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-primary-foreground, #fff); cursor: pointer;
  font: inherit; font-size: 14px; font-weight: 500; }
.${S.cta}:hover:not(:disabled) { opacity: .92; }
.${S.cta}:disabled { opacity: .45; cursor: default; }
.${S.qrRow} { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 16px; }
.${S.qr} { flex: none; max-width: 100%; border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px; }
.${S.qrSide} { display: flex; flex: 1 1 200px; flex-direction: column; gap: 8px;
  min-width: 180px; }
.${S.link} { color: var(--dsw-alias-brand-primary); font-size: 12px;
  line-height: 1.5; word-break: break-all; }
.${S.waitingText} { margin: 0; color: var(--dsw-alias-label-primary); font-size: 13px;
  font-weight: 500; line-height: 1.5; }
.${S.form} { display: flex; flex-direction: column; gap: 12px; }
.${S.formRow} { display: flex; flex-wrap: wrap; gap: 12px; }
.${S.formRow} > .${S.field} { flex: 1 1 160px; min-width: 0; }
.${S.field} { display: flex; flex-direction: column; gap: 6px; }
.${S.fieldLabel} { color: var(--dsw-alias-label-primary); font-size: 13px;
  font-weight: 500; line-height: 1.5; }
.${S.input} { box-sizing: border-box; width: 100%; height: 34px; padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; line-height: 1.5; }
.${S.input}:focus-visible { border-color: var(--dsw-alias-brand-primary); outline: none; }
.${S.codeRow} { display: flex; align-items: flex-start; gap: 8px; }
.${S.code} { flex: 1; min-width: 0; margin: 0; padding: 7px 10px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
  line-height: 1.6; word-break: break-all; }
.${S.history} { display: flex; flex-direction: column; }
.${S.historyItem} { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px;
  padding: 8px 0; border-top: 1px solid var(--dsw-alias-border-l2); min-width: 0; }
.${S.historyItem}:first-child { padding-top: 0; border-top: none; }
.${S.historyTime} { flex: none; color: var(--dsw-alias-label-tertiary); font-size: 12px;
  line-height: 18px; font-variant-numeric: tabular-nums; }
.${S.historyPreview} { flex: 1; min-width: 0; overflow: hidden; color: var(--dsw-alias-label-primary);
  font-size: 13px; line-height: 18px; text-overflow: ellipsis; white-space: nowrap; }
.${S.historyError} { flex-basis: 100%; color: var(--dsw-alias-state-error-primary);
  font-size: 12px; line-height: 1.5; word-break: break-word; }
.${S.stack} { display: flex; flex-direction: column; gap: 10px; }
.${S.inlineError} { display: flex; flex-direction: column; gap: 8px; }
`;

    const STYLE_ID = "dsh-lark-notify/SettingsPage.css";

    /**
     * Put the page CSS into the document once and return the element.
     *
     * The caller owns the returned tag through a `ctx.effect` cleanup, so
     * unloading the plugin also removes its stylesheet. A tag left behind by an
     * HMR reload is reused instead of duplicated.
     */
    function ensureStyles() {
      if (typeof document === "undefined") return null;
      const existing = document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`);
      if (existing !== null) return existing;
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-lark-notify";
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return tag;
    }

    // ------------------------------------------------------------------
    // Small helpers.
    // ------------------------------------------------------------------

    function pad2(value) {
      return String(value).padStart(2, "0");
    }

    /** Local `MM-DD HH:mm:ss`, with the year only when it is not the current one. */
    function formatTime(iso) {
      if (typeof iso !== "string" || iso === "") return "—";
      const date = new Date(iso);
      if (!Number.isFinite(date.getTime())) return iso;
      const sameYear = date.getFullYear() === new Date().getFullYear();
      const year = sameYear ? "" : `${date.getFullYear()}-`;
      return `${year}${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} `
        + `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
    }

    /**
     * Coarse relative copy for "last received" times. The page re-renders on
     * every status refresh (15s) and on every poll, so this never goes stale for
     * long without its own timer.
     */
    function relativeTime(iso, t) {
      const then = Date.parse(iso);
      if (!Number.isFinite(then)) return "";
      const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
      if (secs < 10) return t("agoJustNow");
      if (secs < 60) return t("agoSeconds", { count: String(secs) });
      if (secs < 3600) return t("agoMinutes", { count: String(Math.round(secs / 60)) });
      if (secs < 86400) return t("agoHours", { count: String(Math.round(secs / 3600)) });
      return t("agoDays", { count: String(Math.round(secs / 86400)) });
    }

    /** The message to show for anything thrown by `rpc()` or a browser API. */
    function messageOf(error, fallback) {
      if (error === null || error === undefined) return fallback;
      if (typeof error === "string") return error === "" ? fallback : error;
      if (typeof error === "object" && error.generic === true) return fallback;
      if (typeof error.message === "string" && error.message !== "") return error.message;
      return fallback;
    }

    /**
     * Call one host endpoint and unwrap the envelope.
     *
     * `ctx.connection.rpc.call` only rejects on transport/protocol failures;
     * business errors arrive as `{ ok: false, error }`. Both are turned into a
     * thrown Error here so every caller can use a plain try/catch. `generic`
     * marks "server said no but gave no message", so the UI can supply its own
     * localized fallback instead of showing an English "RPC failed".
     */
    async function rpc(call, endpoint, payload) {
      const res = await call(endpoint, payload === undefined ? {} : payload);
      if (res === null || typeof res !== "object" || res.ok !== true) {
        const detail = res !== null && typeof res === "object" ? res.error : null;
        const text = detail !== null && typeof detail === "object"
          ? (detail.message || detail.code || "")
          : "";
        const error = new Error(typeof text === "string" && text !== "" ? text : "RPC failed");
        error.generic = !(typeof text === "string" && text !== "");
        throw error;
      }
      return res.value;
    }

    /** Clipboard fallback for browsers that gate `navigator.clipboard` behind focus. */
    function copyWithTextarea(text) {
      if (typeof document === "undefined" || document.body === null) return false;
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.top = "-1000px";
      area.style.opacity = "0";
      document.body.appendChild(area);
      let copied = false;
      try {
        area.select();
        copied = document.execCommand("copy");
      } catch {
        copied = false;
      } finally {
        document.body.removeChild(area);
      }
      return copied;
    }

    // ------------------------------------------------------------------
    // Presentational building blocks.
    // ------------------------------------------------------------------

    /** A bordered card with an optional status dot and a right-aligned control. */
    function Card(props) {
      return h(
        "section",
        { className: S.card },
        h(
          "div",
          { className: S.cardHead },
          typeof props.dot === "string"
            ? h("span", {
                className: `${S.dot} ${props.dot === "on" ? S.dotOn : ""}`,
                "aria-hidden": true,
              })
            : null,
          h("h3", { className: S.cardTitle }, props.title),
          props.extra === undefined || props.extra === null ? null : props.extra,
        ),
        props.children === undefined ? null : props.children,
      );
    }

    /** One label / value line inside a card. */
    function Row(props) {
      return h(
        "div",
        { className: S.row },
        h("span", { className: S.rowLabel }, props.label),
        h("span", { className: S.rowValue }, props.value),
      );
    }

    /** A read-only value line with a copy button. */
    function CopyField(props) {
      const { label, text, copyKey, copiedKey, onCopy, t } = props;
      return h(
        "div",
        { className: S.field },
        h("span", { className: S.fieldLabel }, label),
        h(
          "div",
          { className: S.codeRow },
          h("code", { className: S.code }, text === "" ? "—" : text),
          h(
            "button",
            {
              type: "button",
              className: S.btn,
              disabled: text === "",
              onClick: () => onCopy(copyKey, text),
            },
            copiedKey === copyKey ? t("copied") : t("copy"),
          ),
        ),
      );
    }

    // ------------------------------------------------------------------
    // The settings page.
    // ------------------------------------------------------------------

    function SettingsPage(props) {
      const call = props.call;
      const t = props.t;

      /** False once the page unmounts; guards every async state write. */
      const alive = useRef(true);

      const [status, setStatus] = useState(null);
      const [loading, setLoading] = useState(true);
      const [refreshing, setRefreshing] = useState(false);
      const [loadError, setLoadError] = useState(null);
      const [error, setError] = useState(null);
      const [notice, setNotice] = useState(null);

      /** Scan flow: idle → starting → waiting → (idle | error). */
      const [phase, setPhase] = useState("idle");
      /**
       * What the current scan flow is for: a fresh bind (bindStart) or adding the
       * image/file tenant scopes to an already-bound app (repairStart). Both share
       * the same waiting/poll/cancel machinery, so only the copy differs.
       */
      const [flowMode, setFlowMode] = useState("bind");
      const [bind, setBind] = useState(null);
      const [bindError, setBindError] = useState(null);

      const [testing, setTesting] = useState(false);
      const [confirmUnbind, setConfirmUnbind] = useState(false);
      const [unbinding, setUnbinding] = useState(false);
      const [rebinding, setRebinding] = useState(false);

      const [manualOpen, setManualOpen] = useState(false);
      const [appId, setAppId] = useState("");
      const [appSecret, setAppSecret] = useState("");
      const [targetType, setTargetType] = useState("open_id");
      const [targetId, setTargetId] = useState("");
      const [saving, setSaving] = useState(false);

      const [copiedKey, setCopiedKey] = useState(null);

      useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);

      /** Read `status`; returns true on success and swallows the failure into `loadError`. */
      const fetchStatus = useCallback(async () => {
        try {
          const value = await rpc(call, "status", {});
          if (!alive.current) return false;
          setStatus(value !== null && typeof value === "object" ? value : {});
          setLoadError(null);
          return true;
        } catch (err) {
          if (alive.current) setLoadError(messageOf(err, t("unknownError")));
          return false;
        }
      }, [call, t]);

      // Initial read, then a slow refresh so history/status stay live while the
      // page is open. The cleanup stops the timer when the settings panel closes.
      useEffect(() => {
        let live = true;
        const initial = async () => {
          try {
            await fetchStatus();
          } finally {
            if (live && alive.current) setLoading(false);
          }
        };
        initial();
        const timer = window.setInterval(() => {
          if (alive.current) fetchStatus();
        }, STATUS_REFRESH_MS);
        return () => {
          live = false;
          window.clearInterval(timer);
        };
      }, [fetchStatus]);

      // Success notices fade on their own; a failure banner stays until the next
      // action so the message can be read and copied.
      useEffect(() => {
        if (notice === null) return undefined;
        const timer = window.setTimeout(() => {
          if (alive.current) setNotice(null);
        }, NOTICE_MS);
        return () => window.clearTimeout(timer);
      }, [notice]);

      // The two-step unbind confirmation must not linger.
      useEffect(() => {
        if (!confirmUnbind) return undefined;
        const timer = window.setTimeout(() => {
          if (alive.current) setConfirmUnbind(false);
        }, CONFIRM_UNBIND_MS);
        return () => window.clearTimeout(timer);
      }, [confirmUnbind]);

      // Poll the scan flow every 2s while waiting. The recursive timer (rather
      // than setInterval) never stacks requests, and the cleanup runs on unmount
      // so closing the settings panel stops polling immediately.
      useEffect(() => {
        if (phase !== "waiting") return undefined;
        let live = true;
        let timer = null;
        let failures = 0;
        const tick = async () => {
          timer = null;
          let value;
          try {
            value = await rpc(call, "bindStatus", {});
            failures = 0;
          } catch (err) {
            if (!live || !alive.current) return;
            failures += 1;
            if (failures >= 3) {
              setPhase("error");
              setBindError(messageOf(err, t("unknownError")));
              return;
            }
            timer = window.setTimeout(tick, BIND_POLL_MS);
            return;
          }
          if (!live || !alive.current) return;
          const state = value !== null && typeof value === "object" ? value.state : undefined;
          if (state === "bound") {
            setPhase("idle");
            setBind(null);
            setBindError(null);
            setFlowMode("bind");
            setNotice(flowMode === "repair" ? t("repairDone") : t("boundNotice"));
            fetchStatus();
            return;
          }
          if (state === "error") {
            setPhase("error");
            setBindError(messageOf(value === null || value === undefined ? null : value.error, t("unknownError")));
            return;
          }
          if (state === "idle") {
            setPhase("idle");
            setBind(null);
            return;
          }
          // `waiting` (or a shape we do not know yet): keep the QR fresh and
          // keep polling.
          if (state === "waiting" && typeof value.qr === "string" && typeof value.url === "string") {
            const nextUrl = value.url;
            const nextQr = value.qr;
            const nextExpire = typeof value.expireIn === "number" ? value.expireIn : 0;
            setBind((current) => (current === null
              ? { url: nextUrl, qr: nextQr, expireIn: nextExpire }
              : { url: nextUrl, qr: nextQr, expireIn: current.expireIn || nextExpire }));
          }
          timer = window.setTimeout(tick, BIND_POLL_MS);
        };
        timer = window.setTimeout(tick, BIND_POLL_MS);
        return () => {
          live = false;
          if (timer !== null) window.clearTimeout(timer);
        };
      }, [phase, flowMode, call, t, fetchStatus]);

      /** Start (or resume) the scan flow and show its QR code. */
      const beginBind = useCallback(async () => {
        setError(null);
        setNotice(null);
        setBindError(null);
        setFlowMode("bind");
        setPhase("starting");
        try {
          const value = await rpc(call, "bindStart", {});
          if (!alive.current) return;
          // A host that is already bound answers with a "bound" snapshot and no QR.
          if (value !== null && typeof value === "object" && value.state === "bound") {
            setPhase("idle");
            setBind(null);
            setNotice(t("boundNotice"));
            fetchStatus();
            return;
          }
          if (value === null || typeof value !== "object"
            || typeof value.qr !== "string" || typeof value.url !== "string") {
            throw new Error(t("unknownError"));
          }
          setBind({
            url: value.url,
            qr: value.qr,
            expireIn: typeof value.expireIn === "number" ? value.expireIn : 0,
          });
          setPhase("waiting");
        } catch (err) {
          if (!alive.current) return;
          setPhase("error");
          setBindError(messageOf(err, t("unknownError")));
        }
      }, [call, t, fetchStatus]);

      /**
       * Ask the Host to reopen the OAuth confirmation for the already-bound app so
       * the tenant can grant the newer image/file scopes. Same QR/waiting/poll UI
       * as a normal bind; only the copy (and the notice on success) differs.
       */
      const beginRepair = useCallback(async () => {
        setConfirmUnbind(false);
        setError(null);
        setNotice(null);
        setBindError(null);
        setFlowMode("repair");
        setPhase("starting");
        try {
          const value = await rpc(call, "repairStart", {});
          if (!alive.current) return;
          // Already repaired on another surface: the Host answers with a bound snapshot.
          if (value !== null && typeof value === "object" && value.state === "bound") {
            setPhase("idle");
            setBind(null);
            setFlowMode("bind");
            setNotice(t("repairDone"));
            fetchStatus();
            return;
          }
          if (value === null || typeof value !== "object"
            || typeof value.qr !== "string" || typeof value.url !== "string") {
            throw new Error(t("unknownError"));
          }
          setBind({
            url: value.url,
            qr: value.qr,
            expireIn: typeof value.expireIn === "number" ? value.expireIn : 0,
          });
          setPhase("waiting");
        } catch (err) {
          if (!alive.current) return;
          setPhase("error");
          setBindError(messageOf(err, t("unknownError")));
        }
      }, [call, t, fetchStatus]);

      /** Best-effort cancel: the local UI stops waiting even if the host refuses. */
      const cancelBind = async () => {
        try {
          await rpc(call, "bindCancel", {});
        } catch {
          // The flow is dropped locally anyway; a stale host flow is idempotent.
        }
        if (!alive.current) return;
        setPhase("idle");
        setBind(null);
        setBindError(null);
        setFlowMode("bind");
      };

      /** Leave a failed QR card without asking the Host (it resets on the next start). */
      const dismissFlow = () => {
        setPhase("idle");
        setBind(null);
        setBindError(null);
        setFlowMode("bind");
      };

      const sendTest = async () => {
        setConfirmUnbind(false);
        setTesting(true);
        setError(null);
        setNotice(null);
        try {
          const value = await rpc(call, "testSend", {});
          if (!alive.current) return;
          const at = value !== null && typeof value === "object" && typeof value.at === "string"
            ? value.at
            : new Date().toISOString();
          setNotice(t("testSent", { time: formatTime(at) }));
          await fetchStatus();
        } catch (err) {
          if (alive.current) setError(messageOf(err, t("unknownError")));
        } finally {
          if (alive.current) setTesting(false);
        }
      };

      const rebind = async () => {
        setConfirmUnbind(false);
        setRebinding(true);
        setError(null);
        setNotice(null);
        try {
          await rpc(call, "unbind", {});
          if (!alive.current) return;
          setPhase("idle");
          setBind(null);
          setBindError(null);
          await fetchStatus();
          if (!alive.current) return;
          await beginBind();
        } catch (err) {
          if (!alive.current) return;
          setPhase("idle");
          setError(messageOf(err, t("unknownError")));
        } finally {
          if (alive.current) setRebinding(false);
        }
      };

      const doUnbind = async () => {
        if (!confirmUnbind) {
          setConfirmUnbind(true);
          setError(null);
          setNotice(null);
          return;
        }
        setUnbinding(true);
        setError(null);
        setNotice(null);
        try {
          await rpc(call, "unbind", {});
          if (!alive.current) return;
          setConfirmUnbind(false);
          setPhase("idle");
          setBind(null);
          setBindError(null);
          setNotice(t("unboundNotice"));
          await fetchStatus();
        } catch (err) {
          if (alive.current) setError(messageOf(err, t("unknownError")));
        } finally {
          if (alive.current) setUnbinding(false);
        }
      };

      const retryLoad = () => {
        setLoading(true);
        setLoadError(null);
        fetchStatus().finally(() => {
          if (alive.current) setLoading(false);
        });
      };

      const refresh = async () => {
        if (refreshing) return;
        setRefreshing(true);
        try {
          await fetchStatus();
        } finally {
          if (alive.current) setRefreshing(false);
        }
      };

      const submitManual = async (event) => {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        const id = appId.trim();
        const secret = appSecret.trim();
        if (id === "" || secret === "") {
          setError(t("manualRequired"));
          return;
        }
        const extraTargetId = targetId.trim();
        setSaving(true);
        setError(null);
        setNotice(null);
        try {
          const payload = { appId: id, appSecret: secret };
          if (extraTargetId !== "") {
            payload.targetType = targetType;
            payload.targetId = extraTargetId;
          }
          await rpc(call, "manualBind", payload);
          if (!alive.current) return;
          setAppSecret("");
          setNotice(t("manualSaved"));
          await fetchStatus();
        } catch (err) {
          if (alive.current) setError(messageOf(err, t("unknownError")));
        } finally {
          if (alive.current) setSaving(false);
        }
      };

      const copyText = async (key, text) => {
        if (typeof text !== "string" || text === "") return;
        let copied = false;
        try {
          if (typeof navigator !== "undefined" && navigator.clipboard
            && typeof navigator.clipboard.writeText === "function") {
            await navigator.clipboard.writeText(text);
            copied = true;
          }
        } catch {
          copied = false;
        }
        if (!copied) copied = copyWithTextarea(text);
        if (!alive.current) return;
        if (!copied) {
          setError(t("copyFailed"));
          return;
        }
        setCopiedKey(key);
        window.setTimeout(() => {
          if (alive.current) setCopiedKey((current) => (current === key ? null : current));
        }, 2000);
      };

      // ------------------------------------------------------------------
      // Derived view state.
      // ------------------------------------------------------------------
      const bound = status !== null && status.bound === true;
      const history = status !== null && Array.isArray(status.history)
        ? status.history.slice(0, HISTORY_LIMIT)
        : [];
      const appIdMasked = status !== null && typeof status.appId === "string" ? status.appId : "";
      const boundAt = status !== null && typeof status.boundAt === "string" ? status.boundAt : "";
      const lastError = status !== null && typeof status.lastError === "string" ? status.lastError : "";
      const targetInfo = status !== null && status.target !== null && typeof status.target === "object"
        ? status.target
        : null;
      const targetLabel = targetInfo !== null ? `${targetInfo.type} · ${targetInfo.id}` : t("targetMissing");
      const brand = status !== null && status.tenantBrand === "lark"
        ? t("brandLark")
        : status !== null && status.tenantBrand === "feishu"
          ? t("brandFeishu")
          : "";
      const httpEndpoint = status !== null && typeof status.httpEndpoint === "string" ? status.httpEndpoint : "";
      const httpTokenPath = status !== null && typeof status.httpTokenPath === "string" ? status.httpTokenPath : "";
      const scopesRepairedAt = status !== null && typeof status.scopesRepairedAt === "string"
        ? status.scopesRepairedAt
        : "";
      // Inbound (Lark → DSH) status. Older hosts without the field simply get no
      // card; every field is read defensively because the Host is the owner.
      const inboundInfo = status !== null && status.inbound !== null && typeof status.inbound === "object"
        ? status.inbound
        : null;
      const inboundConnected = inboundInfo !== null && inboundInfo.connected === true;
      const inboundEnabled = inboundInfo !== null && inboundInfo.enabled === true;
      const inboundStateLabel = inboundConnected
        ? t("inboundConnected")
        : inboundEnabled
          ? t("inboundDisconnected")
          : t("inboundDisabled");
      const inboundCwd = inboundInfo !== null && typeof inboundInfo.cwd === "string" ? inboundInfo.cwd : "";
      const inboundSessionId = inboundInfo !== null && typeof inboundInfo.sessionId === "string"
        ? inboundInfo.sessionId
        : "";
      const inboundLastAt = inboundInfo !== null && typeof inboundInfo.lastInboundAt === "string"
        ? inboundInfo.lastInboundAt
        : "";
      const inboundLastError = inboundInfo !== null && typeof inboundInfo.lastError === "string"
        ? inboundInfo.lastError
        : "";
      const inboundLastLabel = inboundLastAt === ""
        ? t("noInboundYet")
        : `${formatTime(inboundLastAt)} · ${relativeTime(inboundLastAt, t)}`;
      const expireMinutes = bind !== null && typeof bind.expireIn === "number" && bind.expireIn > 0
        ? Math.max(1, Math.round(bind.expireIn / 60))
        : 0;
      const busy = testing || unbinding || rebinding;
      const showBind = status !== null && (!bound || phase !== "idle");
      const showActions = bound && phase === "idle";

      // ------------------------------------------------------------------
      // Cards.
      // ------------------------------------------------------------------

      const statusBody = loading && status === null
        ? h("p", { className: S.muted }, t("loading"))
        : status === null
          ? h(
              "div",
              { className: S.inlineError },
              h("p", { className: S.errorPlain }, t("loadFailedDetail", { message: loadError || t("unknownError") })),
              h(
                "div",
                { className: S.actions },
                h("button", { type: "button", className: S.btn, onClick: retryLoad }, t("retry")),
              ),
            )
          : h(
              "div",
              { className: S.stack },
              h(
                "div",
                { className: S.badgeRow },
                h("span", { className: `${S.badge} ${bound ? S.badgeOn : ""}` }, bound ? t("bound") : t("unbound")),
                brand === "" ? null : h("span", { className: S.badge }, brand),
              ),
              h(
                "div",
                { className: S.rows },
                appIdMasked === "" ? null : h(Row, { label: t("appId"), value: appIdMasked }),
                h(Row, { label: t("target"), value: targetLabel }),
                boundAt === "" ? null : h(Row, { label: t("boundAt"), value: formatTime(boundAt) }),
              ),
              scopesRepairedAt === ""
                ? null
                : h("p", { className: S.hint }, t("scopesRepaired", { time: formatTime(scopesRepairedAt) })),
              loadError === null
                ? null
                : h("p", { className: S.errorPlain }, t("loadFailedDetail", { message: loadError })),
              lastError === ""
                ? null
                : h(
                    "div",
                    { className: S.warn },
                    h("span", { className: S.warnLabel }, t("lastError")),
                    h("span", { className: S.warnText }, lastError),
                  ),
            );

      const statusCard = h(
        Card,
        {
          title: t("status"),
          dot: bound ? "on" : "off",
          extra: h(
            "button",
            {
              type: "button",
              className: S.btn,
              disabled: refreshing,
              onClick: refresh,
            },
            refreshing ? t("refreshing") : t("refresh"),
          ),
        },
        statusBody,
      );

      // 飞书入站状态卡：直连 WebSocket 是否就绪、消息落到哪个工作区/会话、
      // 最近一条什么时候到、以及连接错误。未绑定时只提示先绑定。
      const inboundCard = inboundInfo === null
        ? null
        : h(
            Card,
            { title: t("inbound"), dot: inboundConnected ? "on" : "off" },
            h(
              "div",
              { className: S.badgeRow },
              h("span", { className: `${S.badge} ${inboundConnected ? S.badgeOn : ""}` }, inboundStateLabel),
            ),
            bound
              ? h(
                  "div",
                  { className: S.stack },
                  h(CopyField, {
                    label: t("workspace"),
                    text: inboundCwd,
                    copyKey: "workspace",
                    copiedKey,
                    onCopy: copyText,
                    t,
                  }),
                  h(
                    "div",
                    { className: S.rows },
                    inboundSessionId === ""
                      ? null
                      : h(Row, { label: t("sessionId"), value: inboundSessionId }),
                    h(Row, { label: t("lastInbound"), value: inboundLastLabel }),
                  ),
                  inboundLastError === ""
                    ? null
                    : h(
                        "p",
                        { className: S.errorPlain },
                        t("inboundErrorDetail", { message: inboundLastError }),
                      ),
                  h("p", { className: S.hint }, t("inboundHint")),
                )
              : h(
                  "div",
                  { className: S.stack },
                  h("p", { className: S.hint }, t("inboundBoundHint")),
                  h("p", { className: S.hint }, t("inboundHint")),
                ),
          );

      const bindTitle = phase === "waiting"
        ? t("waitingTitle")
        : phase === "error"
          ? (flowMode === "repair" ? t("repairFailed") : t("bindFailed"))
          : (flowMode === "repair" ? t("repair") : t("bind"));

      const bindBody = phase === "starting"
        ? h(
            "div",
            { className: S.stack },
            h("p", { className: S.muted }, t("binding")),
            h("p", { className: S.hint }, t("bindingHint")),
          )
        : phase === "error"
          ? h(
              "div",
              { className: S.stack },
              h("p", { className: S.errorPlain }, bindError || t("unknownError")),
              h(
                "div",
                { className: S.actions },
                h(
                  "button",
                  {
                    type: "button",
                    className: S.btnPrimary,
                    onClick: flowMode === "repair" ? beginRepair : beginBind,
                  },
                  t("retry"),
                ),
                h("button", { type: "button", className: S.btn, onClick: dismissFlow }, t("cancel")),
              ),
            )
          : phase === "waiting"
            ? h(
                "div",
                { className: S.stack },
                flowMode === "repair" ? h("p", { className: S.hint }, t("repairHint")) : null,
                bind === null
                  ? h("p", { className: S.muted }, t("waiting"))
                  : h(
                      "div",
                      { className: S.qrRow },
                      h("img", {
                        className: S.qr,
                        src: bind.qr,
                        style: { width: 240 },
                        alt: flowMode === "repair" ? t("repairQrAlt") : t("qrAlt"),
                      }),
                      h(
                        "div",
                        { className: S.qrSide },
                        h("p", { className: S.waitingText }, t("waiting")),
                        expireMinutes > 0
                          ? h("p", { className: S.hint }, t("qrExpire", { minutes: String(expireMinutes) }))
                          : null,
                        h("p", { className: S.hint }, t("qrLinkHint")),
                        h(
                          "a",
                          { className: S.link, href: bind.url, target: "_blank", rel: "noreferrer" },
                          bind.url,
                        ),
                        h(
                          "div",
                          { className: S.actions },
                          h("button", { type: "button", className: S.btn, onClick: cancelBind }, t("cancel")),
                        ),
                      ),
                    ),
                bind === null
                  ? h(
                      "div",
                      { className: S.actions },
                      h("button", { type: "button", className: S.btn, onClick: cancelBind }, t("cancel")),
                    )
                  : null,
              )
            : h(
                "div",
                { className: S.stack },
                h("p", { className: S.hint }, t("scanHint")),
                h("button", { type: "button", className: S.cta, onClick: beginBind }, t("bind")),
              );

      const bindCard = showBind
        ? h(Card, { title: bindTitle, dot: phase === "waiting" ? "on" : "off" }, bindBody)
        : null;

      const actionsCard = showActions
        ? h(
            Card,
            { title: t("actions") },
            h("p", { className: S.hint }, t("actionsHint")),
            h(
              "div",
              { className: S.actions },
              h(
                "button",
                { type: "button", className: S.btnPrimary, disabled: busy, onClick: sendTest },
                testing ? t("sending") : t("testSend"),
              ),
              h(
                "button",
                { type: "button", className: S.btn, disabled: busy, onClick: beginRepair },
                t("repair"),
              ),
              h(
                "button",
                { type: "button", className: S.btn, disabled: busy, onClick: rebind },
                rebinding ? t("rebinding") : t("rebind"),
              ),
              h(
                "button",
                { type: "button", className: S.btnDanger, disabled: busy, onClick: doUnbind },
                unbinding ? t("unbinding") : confirmUnbind ? t("confirmUnbind") : t("unbind"),
              ),
              confirmUnbind
                ? h(
                    "button",
                    { type: "button", className: S.btn, disabled: unbinding, onClick: () => setConfirmUnbind(false) },
                    t("cancel"),
                  )
                : null,
            ),
            h("p", { className: S.hint }, confirmUnbind ? t("unbindConfirmHint") : t("unbindHint")),
          )
        : null;

      const manualBody = manualOpen
        ? h(
            "form",
            { className: S.form, onSubmit: submitManual },
            h(
              "div",
              { className: S.field },
              h("label", { className: S.fieldLabel, htmlFor: "larkn-app-id" }, t("appId")),
              h("input", {
                id: "larkn-app-id",
                className: S.input,
                type: "text",
                value: appId,
                placeholder: "cli_...",
                autoComplete: "off",
                spellCheck: false,
                onChange: (event) => setAppId(event.target.value),
              }),
              h("p", { className: S.hint }, t("appIdHint")),
            ),
            h(
              "div",
              { className: S.field },
              h("label", { className: S.fieldLabel, htmlFor: "larkn-app-secret" }, t("appSecret")),
              h("input", {
                id: "larkn-app-secret",
                className: S.input,
                type: "password",
                value: appSecret,
                autoComplete: "new-password",
                spellCheck: false,
                onChange: (event) => setAppSecret(event.target.value),
              }),
              h("p", { className: S.hint }, t("appSecretHint")),
            ),
            h(
              "div",
              { className: S.formRow },
              h(
                "div",
                { className: S.field },
                h("label", { className: S.fieldLabel, htmlFor: "larkn-target-type" }, t("targetType")),
                h(
                  "select",
                  {
                    id: "larkn-target-type",
                    className: S.input,
                    value: targetType,
                    onChange: (event) => setTargetType(event.target.value),
                  },
                  h("option", { value: "open_id" }, t("openId")),
                  h("option", { value: "chat_id" }, t("chatId")),
                ),
              ),
              h(
                "div",
                { className: S.field },
                h("label", { className: S.fieldLabel, htmlFor: "larkn-target-id" }, t("targetId")),
                h("input", {
                  id: "larkn-target-id",
                  className: S.input,
                  type: "text",
                  value: targetId,
                  autoComplete: "off",
                  spellCheck: false,
                  onChange: (event) => setTargetId(event.target.value),
                }),
                h("p", { className: S.hint }, t("targetIdHint")),
              ),
            ),
            h(
              "div",
              { className: S.actions },
              h(
                "button",
                { type: "submit", className: S.btnPrimary, disabled: saving },
                saving ? t("saving") : t("save"),
              ),
              h(
                "button",
                { type: "button", className: S.btn, disabled: saving, onClick: () => setManualOpen(false) },
                t("cancel"),
              ),
            ),
          )
        : h("p", { className: S.hint }, t("manualHint"));

      const manualCard = h(
        Card,
        {
          title: t("manual"),
          extra: h(
            "button",
            {
              type: "button",
              className: S.btn,
              "aria-expanded": manualOpen,
              onClick: () => setManualOpen((open) => !open),
            },
            manualOpen ? t("collapse") : t("expand"),
          ),
        },
        manualBody,
      );

      const historyCard = status === null
        ? null
        : h(
            Card,
            { title: t("history") },
            history.length === 0
              ? h("p", { className: S.muted }, t("emptyHistory"))
              : h(
                  "div",
                  { className: S.history },
                  history.map((item, index) => {
                    const row = item !== null && typeof item === "object" ? item : {};
                    const at = typeof row.at === "string" ? row.at : "";
                    const ok = row.ok === true;
                    const preview = typeof row.preview === "string" ? row.preview : "";
                    const itemError = typeof row.error === "string" ? row.error : "";
                    const kind = row.kind === "image" ? t("kindImage") : t("kindText");
                    return h(
                      "div",
                      { className: S.historyItem, key: `${at}-${index}` },
                      h("span", { className: S.historyTime }, formatTime(at)),
                      h("span", { className: `${S.badge} ${ok ? S.badgeOn : S.badgeBad}` }, ok ? t("ok") : t("failed")),
                      h("span", { className: S.badge }, kind),
                      h("span", { className: S.historyPreview, title: preview }, preview === "" ? "—" : preview),
                      itemError === "" ? null : h("span", { className: S.historyError }, itemError),
                    );
                  }),
                ),
          );

      const scriptCard = status === null || (httpEndpoint === "" && httpTokenPath === "")
        ? null
        : h(
            Card,
            { title: t("scriptTitle") },
            h("p", { className: S.hint }, t("httpHint")),
            httpEndpoint === ""
              ? null
              : h(CopyField, {
                  label: t("endpoint"),
                  text: httpEndpoint,
                  copyKey: "endpoint",
                  copiedKey,
                  onCopy: copyText,
                  t,
                }),
            httpTokenPath === ""
              ? null
              : h(CopyField, {
                  label: t("tokenPath"),
                  text: httpTokenPath,
                  copyKey: "token",
                  copiedKey,
                  onCopy: copyText,
                  t,
                }),
          );

      return h(
        "div",
        { className: S.page },
        h(
          "header",
          { className: S.head },
          h("h2", { className: S.title }, t("section")),
          h("p", { className: S.intro }, t("intro")),
        ),
        error === null
          ? null
          : h(
              "div",
              { className: S.error, role: "alert" },
              h("span", { className: S.errorText }, error),
              h(
                "button",
                { type: "button", className: S.bannerClose, "aria-label": t("dismiss"), onClick: () => setError(null) },
                "×",
              ),
            ),
        notice === null ? null : h("p", { className: S.notice, role: "status" }, notice),
        statusCard,
        inboundCard,
        bindCard,
        actionsCard,
        manualCard,
        historyCard,
        scriptCard,
      );
    }

    // ------------------------------------------------------------------
    // Plugin wiring.
    // ------------------------------------------------------------------

    const inject = ["slots", "connection", "locale"];

    function apply(ctx) {
      // Styles are an owned effect too: the tag is removed when the plugin unloads.
      ctx.effect(() => {
        const tag = ensureStyles();
        return () => {
          if (tag === null) return;
          if (typeof tag.remove === "function") tag.remove();
          else if (tag.parentNode) tag.parentNode.removeChild(tag);
        };
      }, "lark-notify: page styles");

      // Dictionaries are owned effects: they disappear with the plugin. The
      // object form registers both shipped locales atomically (the runtime also
      // accepts the per-locale form).
      ctx.effect(
        () => ctx.locale.register(NS, { zh, en }),
        "lark-notify: locale dictionaries",
      );

      const t = ctx.locale.bind(NS);
      const call = (endpoint, payload, signal) => ctx.connection.rpc.call(
        CHANNEL,
        endpoint,
        payload === undefined ? {} : payload,
        signal,
      );

      ctx.slots.inject("settings.section", () => ctx.slots.register(
        {
          name: "settings.section",
          id: NS,
          order: 21,
          label: () => t("section"),
          inject: () => ({ call, t }),
        },
        SettingsPage,
      ));
    }

    exports.name = "dsh-lark-notify-client";
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
