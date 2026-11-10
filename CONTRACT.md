# dsh-lark-notify —— Host ⇄ Client 接口契约（实现用，不是用户文档）

包名：`dsh-lark-notify`；Loader 行 id：`lark-notify`；RPC 频道：`/lark-notify`。

## 1. Client 一半的职责

在 `settings.section` 注册一页「飞书通知」设置页（`id: "lark-notify"`, `order: 21`），
用于：扫码绑定、显示绑定状态、测试发送、查看最近发送记录、查看给脚本用的 HTTP token 路径。

```js
window.__ModuleLoader__.load({
  id: "dsh-lark-notify",
  factory: (require) => {
    const React = require("react");
    // ...
    return {
      inject: ["slots", "connection", "locale"],
      apply(ctx) {
        const call = (endpoint, payload = {}, signal) =>
          ctx.connection.rpc.call("/lark-notify", endpoint, payload, signal);
        ctx.slots.inject("settings.section", () => ctx.slots.register({
          name: "settings.section",
          id: "lark-notify",
          order: 21,
          label: () => "飞书通知",
          inject: () => ({ call, t }),
        }, SettingsPage));
      },
    };
  },
});
```

- `ctx.connection.rpc.call(channel, endpoint, payload, signal)` resolve 出的是 **Host handler 的原始信封**：
  成功 `{ ok: true, value: <返回值> }`，失败 `{ ok: false, error: { code, message, details } }`。
  它**不会**自动 reject 业务错误，也**不会**帮你拆包——UI 里先判 `res.ok` 再读 `res.value`。
  网络/协议层错误才会 reject。
- 所有 UI 文案走 `ctx.locale`：`ctx.locale.register("lark-notify", "zh", dict)`、
  `register("lark-notify", "en", dict)`，然后 `const t = ctx.locale.bind("lark-notify")`。
  字典键见第 4 节；中文为兜底。
- 样式只用 Harness 主题 token（`--dsw-alias-bg-layer-2/3`、`--dsw-alias-label-primary/secondary/tertiary`、
  `--dsw-alias-border-l2`、`--dsw-alias-brand-primary` 等），不要硬编码浅色背景。
- 组件会被放进设置面板的内容列：自带内边距、最大宽度约 720px 的容器由壳负责；
  组件渲染卡片/分组即可。不要渲染自己的标题栏。

## 2. RPC 端点（Client 可调用）

频道 `/lark-notify`，endpoint 字符串 + payload 对象。

### `status`
payload: `{}`
返回：
```ts
{
  bound: boolean;
  appId: string | null;         // 已打码，如 "cli_xxxxxxxx"
  boundAt: string | null;       // ISO 时间
  tenantBrand: "feishu" | "lark" | null;
  target: { type: "open_id" | "chat_id"; id: string } | null;  // id 已打码
  lastError: string | null;
  history: Array<{ at: string; ok: boolean; kind: "text" | "image"; preview: string; error?: string }>;
  httpTokenPath: string;        // 供脚本调用 HTTP 接口的 token 文件绝对路径
  httpEndpoint: string;         // 完整 URL，如 http://127.0.0.1:58449/plugins/lark-notify/notify
}
```

### `bindStart`
payload: `{}`
返回：`{ url: string; qr: string; expireIn: number }`（`qr` 是 `data:image/png;base64,...`）
说明：幂等。若已有进行中的扫码流程，直接返回同一个 url/qr。
用户在飞书里确认前一直处于等待态。

### `bindStatus`
payload: `{}`
返回：`{ state: "idle" | "waiting" | "bound" | "error"; url?: string; qr?: string; error?: string }`
说明：Client 在 waiting 期间每 2 秒轮询一次，直到 bound/error/idle。

### `bindCancel`
payload: `{}` → `{ ok: true }`

### `unbind`
payload: `{}` → `{ ok: true }`（删除本地凭据；不删除飞书应用）

### `manualBind`
payload: `{ appId: string; appSecret: string; targetType?: "open_id" | "chat_id"; targetId?: string }`
返回：`{ ok: true; target?: {...} }` 或抛错。
说明：验证凭据（获取 tenant_access_token）后保存；无 targetId 时只保存应用凭据，等扫码/手填目标。
如果 targetType/targetId 缺省，则沿用扫码得到的 open_id（如果存在）。

### `testSend`
payload: `{}` → `{ ok: true; at: string }` 或抛错（未绑定/发送失败）

### `send`
payload: `{ text: string; imagePath?: string }`
返回：`{ ok: true; at: string }` 或抛错。`imagePath` 必须是 Host 可读的本地绝对路径。

### `history`
payload: `{ limit?: number }` → `{ items: Array<{ at, ok, kind, preview, error? }> }`

## 3. Host 侧（实现说明，供对照）

- RPC handler：`(endpoint, payload, signal, peer) => { ok:true, value } | { ok:false, error:{code,message} }`
- 外部 HTTP（给本地脚本、定时任务、CI 通知等）：
  - `POST /plugins/lark-notify/notify`，`Authorization: Bearer <token>`（token 文件见 status.httpTokenPath），
    body `{ "text": "...", "imagePath": "/abs/path.png" }` → `{ ok: true }` / `{ ok:false, error:"..." }`
  - `GET /plugins/lark-notify/health`（无鉴权）→ `{ ok:true, bound:boolean }`
- 凭据存 `$DSH_HOME/integrations/lark-notify/credentials.json`（0600），历史存 `history.jsonl`。

## 4. locale 字典键（建议，可增补）

| key | zh | en |
|---|---|---|
| section | 飞书通知 | Lark Notify |
| status | 状态 | Status |
| bound | 已绑定 | Connected |
| unbound | 未绑定 | Not connected |
| bind | 扫码绑定机器人 | Link a bot |
| rebind | 重新绑定 | Re-link |
| unbind | 解除绑定 | Disconnect |
| scanHint | 用飞书扫码，确认后自动创建并绑定机器人 | Scan with Lark to create and link a bot |
| waiting | 等待扫码确认… | Waiting for confirmation… |
| cancel | 取消 | Cancel |
| testSend | 发送测试消息 | Send test message |
| sending | 发送中… | Sending… |
| history | 最近发送 | Recent sends |
| emptyHistory | 还没有发送记录 | No messages yet |
| httpToken | 脚本调用凭据 | Script token |
| httpHint | 本地脚本用这个 token 调用 HTTP 推送接口 | Local scripts use this token for HTTP delivery |
| copy | 复制 | Copy |
| copied | 已复制 | Copied |
| manual | 手动填写 App ID / App Secret | Enter App ID / Secret manually |
| save | 保存 | Save |
| appId | App ID | App ID |
| appSecret | App Secret | App Secret |
| target | 发送目标 | Target |
| lastError | 最近错误 | Last error |
| refresh | 刷新 | Refresh |
| ok | 成功 | Sent |
| failed | 失败 | Failed |
