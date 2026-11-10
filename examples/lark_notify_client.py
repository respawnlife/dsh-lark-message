#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-lark-message 的本地 HTTP 客户端（无第三方依赖，Python 3.8+）。

用途：让本地脚本/定时任务把通知交给 DSH 的飞书插件发送，
而不是自己保存 App Secret、维护 token 与重试：

    from lark_notify_client import send_text, send_image

    r = send_text("任务已完成：报告已生成")
    if not r.ok:
        print("飞书未送达:", r.error)

环境变量：
    DSH_HOME          默认 ~/.dsh
    DSH_LARK_URL      覆盖推送地址；默认从 $DSH_HOME/integrations/lark-notify/http-token 同目录读取
    DSH_LARK_PORT     DSH Web 端口（默认 3080；也可以只设 DSH_LARK_URL）

说明：如果 DSH 没开或插件没绑定，调用会返回 ok=False，不会抛异常，方便监控脚本继续跑。
"""
import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass

TOKEN_FILE = os.path.join(
    os.environ.get("DSH_HOME", os.path.expanduser("~/.dsh")),
    "integrations", "lark-notify", "http-token",
)


@dataclass
class SendResult:
    ok: bool
    error: str = ""
    sent: int = 0


def _token():
    try:
        with open(TOKEN_FILE, encoding="utf-8") as f:
            token = f.read().strip()
        return token or None
    except OSError:
        return None


def _chats_endpoint():
    notify = _endpoint()
    return notify.rsplit('/notify', 1)[0] + '/chats'


def _headers():
    token = _token()
    if not token:
        return None
    return {"Content-Type": "application/json", "Authorization": "Bearer " + token}


def list_chats(timeout=15):
    """列出机器人所在的群（不含单聊）。返回 list；失败返回 []。"""
    headers = _headers()
    if headers is None:
        return []
    try:
        req = urllib.request.Request(_chats_endpoint(), headers=headers, method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        return body.get("chats") or []
    except Exception:  # noqa: BLE001
        return []


def _endpoint():
    explicit = os.environ.get("DSH_LARK_URL")
    if explicit:
        return explicit
    # 插件会把当前可用的完整地址写到 endpoint 文件，优先用它，避免猜 DSH 端口。
    endpoint_file = os.path.join(os.path.dirname(TOKEN_FILE), "endpoint")
    try:
        with open(endpoint_file, encoding="utf-8") as f:
            saved = f.read().strip()
        if saved.startswith("http"):
            return saved
    except OSError:
        pass
    port = os.environ.get("DSH_LARK_PORT", "3080")
    return "http://127.0.0.1:%s/plugins/lark-notify/notify" % port


def _post(payload, timeout=15):
    token = _token()
    if not token:
        return SendResult(False, "找不到 http-token：%s（DSH 未启动或插件未安装）" % TOKEN_FILE)
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        _endpoint(),
        data=data,
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + token},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = json.loads(e.read().decode("utf-8")).get("error", "")
        except Exception:  # noqa: BLE001
            pass
        return SendResult(False, "HTTP %s %s" % (e.code, detail or e.reason))
    except Exception as e:  # noqa: BLE001
        return SendResult(False, "连接失败：%s" % e)
    if body.get("ok"):
        return SendResult(True, sent=int(body.get("sent") or 0))
    return SendResult(False, str(body.get("error") or "未知错误"))


def send_text(text, title="", queue_on_fail=True, chat_id=None):  # noqa: ARG001
    """发送纯文本。chat_id 为空 = 绑定者个人私聊；传 oc_xxxxxxxx = 指定群聊。"""
    text = (text or "").strip()
    if not text:
        return SendResult(False, "空消息")
    if title:
        text = "%s\n%s" % (title, text)
    payload = {"text": text}
    if chat_id:
        payload["target"] = {"type": "chat_id", "id": chat_id}
    return _post(payload)


def send_markdown(markdown, chat_id=None):
    """按 Markdown 卡片发送（飞书纯文本不渲染 Markdown；卡片 2.0 支持标题/列表/代码块/表格）。"""
    text = (markdown or "").strip()
    if not text:
        return SendResult(False, "空 Markdown")
    payload = {"markdown": text}
    if chat_id:
        payload["target"] = {"type": "chat_id", "id": chat_id}
    return _post(payload, timeout=30)


def send_image(image_path, caption="", chat_id=None):
    """发送本地图片（PNG/JPEG，10MB 内）；caption 非空时先发图片再发文字。"""
    if not os.path.isfile(image_path):
        return SendResult(False, "图片不存在：%s" % image_path)
    payload = {"imagePath": image_path}
    if chat_id:
        payload["target"] = {"type": "chat_id", "id": chat_id}
    result = _post(payload)
    if result.ok and caption:
        text_result = _post({"text": caption})
        result.sent += text_result.sent
        if not text_result.ok:
            result = SendResult(result.ok, text_result.error, result.sent)
    return result


if __name__ == "__main__":
    import sys

    args = sys.argv[1:]
    chat_id = None
    as_markdown = False
    if len(args) >= 2 and args[0] == "--chat":
        chat_id = args[1]
        args = args[2:]
    if args and args[0] == "--md":
        as_markdown = True
        args = args[1:]
    if args == ["--list-chats"]:
        for chat in list_chats():
            print("%s\t%s\t%s" % (chat.get("chat_id"), chat.get("chat_mode"), chat.get("name")))
        sys.exit(0)
    text = " ".join(args) or "✅ dsh-lark-message 脚本通道测试"
    r = send_markdown(text, chat_id=chat_id) if as_markdown else send_text(text, chat_id=chat_id)
    print("ok=%s sent=%s error=%s" % (r.ok, r.sent, r.error))
    sys.exit(0 if r.ok else 1)
