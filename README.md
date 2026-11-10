English | [简体中文](README.zh.md)

# dsh-lark-notify

**Turn Feishu into DeepSeek Harness (DSH)'s notification outlet — and bring Feishu conversations back into DSH.**

One settings page, one QR scan: the agent can proactively send you Feishu notifications, local scripts can push over the HTTP API, and when you message the bot on your phone, DSH continues the conversation in the “Feishu” workspace.

- **QR-code binding**: scan once with Feishu and the plugin creates and binds an enterprise self-built app for you — no manual App Secret.
- **Three delivery paths**: the `lark_notify` agent tool, a local HTTP API (Bearer token), and conversation-scoped reply tools in Feishu.
- **Two-way chat**: DMs and group @-mentions both reach DSH sessions; inbound images, files, and quoted replies are supported.
- **Approval relay**: turns that need approval are forwarded to Feishu — reply `approve` / `deny` (「同意 / 拒绝」).
- **Reliable delivery**: failures go into a retry queue; long text is chunked automatically; Markdown cards are supported.
- **Privacy first**: credentials stay on your machine (`0600`), are never written into profile config, and never reach the repository.

> Compatibility: Feishu self-built bot apps. The code uses `tenantBrand` to pick the Feishu / Lark domain,
> so the international Lark version can be bound manually with that tenant's app credentials.

---

## Installation

The plugin is distributed as a DSH bundle. Install it into a profile, then restart DSH for it to take effect:

```bash
# Install from npm (available once published; replace <name> with your actual profile name)
dsh plugin --profile <name> add dsh-lark-notify
```

You can also:

- search and install it from DSH's “Plugins” page;
- link the source directory directly for local development:

  ```bash
  dsh plugin --profile <name> add link:/path/to/dsh-lark-notify
  ```

After installation, a plugin page appears under **Settings → Lark Notify**.

## First-time setup (~30 seconds)

1. Open **Settings → Lark Notify**.
2. Click **Link a bot**, scan the QR code with Feishu mobile, and tap “Approve” on the confirmation page.
3. The plugin creates and binds an enterprise self-built app automatically (default name “DSH 通知助手”) and preconfigures:

   | Type | Content |
   |---|---|
   | Bot capability | Self-built app bot |
   | Send scopes | `im:message:send_as_bot`, `im:resource` |
   | Inbound scopes | `im:message:readonly`, `im:message.group_at_msg:readonly` |
   | Naming/member scopes | `im:chat:readonly`, `contact:user.base:readonly`, `im:chat.members:read` |
   | Event subscription | `im.message.receive_v1` |
   | Delivery target | the scanner's DM `open_id` |

4. Click **Send test message**; a test notification should arrive in Feishu immediately.
5. If you only need push notifications and not two-way chat, you are done at this step.

> Feishu has no “scan once to log in a bot” authorization mode. The official mechanism is
> **one-click app creation (OAuth 2.0 Device Authorization Grant)**: after you approve on your phone, it returns
> the App ID / App Secret — the closest official flow to “scan to bind”. The QR code expires after 1 hour;
> just click again when that happens.

**Already have a self-built app?** Expand **Enter App ID / Secret manually** and fill in the credentials;
the delivery target (`open_id` or `chat_id`) is optional. On first bind the plugin validates the credentials
(one `tenant_access_token` request).

**Grant media permissions**: if some permissions were skipped during binding (for example, you only wanted text)
and you later need inbound images/files, group names, or member names, click **Grant media permissions** once
and confirm with a QR scan — no re-binding needed.

## Usage

### 1. Agent tool: `lark_notify`

Once bound, the model in any DSH session can proactively notify you:

```text
After you have organized the results, use lark_notify to send them to my Feishu.
```

Parameters:

| Parameter | Required | Description |
|---|---|---|
| `text` | Yes | Notification body (plain text, may contain newlines) |
| `image_path` | No | Absolute path to a local image (PNG/JPEG, up to 10MB) |
| `chat_id` | No | Target group `chat_id` (`oc_xxxxxxxx`); omit = the binder's DM |
| `markdown` | No | Send as a Markdown card (Feishu plain text does not render Markdown) |

### 2. Local scripts: HTTP push API

The plugin mounts several local endpoints on DSH's Host HTTP server (bound to the loopback interface only;
the port is the DSH Web port):

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/plugins/lark-notify/notify` | Bearer token | Send text / Markdown / image / file |
| `GET` | `/plugins/lark-notify/health` | None | Health check; returns whether a bot is bound |
| `GET` | `/plugins/lark-notify/chats` | Bearer token | List the groups the bot is in |
| `POST` | `/plugins/lark-notify/dsh-send` | Bearer token | Inject a user message into a given DSH session |
| `GET` | `/plugins/lark-notify/inbound` | None | Inbound diagnostics: long-connection state, approvals, live sessions |
| `POST` | `/plugins/lark-notify/reset` | Bearer token | Clear local binding and test data (destructive) |

The plugin writes the token file and the current endpoint to your machine:

```bash
TOKEN=$(cat ~/.dsh/integrations/lark-notify/http-token)   # $DSH_HOME defaults to ~/.dsh
PORT=<your DSH Web port>
```

```bash
# Send text
curl -s -X POST http://127.0.0.1:$PORT/plugins/lark-notify/notify \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"text":"Build finished: all 3 tasks passed"}'

# Send a Markdown card (headings / lists / code blocks / tables)
curl -s -X POST http://127.0.0.1:$PORT/plugins/lark-notify/notify \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"markdown":"## Daily report\n\n- Deploy succeeded\n- No warnings"}'

# Send an image (absolute local path)
curl -s -X POST http://127.0.0.1:$PORT/plugins/lark-notify/notify \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"text":"Screenshot","imagePath":"/abs/path/chart.png"}'

# Send to a specific group (without target = the binder's DM)
curl -s -X POST http://127.0.0.1:$PORT/plugins/lark-notify/notify \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"text":"Sent to the group","target":{"type":"chat_id","id":"oc_xxxxxxxx"}}'

# Health check
curl -s http://127.0.0.1:$PORT/plugins/lark-notify/health
```

Body fields for `notify`: at least one of `text`, `markdown`, `imagePath`, `filePath`;
optionally `target: { type: "chat_id" | "open_id", id }`.

A Python client (no third-party dependencies) is available at
[`examples/lark_notify_client.py`](examples/lark_notify_client.py): it reads the `endpoint` file automatically,
so you never have to fill in the port.

```python
from lark_notify_client import send_text, send_image

send_text("Build finished: all checks passed")
send_image("/abs/path/result.png", caption="Result chart")
```

### 3. Chatting in Feishu (two-way)

Once bound, the plugin opens a Feishu **WebSocket long connection**:

```
Feishu DM / group @-mention → inject into a DSH session → agent handles it → reply sent back to the original chat
```

- **Workspace**: the first inbound message creates and registers the “Feishu” workspace, default directory
  `$DSH_HOME/workspaces/feishu` (`DSH_HOME` defaults to `~/.dsh`); override it with `config.cwd`.
- **Session isolation**: the binder's DM is `feishu-main`; other members' DMs are `feishu-dm-<open_id>`;
  each group is `feishu-group-<chat_id>`. They are independent, and replies go back to their own chat.
- **Group chats**: by default only **@-mentions of the bot** are answered (`groupMode: "all"` answers every message;
  `allowGroups: ["oc_xxxxxxxx"]` limits responses to specific groups).
- **How replies work**: at the end of a turn the assistant's final text is sent back automatically; if the turn already
  called `lark_notify` or a conversation-scoped reply tool, it is not sent a second time.
- **Conversation-scoped tools**: `send_lark_text` / `send_lark_image` / `send_lark_file` only affect the current Feishu conversation;
  `list_lark_members` reads the current group/DM members (names + `open_id`; cache hits are not refreshed, and refreshes are rate-limited to 60 seconds per group).
- **No interactive questions**: Feishu sessions get a dedicated system prompt and have `ask_user_question` disabled —
  cards cannot be tapped on a phone, so the AI is told to “answer with the most reasonable assumption when unsure”.
- **Approval relay**: operations that need an escalation send a [DSH permission request] to the chat that triggered it;
  reply `approve` / `deny` (「同意 / 拒绝」). No response within 10 minutes counts as a timeout.
- **In-progress feedback**: a turn longer than 8 seconds first sends “⏳ 收到，正在处理…” (received, working on it…), and the final answer edits that same message.
- **Images / files**: media sent directly to the bot is downloaded to `<workspace>/inbound/` and the path is passed to the model.
- **Quoted replies**: long-press to quote an older message; the quoted content is used as a context prefix.
- **Failure retry**: failed sends go into `outbox.jsonl` and are retried every 30 seconds, and also opportunistically when a new message arrives.
- **Limitations**: voice / video messages are not supported yet; replies are plain text or cards, and editing the placeholder message only works for text.

## Configuration

Configure it in the profile's bundle patch (restart DSH after changing it):

```yaml
- id: lark-notify
  config:
    autoStart: true                              # start the inbound long connection with DSH (default true)
    cwd: ~/.dsh/workspaces/feishu                # Feishu workspace directory (default)
    sessionId: feishu-main                       # session id reused for the binder's DM
    groupMode: mention                           # mention = only @-mentions; all = answer every message
    allowGroups: ["oc_xxxxxxxx"]                 # only answer these groups (empty = no limit)
    groupSessionPrefix: feishu-group-            # group session id prefix
    dmSessionPrefix: feishu-dm-                  # other members' DM session id prefix
    approvalTimeoutMs: 600000                    # approval timeout (milliseconds)
```

## Data and privacy

**All runtime data stays on your machine**, under `$DSH_HOME/integrations/lark-notify/` by default
(`DSH_HOME` defaults to `~/.dsh`):

| Content | Location | Permissions |
|---|---|---|
| App credentials (App ID / App Secret / target `open_id`) | `credentials.json` | `0600` |
| Script HTTP token | `http-token` | `0600` |
| Current endpoint | `endpoint` | `0600` |
| Recent send history | `history.jsonl` | directory default |
| Failure retry queue | `outbox.jsonl` | directory default |
| Inbound event diagnostics / approval records | `inbound-events.jsonl`, `approvals.jsonl` | directory default |
| Inbound images / files | `<workspace>/inbound/` | directory default |

- Credentials are **never** written into the profile's `cordis.patch.yml`, and **never** returned to the browser
  (the settings page only shows masked values).
- The HTTP push API binds to the loopback interface only and requires a Bearer token; `dsh-send` / `chats` / `reset`
  require the same token.
- The plugin does not send credentials, chat content, or history to any service outside DSH; data only flows between
  your machine and the Feishu Open Platform.
- The repository itself contains no real credentials, `open_id`, `chat_id`, or tokens; examples and tests use placeholders only.

**Disconnect** (the settings-page button) only deletes local credentials and stops the long connection; it does **not**
delete the app in Feishu. To clean up completely: delete the app in the Feishu developer console, then remove the
`$DSH_HOME/integrations/lark-notify/` directory.

## Uninstall

```bash
dsh plugin --profile <name> remove dsh-lark-notify
```

Then remove `$DSH_HOME/integrations/lark-notify/` and the self-built app in Feishu as needed.

## Troubleshooting

| Symptom | What to do |
|---|---|
| The page keeps waiting after scanning | Make sure you approved on Feishu mobile; the QR code expires after 1 hour — click “Cancel” and scan again |
| Test send fails with `code=230013` etc. | The bot is not in your availability scope: Feishu developer console → App → Availability scope, add the person who scanned |
| Sending an image reports a permission error | The app lacks `im:resource`: add the scope in the developer console and publish a version |
| The script gets 401 | The token file was regenerated; re-read `http-token` |
| No inbound messages | Confirm **Settings → Lark Notify** shows the long connection as connected; group chats require an @-mention of the bot; check `inbound-events.jsonl` |
| The settings page does not appear | Confirm the plugin is enabled and restart DSH; check the `[lark-notify]` logs in the Host output |

## Technical notes

### Structure

```
index.js              # Host: RPC, HTTP API, agent tool, inbound wiring
client.js             # Browser side: settings page (no build step, React.createElement)
lib/store.js          # Local state: credentials / history / token (0600)
lib/lark.js           # Feishu SDK sender: text / image / file / Markdown cards
lib/registration.js   # QR binding (registerApp, OAuth Device Grant)
lib/inbound.js        # Inbound: long connection → session → reply (approval / quotes / placeholder / media)
lib/inbound-media.js  # Inbound image / file download (messageResource)
lib/reply-tools.js    # Conversation-scoped reply tools
lib/outbox.js         # Failure retry queue
lib/rpc-route.js      # Minimal HTTP transport for the settings-page RPC
locale/{zh,en}.json   # Plugin name and description
cordis.patch.yml      # bundle patch (inserts the Host line lark-notify)
CONTRACT.md           # Host ⇄ Client interface contract (for development)
examples/lark_notify_client.py
test/                 # Offline unit tests / offline smoke tests
```

### Development

```bash
# Syntax check
npm run check

# Offline tests (no Feishu credentials needed; uses a temporary DSH_HOME and never reads or writes the real credentials in ~/.dsh)
npm test          # reply / media / http tests
npm run test:smoke  # the QR flow needs access to the Feishu Open Platform; fails without network
```

`test/smoke.mjs` loads the plugin with a minimal fake `ctx` and verifies the settings-page RPC transport, QR generation,
unknown endpoints, and auth branches; `test/http.mjs` verifies HTTP endpoint auth and the unbound behavior.

## License

[MIT](LICENSE) © respawnlife
