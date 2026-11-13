import http from "node:http";
import { BaseDriver } from "./base.js";
import { normalizeMessage } from "../onebot/segments.js";

/**
 * 通用 HTTP 驱动：把「发消息 / 列好友 / 取消息」转给外部适配器
 * （adapters/android/adapter.py 或任何实现了同样约定的进程）。
 *
 * 出站（本进程 -> 适配器, POST {outbound.url}）
 *   { action: "send_message", userId, message: [segments], replyTo }
 *   { action: "list_friends" }
 *   { action: "get_message", messageId }
 * 入站（适配器 -> 本进程, POST 到 {inbound.host}:{inbound.port}/message）
 *   { type: "message", userId, nickname, nativeId, message: [segments], timestamp }
 */
export class HttpDriver extends BaseDriver {
  constructor(opts = {}, log) {
    super(opts, log);
    this.name = "http";
    this.inbound = opts.inbound || { host: "127.0.0.1", port: 5702, token: "" };
    this.outbound = opts.outbound || { url: "http://127.0.0.1:5701", token: "", timeout: 20000 };
    this.selfInfo = opts.self || { user_id: 0, nickname: "http-adapter" };
    this.server = null;
    this.history = new Map();
  }

  get timeout() {
    if (this.outbound.timeout === undefined || this.outbound.timeout === null) return 20000;
    return Number(this.outbound.timeout);
  }

  async request(payload) {
    const headers = { "content-type": "application/json" };
    if (this.outbound.token) headers.authorization = "Bearer " + this.outbound.token;
    const response = await fetch(this.outbound.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeout),
    });
    const text = await response.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch (error) {
      throw new Error("适配器返回非 JSON（" + response.status + "）: " + text.slice(0, 200));
    }
    if (!response.ok) {
      throw new Error("适配器返回 " + response.status + (body.error ? "：" + body.error : ""));
    }
    if (body.error) throw new Error(body.error);
    return body;
  }

  async start() {
    const host = this.inbound.host || "127.0.0.1";
    const port = this.inbound.port === undefined || this.inbound.port === null ? 5702 : Number(this.inbound.port);
    this.server = http.createServer((req, res) => {
      this.handleInbound(req, res).catch((error) => {
        this.log.warn("[http-driver] 入站处理失败: " + error.message);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: error.message }));
        }
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => resolve(undefined));
    });
    this.online = true;
    this.startedAt = Date.now();
    this.log.info("[http] 适配器入站监听 http://" + host + ":" + port + "，出站 " + this.outbound.url);
  }

  inboundAuthorized(req) {
    const token = this.inbound.token;
    if (!token) return true;
    const header = String(req.headers.authorization || "").replace(/^(Bearer|Token)\s+/i, "").trim();
    return header === token;
  }

  async handleInbound(req, res) {
    res.setHeader("content-type", "application/json; charset=utf-8");
    if (req.method === "GET") {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, driver: this.name, online: this.online }));
      return;
    }
    if (!this.inboundAuthorized(req)) {
      res.writeHead(401);
      res.end(JSON.stringify({ ok: false, error: "token 无效" }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch (error) {
      res.writeHead(400);
      res.end(JSON.stringify({ ok: false, error: "不是合法 JSON" }));
      return;
    }
    this.online = true;
    if (payload.type === "message") {
      const segments = normalizeMessage(payload.message);
      const nativeId = payload.nativeId || "";
      if (nativeId) {
        this.history.set(nativeId, {
          user_id: Number(payload.userId) || 0,
          nickname: payload.nickname || "",
          message: segments,
          time: payload.timestamp || Math.floor(Date.now() / 1000),
        });
      }
      this.publishMessage({
        userId: payload.userId,
        nickname: payload.nickname,
        segments,
        nativeId,
        timestamp: payload.timestamp,
      });
    } else if (payload.type === "notice") {
      this.emit("notice", payload);
    }
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
  }

  async listFriends() {
    try {
      const body = await this.request({ action: "list_friends" });
      return Array.isArray(body.friends) ? body.friends : [];
    } catch (error) {
      this.log.warn("[http] list_friends 失败: " + error.message);
      return [];
    }
  }

  async sendPrivate(userId, segments) {
    const body = await this.request({
      action: "send_message",
      userId: Number(userId),
      message: segments,
    });
    return { message_id: Number(body.messageId) || 0 };
  }

  async getMessage(messageId) {
    const hit = this.history.get(String(messageId)) || this.history.get(Number(messageId));
    if (hit) return hit;
    try {
      const body = await this.request({ action: "get_message", messageId: Number(messageId) });
      return body.message || null;
    } catch (error) {
      return null;
    }
  }

  async stop() {
    this.online = false;
    if (this.server) {
      await new Promise((resolve) => this.server.close(() => resolve(undefined)));
      this.server = null;
    }
  }
}
