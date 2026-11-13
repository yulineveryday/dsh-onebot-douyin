#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
抖音 / 多闪 的 Android UI 适配器（uiautomator2）。

职责只有两件：
  1. 轮询 App 界面，把「新消息」POST 给 OneBot 桥（inbound，默认 127.0.0.1:5702）
  2. 起一个 HTTP 服务（默认 127.0.0.1:5701），接收桥发来的 send_message 并操作界面发送

不猜抖音的私有协议：全靠无障碍节点 + u2 自带输入法（中文必须用它，adb input text 打不了中文）。
界面选择器随版本会变，所以第一步永远是 probe：

    python adapter.py probe --package com.ss.android.ugc.aweme --out dump.xml
    python adapter.py screen --out shot.png
    # 打开 dump.xml / shot.png，把 profile 里的选择器改成实际节点
    python adapter.py run --profile ../../profiles/douyin.json --dry-run
    python adapter.py run --profile ../../profiles/douyin.json

依赖：pip install uiautomator2 requests；手机开 USB 调试并 adb devices 可见。
"""

import argparse
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib import request as urlrequest

try:
    import uiautomator2 as u2
except ImportError:  # pragma: no cover
    u2 = None


BRIDGE_DEFAULT = "http://127.0.0.1:5702/message"


def log(*args):
    print("[adapter]", *args, flush=True)


def post_json(url, payload, timeout=20):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urlrequest.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urlrequest.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8", "replace")
    return json.loads(body) if body else {}


def load_profile(path):
    with open(path, "r", encoding="utf-8") as fh:
        profile = json.load(fh)
    profile.setdefault("poll_interval_ms", 1500)
    profile.setdefault("send_timeout_ms", 8000)
    profile.setdefault("selectors", {})
    return profile


class DouyinAdapter:
    def __init__(self, profile, serial=None, bridge=BRIDGE_DEFAULT, dry_run=False, verbose=False):
        if u2 is None:
            raise SystemExit("缺少依赖：pip install uiautomator2")
        self.profile = profile
        self.serial = serial
        self.bridge = bridge
        self.dry_run = dry_run
        self.verbose = verbose
        self.package = profile.get("package")
        self.selectors = profile.get("selectors") or {}
        self.device = u2.connect(serial) if serial else u2.connect()
        self.lock = threading.Lock()          # 所有 UI 操作串行化
        self.stop_event = threading.Event()
        self.seen = {}                        # 去重：key -> 时间戳
        self.seen_ttl = 6 * 3600
        self.running = False

    # ---------- 基础 ----------
    def log(self, *args):
        log(*args)

    def sel(self, name):
        value = self.selectors.get(name)
        if not value:
            raise RuntimeError("profile.selectors 缺少 " + name + "（先用 probe 看真实界面再填）")
        return value

    def q(self, name, **kwargs):
        """按选择器名取一个 UiObject，默认等 3 秒。"""
        return self.device(**self.sel(name), **kwargs)

    def q_all(self, name):
        return self.device(**self.sel(name))

    def dump_texts(self):
        """把当前界面所有带文字的节点摊平，方便对照着填选择器。"""
        rows = []
        xml = self.device.dump_hierarchy()
        for match in re.finditer(r'<node[^>]*?text="([^"]*)"[^>]*?bounds="([^"]*)"[^>]*?>', xml):
            text, bounds = match.group(1), match.group(2)
            if text.strip():
                rows.append({"text": text.strip(), "bounds": bounds})
        return rows

    def ensure_ime(self):
        """中文输入必须走 u2 的输入法广播，否则 adb input text 只能打 ASCII。"""
        try:
            self.device.set_input_ime(True)
        except Exception as exc:  # 版本差异
            self.log("设置 u2 输入法失败（旧版本可忽略）:", exc)

    def launch(self):
        self.device.app_start(self.package, stop=False)
        time.sleep(1.0)
        self.ensure_ime()

    def back_to_list(self, tries=3):
        for _ in range(tries):
            if self.q_all("chat_tab"):
                return True
            if self.q_all("back_button"):
                self.q("back_button").click()
            else:
                self.device.press("back")
            time.sleep(0.6)
        return False

    # ---------- 收消息 ----------
    def unread_rows(self):
        """返回有未读角标的会话行（text 一般就是昵称）。"""
        rows = []
        for item in self.q_all("chat_item_unread").all():
            if not item.exists:
                continue
            try:
                label = item.child(**self.sel("chat_item_name")).get_text()
            except Exception:
                label = item.info.get("text") or ""
            rows.append({"label": (label or "").strip(), "bounds": item.info.get("bounds")})
        return rows

    def open_chat(self, label):
        target = self.q("chat_item_name", text=label)
        if not target.exists:
            return False
        target.click()
        time.sleep(0.8)
        return True

    def visible_messages(self):
        """当前会话里所有可见的消息文本，从上到下。"""
        out = []
        for node in self.q_all("message_text"):
            try:
                if node.exists:
                    text = (node.get_text() or "").strip()
                    if text:
                        out.append(text)
            except Exception:
                continue
        return out

    def poll_once(self):
        self.back_to_list()
        rows = self.unread_rows()
        for row in rows:
            label = row["label"]
            if not label:
                continue
            if not self.open_chat(label):
                self.log("打不开会话:", label)
                continue
            texts = self.visible_messages()
            fresh = [text for text in texts if text and not self.is_seen(label, text)]
            for text in fresh:
                self.mark_seen(label, text)
                self.emit_message(label, text)
            self.device.press("back")
            time.sleep(0.5)

    def is_seen(self, label, text):
        key = label + "\\u0000" + text
        hit = self.seen.get(key, 0)
        return (time.time() - hit) < self.seen_ttl

    def mark_seen(self, label, text):
        now = time.time()
        self.seen[label + "\\u0000" + text] = now
        if len(self.seen) > 4000:
            for key, stamp in list(self.seen.items()):
                if now - stamp > self.seen_ttl:
                    del self.seen[key]

    def emit_message(self, label, text):
        payload = {
            "type": "message",
            "userId": self.stable_user_id(label),
            "nickname": label,
            "nativeId": label + ":" + str(int(time.time() * 1000)),
            "message": [{"type": "text", "data": {"text": text}}],
            "timestamp": int(time.time()),
        }
        if self.dry_run:
            self.log("(dry-run) 收到:", label, "->", text)
            return
        try:
            post_json(self.bridge, payload)
            self.log("收到:", label, "->", text[:40])
        except Exception as exc:
            self.log("上报桥失败:", exc)

    def stable_user_id(self, label):
        """抖音界面里没有稳定 uid 可见，这里用昵称做稳定 id；改备注会导致 id 变化。"""
        digest = 0
        for ch in label:
            digest = (digest * 131 + ord(ch)) % 1000000007
        return 100000 + digest % 900000

    # ---------- 发消息 ----------
    def send_text(self, nickname, text):
        with self.lock:
            self.launch()
            if self.q_all("search_entry"):
                self.q("search_entry").click()
            elif self.q_all("plus_button"):
                self.q("plus_button").click()
            else:
                self.device.press("back")
                time.sleep(0.4)
                if not self.q_all("search_entry"):
                    raise RuntimeError("找不到搜索入口，profile.selectors.search_entry 需要校准")
                self.q("search_entry").click()
            time.sleep(0.5)
            self.device(focused=True).set_text(nickname)
            time.sleep(1.0)
            hit = self.device(**self.sel("search_result"), text=nickname)
            if not hit.exists:
                hits = self.device(**self.sel("search_result"))
                if not hits.exists:
                    raise RuntimeError("搜索无结果: " + nickname)
                hit = hits[0]
            hit.click()
            time.sleep(1.2)
            box = self.q("input_box")
            if not box.exists:
                raise RuntimeError("进不了聊天输入框，profile.selectors.input_box 需要校准")
            box.click()
            self.ensure_ime()
            box.set_text(text)
            time.sleep(0.3)
            if self.q_all("send_button"):
                self.q("send_button").click()
            else:
                self.device.press("enter")
            time.sleep(0.8)
            self.log("发出 ->", nickname, ":", text[:40])

    # ---------- 主循环 ----------
    def run(self):
        self.running = True
        self.launch()
        self.log("适配器运行中，package=", self.package, " bridge=", self.bridge)
        while not self.stop_event.is_set():
            try:
                with self.lock:
                    self.poll_once()
            except Exception as exc:
                self.log("轮询异常:", exc)
                time.sleep(2.0)
            self.stop_event.wait(self.profile["poll_interval_ms"] / 1000.0)


class OutboundHandler(BaseHTTPRequestHandler):
    adapter = None

    def log_message(self, fmt, *args):  # 静音默认日志
        return

    def _reply(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._reply(200, {"ok": True, "adapter": "douyin", "running": bool(self.adapter and self.adapter.running)})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            self._reply(400, {"ok": False, "error": "不是合法 JSON"})
            return
        action = payload.get("action")
        try:
            if action == "ping":
                self._reply(200, {"ok": True, "pong": int(time.time())})
            elif action == "list_friends":
                self._reply(200, {"ok": True, "friends": []})
            elif action == "send_message":
                from_segments = payload.get("message") or []
                text = "".join(
                    (seg.get("data", {}).get("text") or "") for seg in from_segments if seg.get("type") == "text"
                ).strip()
                images = [seg.get("data", {}) for seg in from_segments if seg.get("type") == "image"]
                if images:
                    self._reply(501, {"ok": False, "error": "图片发送尚未实现（先只支持文本）"})
                    return
                if not text:
                    self._reply(400, {"ok": False, "error": "空消息"})
                    return
                self.adapter.send_text(str(payload.get("userId")), text)
                self._reply(200, {"ok": True, "messageId": int(time.time() * 1000) % 2147483647})
            else:
                self._reply(404, {"ok": False, "error": "未知 action: " + str(action)})
        except Exception as exc:
            self._reply(500, {"ok": False, "error": str(exc)})


def cmd_probe(args):
    adapter = DouyinAdapter(load_profile(args.profile), serial=args.serial, verbose=True)
    adapter.launch()
    rows = adapter.dump_texts()
    xml = adapter.device.dump_hierarchy()
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(xml)
    log("层级已写入", args.out, "，共", len(rows), "个文字节点")
    for row in rows[:60]:
        log(" ", row["bounds"], row["text"][:40])
    if args.screen:
        adapter.device.screenshot(args.screen)
        log("截图已写入", args.screen)


def cmd_screen(args):
    adapter = DouyinAdapter(load_profile(args.profile), serial=args.serial, verbose=True)
    adapter.device.screenshot(args.out)
    log("截图已写入", args.out)


def cmd_run(args):
    profile = load_profile(args.profile)
    adapter = DouyinAdapter(profile, serial=args.serial, bridge=args.bridge, dry_run=args.dry_run, verbose=args.verbose)
    if args.no_http:
        adapter.run()
        return
    handler = type("BoundHandler", (OutboundHandler,), {"adapter": adapter})
    server = ThreadingHTTPServer((args.http_host, args.http_port), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    log("出站服务已监听 http://" + args.http_host + ":" + str(args.http_port))
    try:
        adapter.run()
    except KeyboardInterrupt:
        log("收到 Ctrl-C，退出")
    finally:
        adapter.stop_event.set()
        server.shutdown()


def main():
    parser = argparse.ArgumentParser(description="抖音/多闪 Android 适配器（uiautomator2）")
    parser.add_argument("--profile", default=os.path.join(os.path.dirname(__file__), "..", "..", "profiles", "douyin.json"))
    parser.add_argument("--serial", default=None, help="adb serial，多设备时指定")
    sub = parser.add_subparsers(dest="command", required=True)

    p_probe = sub.add_parser("probe", help="导出当前界面层级 + 文字节点，用于校准选择器")
    p_probe.add_argument("--out", default="dump.xml")
    p_probe.add_argument("--screen", default=None)
    p_probe.set_defaults(func=cmd_probe)

    p_screen = sub.add_parser("screen", help="截一张当前界面")
    p_screen.add_argument("--out", default="shot.png")
    p_screen.set_defaults(func=cmd_screen)

    p_run = sub.add_parser("run", help="运行适配器（轮询收消息 + 出站发消息）")
    p_run.add_argument("--bridge", default=BRIDGE_DEFAULT)
    p_run.add_argument("--http-host", default="127.0.0.1")
    p_run.add_argument("--http-port", type=int, default=5701)
    p_run.add_argument("--no-http", action="store_true")
    p_run.add_argument("--dry-run", action="store_true")
    p_run.add_argument("--verbose", action="store_true")
    p_run.set_defaults(func=cmd_run)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
