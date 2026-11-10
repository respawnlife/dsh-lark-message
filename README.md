# dsh-lark-notify

**把飞书变成 DeepSeek Harness（DSH）的通知出口，也把飞书的对话接回 DSH。**

一个设置页、扫一次码：Agent 可以主动给你发飞书通知，本地脚本可以走 HTTP 接口推送，
你在手机上给机器人发消息，DSH 会在「飞书」工作区里继续跟你对话。

- **扫码绑定**：用飞书扫一次码，自动创建并绑定一个企业自建应用，不用手填 App Secret。
- **三种推送方式**：Agent 工具 `lark_notify`、本地 HTTP 接口（Bearer token）、飞书里的会话回复工具。
- **双向对话**：私聊 / 群聊 @机器人 都能接入 DSH 会话；支持图片、文件入站与引用回复。
- **审批转发**：需要批准的回合会发到飞书，回一句「同意 / 拒绝」即可。
- **可靠投递**：失败自动进重试队列；长文本自动分段，支持 Markdown 卡片。
- **隐私优先**：凭据只存本机（`0600`），不写进 profile 配置，也永远不会进仓库。

> 兼容性：飞书（Feishu）自建应用机器人；代码按 `tenantBrand` 区分飞书 / Lark 域名，
> 国际版 Lark 可在手动绑定时使用对应的应用凭据。

---

## 安装

插件以 DSH bundle 的形式分发。安装到某个 profile 后重启 DSH 生效：

```bash
# 从 npm 安装（发布后可用；替换 desktop 为你实际的 profile 名）
dsh plugin --profile desktop add dsh-lark-notify
```

也可以：

- 在 DSH 的「插件」页面搜索安装；
- 本地开发时直接链接源码目录：

  ```bash
  dsh plugin --profile desktop add link:/path/to/dsh-lark-notify
  ```

安装完成后，`设置 → 飞书通知` 里会出现插件页面。

## 首次配置（约 30 秒）

1. 打开 **设置 → 飞书通知**。
2. 点 **扫码绑定机器人**，用手机飞书扫码，并在确认页点「同意」。
3. 插件会自动创建并绑定一个企业自建应用（默认名「DSH 通知助手」），并预置：

   | 类型 | 内容 |
   |---|---|
   | 机器人能力 | 自建应用机器人 |
   | 发送权限 | `im:message:send_as_bot`、`im:resource` |
   | 入站权限 | `im:message:readonly`、`im:message.group_at_msg:readonly` |
   | 命名/成员权限 | `im:chat:readonly`、`contact:user.base:readonly`、`im:chat.members:read` |
   | 事件订阅 | `im.message.receive_v1` |
   | 发送目标 | 扫码人的私聊 `open_id` |

4. 点 **发送测试消息**，飞书里应立刻收到一条测试通知。
5. 如果只想先要推送、不要双向对话，到这一步就完成了。

> 飞书没有「扫一次码就登录机器人」的授权模式，官方提供的是
> **一键创建应用（OAuth 2.0 Device Authorization Grant）**：扫码确认后返回 App ID / App Secret，
> 这是官方流程里最接近「扫码即绑定」的方式。二维码 1 小时过期，过期后重新点一次即可。

**已有自建应用？** 展开「手动填写 App ID / App Secret」，填入凭据即可；可选填发送目标
（`open_id` 或 `chat_id`）。首次绑定时插件会校验凭据（获取一次 `tenant_access_token`）。

**补全权限**：如果绑定时跳过了部分权限（例如只想发文字），之后需要图片/文件入站、
群名或成员名字时，点一次 **补全权限** 并扫码确认即可，不需要重新绑定。

## 使用

### 1. Agent 工具：`lark_notify`

绑定后，任何 DSH 会话里的模型都可以主动给你发通知：

```text
把结果整理好之后用 lark_notify 发到我的飞书
```

参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `text` | 是 | 通知正文（纯文本，可含换行） |
| `image_path` | 否 | 本地图片绝对路径（PNG/JPEG，10MB 内） |
| `chat_id` | 否 | 目标群 `chat_id`（`oc_xxxxxxxx`）；不填 = 绑定者私聊 |
| `markdown` | 否 | 按 Markdown 卡片发送（飞书纯文本不渲染 Markdown） |

### 2. 本地脚本：HTTP 推送接口

插件在 DSH 的 Host HTTP 服务上挂了几个本地接口（只监听回环地址，端口即 DSH Web 端口）：

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| `POST` | `/plugins/lark-notify/notify` | Bearer token | 发送文字 / Markdown / 图片 / 文件 |
| `GET` | `/plugins/lark-notify/health` | 无 | 健康检查，返回是否已绑定 |
| `GET` | `/plugins/lark-notify/chats` | Bearer token | 列出机器人所在的群 |
| `POST` | `/plugins/lark-notify/dsh-send` | Bearer token | 向指定 DSH 会话注入一条用户消息 |
| `GET` | `/plugins/lark-notify/inbound` | 无 | 入站诊断：长连接状态、审批记录、在线会话 |
| `POST` | `/plugins/lark-notify/reset` | Bearer token | 清空本地绑定与测试数据（危险操作） |

token 文件和当前可用地址由插件自动写在本机：

```bash
TOKEN=$(cat ~/.dsh/integrations/lark-notify/http-token)   # $DSH_HOME 默认 ~/.dsh
PORT=<你的 DSH Web 端口>
```

```bash
# 发文字
curl -s -X POST http://127.0.0.1:$PORT/plugins/lark-notify/notify \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"text":"构建完成：3 个任务全部通过"}'

# 发 Markdown 卡片（标题 / 列表 / 代码块 / 表格）
curl -s -X POST http://127.0.0.1:$PORT/plugins/lark-notify/notify \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"markdown":"## 日报\n\n- 部署成功\n- 无告警"}'

# 发图片（本地绝对路径）
curl -s -X POST http://127.0.0.1:$PORT/plugins/lark-notify/notify \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"text":"截图","imagePath":"/abs/path/chart.png"}'

# 发到指定群（不传 target = 绑定者私聊）
curl -s -X POST http://127.0.0.1:$PORT/plugins/lark-notify/notify \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"text":"发到群里","target":{"type":"chat_id","id":"oc_xxxxxxxx"}}'

# 健康检查
curl -s http://127.0.0.1:$PORT/plugins/lark-notify/health
```

`notify` 的 body 字段：`text`、`markdown`、`imagePath`、`filePath` 至少给一个；
可选 `target: { type: "chat_id" | "open_id", id }`。

Python 客户端（无第三方依赖）见 [`examples/lark_notify_client.py`](examples/lark_notify_client.py)：
它会自动读取 `endpoint` 文件，不用手填端口。

```python
from lark_notify_client import send_text, send_image

send_text("训练完成：loss 0.042")
send_image("/abs/path/result.png", caption="结果曲线")
```

### 3. 在飞书里聊天（双向）

绑定后插件会建立飞书 **WebSocket 长连接**：

```
飞书私聊 / 群 @机器人 → 注入 DSH 会话 → Agent 处理 → 回复自动发回原聊天
```

- **工作区**：第一次收到消息时自动创建并注册「飞书」工作区，默认目录
  `$DSH_HOME/workspaces/feishu`（`DSH_HOME` 默认 `~/.dsh`），可用 `config.cwd` 覆盖。
- **会话隔离**：绑定者私聊是 `feishu-main`；其他成员私聊为 `feishu-dm-<open_id>`；
  每个群是 `feishu-group-<chat_id>`。互相独立，回复各回各的聊天。
- **群聊**：默认只在 **@机器人** 时响应（`groupMode: "all"` 改为每条都回；
  `allowGroups: ["oc_xxxxxxxx"]` 限定只响应某些群）。
- **回复方式**：一轮结束时助手最后的文字自动发回；如果这一轮已经调用过
  `lark_notify` 或会话专属回复工具，就不再重复发送。
- **会话专属工具**：`send_lark_text` / `send_lark_image` / `send_lark_file` 只作用于当前飞书对话；
  `list_lark_members` 读取当前群/私聊成员（名字 + `open_id`，命中缓存不刷新，刷新限流 60 秒/群）。
- **不弹交互问题**：飞书会话注入了专用系统提示并禁用 `ask_user_question`——
  手机上点不了卡片，AI 被要求「拿不准就按最合理假设直接回答」。
- **审批转发**：需要提权的操作把【DSH 权限请求】发到触发它的聊天，回复「同意 / 拒绝」即可；
  默认 10 分钟无响应视为超时。
- **处理中反馈**：一轮超过 8 秒先发「⏳ 收到，正在处理…」，最终答案编辑同一条消息。
- **图片 / 文件**：直接发给机器人会下载到 `<工作区>/inbound/`，路径交给模型。
- **引用回复**：长按引用一条旧消息提问，被引用内容会作为上下文前缀。
- **失败重试**：发送失败进 `outbox.jsonl`，每 30 秒重试一次，收到新消息时也会顺手重试。
- **限制**：暂不支持语音 / 视频消息；回复是纯文本或卡片，编辑占位消息只对文本有效。

## 配置项

在 profile 的 bundle patch 里配置（改完重启 DSH）：

```yaml
- id: lark-notify
  config:
    autoStart: true                              # 是否随 DSH 启动入站长连接（默认 true）
    cwd: ~/.dsh/workspaces/feishu                 # 飞书工作区目录（默认）
    sessionId: feishu-main                       # 绑定者私聊复用的会话 id
    groupMode: mention                           # mention=仅 @机器人；all=每条都回
    allowGroups: ["oc_xxxxxxxx"]                 # 只响应指定群（空 = 不限制）
    groupSessionPrefix: feishu-group-            # 群会话 id 前缀
    dmSessionPrefix: feishu-dm-                  # 其他成员私聊会话 id 前缀
    approvalTimeoutMs: 600000                    # 审批等待超时（毫秒）
```

## 数据与隐私

**所有运行期数据只保存在本机**，默认在 `$DSH_HOME/integrations/lark-notify/`
（`DSH_HOME` 默认 `~/.dsh`）：

| 内容 | 位置 | 权限 |
|---|---|---|
| 应用凭据（App ID / App Secret / 目标 `open_id`） | `credentials.json` | `0600` |
| 脚本 HTTP token | `http-token` | `0600` |
| 当前推送地址 | `endpoint` | `0600` |
| 最近发送历史 | `history.jsonl` | 随目录 |
| 失败重试队列 | `outbox.jsonl` | 随目录 |
| 入站事件诊断 / 审批记录 | `inbound-events.jsonl`、`approvals.jsonl` | 随目录 |
| 入站图片 / 文件 | `<工作区>/inbound/` | 随目录 |

- 凭据 **不会** 写进 profile 的 `cordis.patch.yml`，也 **不会** 返回给浏览器（设置页只显示打码值）。
- HTTP 推送接口只监听本机回环地址，并要求 Bearer token；`dsh-send` / `chats` / `reset` 同样需要 token。
- 插件不会把凭据、聊天内容或历史发送到 DSH 之外的任何服务；数据只在你本机与飞书开放平台之间流动。
- 仓库本身不含任何真实凭据、`open_id`、`chat_id` 或 token；示例与测试一律使用占位符。

**解除绑定**（设置页按钮）只删除本地凭据、停止长连接，**不会**删除飞书里的应用。
想彻底清理：到飞书开发者后台删除该应用，再删除 `$DSH_HOME/integrations/lark-notify/` 目录。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-lark-notify
```

然后按需删除 `$DSH_HOME/integrations/lark-notify/` 与飞书里的自建应用。

## 排错

| 现象 | 处理 |
|---|---|
| 扫码后页面一直等待 | 确认手机飞书点过「同意」；二维码 1 小时过期，点「取消」再扫一次 |
| 测试发送报 `code=230013` 等 | 机器人不在你的可用范围内：飞书开发者后台 → 应用 → 可用范围，把扫码人加进去 |
| 发图片报权限错误 | 应用缺少 `im:resource` 权限：开发者后台补权限并发布版本 |
| 脚本 401 | token 文件被重新生成过，重新读取 `http-token` |
| 收不到入站消息 | 确认「设置 → 飞书通知」显示长连接已建立；群聊需要 @机器人；查看 `inbound-events.jsonl` |
| 设置页不出现 | 确认插件已启用并重启 DSH；查看 Host 日志里的 `[lark-notify]` |

## 技术说明

### 结构

```
index.js              # Host：RPC、HTTP 接口、Agent 工具、入站装配
client.js             # 浏览器端：设置页（无构建步骤，React.createElement）
lib/store.js          # 本地状态：凭据 / 历史 / token（0600）
lib/lark.js           # 飞书 SDK 发送端：文字 / 图片 / 文件 / Markdown 卡片
lib/registration.js   # 扫码绑定（registerApp，OAuth Device Grant）
lib/inbound.js        # 入站：长连接 → 会话 → 回发（审批 / 引用 / 占位 / 媒体）
lib/inbound-media.js  # 入站图片 / 文件下载（messageResource）
lib/reply-tools.js    # 会话专属回复工具
lib/outbox.js         # 失败重试队列
lib/rpc-route.js      # 设置页 RPC 的最小 HTTP 传输
locale/{zh,en}.json   # 插件名与描述
cordis.patch.yml      # bundle patch（插入 Host 行 lark-notify）
CONTRACT.md           # Host ⇄ Client 接口契约（开发用）
examples/lark_notify_client.py
test/                 # 不联网的单元测试 / 离线冒烟测试
```

### 开发

```bash
# 语法检查
npm run check

# 离线测试（不需要飞书凭据；用临时 DSH_HOME，绝不读写 ~/.dsh 里的真实凭据）
npm test          # reply / media / http 三个测试
npm run test:smoke  # 扫码流程需要访问飞书开放平台，无网络时会失败
```

`test/smoke.mjs` 用最小假 `ctx` 加载插件，验证设置页 RPC 传输、二维码生成、
未知端点与鉴权分支；`test/http.mjs` 验证 HTTP 接口的鉴权与未绑定行为。

## License

[MIT](LICENSE) © respawnlife
