import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { createActions } from "./actions.js";
import { plainText } from "./segments.js";

const VERSION_HEADERS = { "x-onebot-bridge": "onebot-douyin-bridge" };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const NUMBER_KEYS = new Set(["user_id", "group_id", "message_id", "self_id", "operator_id", "duration", "count", "timeout"]);

export function coerceParams(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return {};
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    if (value && typeof value === "object") {
      out[key] = value;
    } else if (typeof value === "string" && NUMBER_KEYS.has(key) && /^-?\d+$/.test(value)) {
      out[key] = Number(value);
    } else if (value === "true" || value === "false") {
      out[key] = value === "true";
    } else {
      out[key] = value;
    }
  }
  return out;
}

export class OneBotServer {
  constructor(ctx) {
    // ctx: { config, driver, factory, log }
    this.config = ctx.config;
    this.driver = ctx.driver;
    this.factory = ctx.factory;
    this.log = ctx.log;
    this.actions = createActions(ctx);
    this.clients = new Set();
    this.reverse = null;
    this.reverseTimer = null;
    this.heartbeatTimer = null;
    this.reconnectDelay = 1000;
    this.httpServer = null;
    this.wss = null;
    this.stopping = false;
    this.messageSeq = 1;
    if (this.driver && typeof this.driver.on === "function") {
      this.driver.on("online", (info) => {
        if (info && info.user_id) this.factory.setSelfId(info.user_id);
      });
      this.driver.on("message", (msg) => this.onDriverMessage(msg));
      this.driver.on("notice", (payload) => this.onDriverNotice(payload));
    }
  }

  onDriverMessage(msg) {
    const messageType = msg.messageType === "group" ? "group" : "private";
    const event = this.factory.message({
      userId: msg.userId,
      nickname: msg.nickname,
      messageId: this.messageSeq++,
      segments: msg.segments,
      messageType,
      subType: msg.subType || (messageType === "group" ? "normal" : "friend"),
      targetId: messageType === "group" ? msg.groupId : msg.userId,
      timestamp: msg.timestamp,
    });
    if (messageType === "group") event.group_id = Number(msg.groupId) || 0;
    this.log.info("[收] " + (messageType === "group" ? "群 " + event.group_id + " / " : "") + msg.userId + " (" + msg.nickname + "): " + plainText(msg.segments).slice(0, 100));
    this.publish(event);
  }

  onDriverNotice(payload) {
    this.publish(
      this.factory.notice({
        noticeType: payload.noticeType || "unknown",
        subType: payload.subType,
        userId: payload.userId,
        messageId: payload.messageId,
        operatorId: payload.operatorId,
      })
    );
  }

  get token() {
    return (this.config.onebot && this.config.onebot.access_token) || "";
  }

  authorized(req) {
    if (!this.token) return true;
    const header = String(req.headers.authorization || "");
    const bearer = header.replace(/^(Bearer|Token)\s+/i, "").trim();
    if (bearer && bearer === this.token) return true;
    const url = new URL(req.url || "/", "http://localhost");
    const queryToken = url.searchParams.get("access_token");
    return queryToken === this.token;
  }

  async start() {
    const onebot = this.config.onebot || {};
    const host = onebot.host || "127.0.0.1";
    const port = onebot.port === undefined || onebot.port === null ? 5700 : Number(onebot.port);

    this.httpServer = http.createServer((req, res) => {
      this.handleHttp(req, res).catch((error) => {
        this.log.error("[http] 处理失败: " + (error && error.message));
        if (!res.headersSent) this.sendJson(res, 500, { status: "failed", retcode: 1500, data: null });
      });
    });

    this.wss = new WebSocketServer({ noServer: true });
    this.httpServer.on("upgrade", (req, socket, head) => {
      if (!this.authorized(req)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.attachClient(ws));
    });

    await new Promise((resolve, reject) => {
      this.httpServer.once("error", reject);
      this.httpServer.listen(port, host, () => resolve(undefined));
    });
    this.log.info("[onebot] HTTP/WS 已监听 http://" + host + ":" + port);

    this.startHeartbeat();
    this.startReverse();
  }

  sendJson(res, code, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", ...VERSION_HEADERS });
    res.end(body);
  }

  async handleHttp(req, res) {
    if (!this.authorized(req)) {
      this.sendJson(res, 401, { status: "failed", retcode: 1403, data: null, msg: "access_token 无效" });
      return;
    }
    const url = new URL(req.url || "/", "http://localhost");
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    if (pathname === "/qrcode" || pathname === "/qrcode.png") {
      const buffer = this.driver && this.driver.qrcodeBuffer;
      if (!buffer) {
        this.sendJson(res, 404, { status: "failed", retcode: 1404, data: null, msg: "暂无待扫码的二维码，先确认 driver.type=douyin 且已启动" });
        return;
      }
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store", ...VERSION_HEADERS });
      res.end(buffer);
      return;
    }

    if (pathname === "/login/status") {
      const status = typeof this.driver.loginStatus === "function" ? this.driver.loginStatus() : { state: "unsupported" };
      this.sendJson(res, 200, { status: "ok", retcode: 0, data: status });
      return;
    }

    if (pathname === "/login/sms" && req.method === "POST") {
      if (typeof this.driver.submitSmsCode !== "function") {
        this.sendJson(res, 400, { status: "failed", retcode: 1400, data: null, msg: "当前驱动不支持短信登录" });
        return;
      }
      let code = url.searchParams.get("code") || "";
      if (!code) {
        try {
          const raw = await readBody(req);
          const payload = raw ? JSON.parse(raw) : {};
          code = String(payload.code || payload.sms_code || "");
        } catch (error) {
          this.sendJson(res, 400, { status: "failed", retcode: 1400, data: null, msg: "请求体不是合法 JSON" });
          return;
        }
      }
      try {
        const result = this.driver.submitSmsCode(code);
        this.sendJson(res, 200, { status: "ok", retcode: 0, data: result || {} });
      } catch (error) {
        this.sendJson(res, 400, { status: "failed", retcode: 1400, data: null, msg: String((error && error.message) || error) });
      }
      return;
    }

    if (pathname === "/" && req.method === "GET") {
      this.sendJson(res, 200, {
        status: "ok",
        retcode: 0,
        data: {
          app: "onebot-douyin-bridge",
          protocol: "OneBot 11",
          driver: this.driver.name,
          self_id: Number(this.driver.self.user_id) || 0,
        },
      });
      return;
    }

    let action = pathname.slice(1);
    let params = {};

    if (action === "api" || action === "") {
      if (req.method === "POST") {
        const raw = await readBody(req);
        let payload = {};
        try {
          payload = raw ? JSON.parse(raw) : {};
        } catch (error) {
          this.sendJson(res, 400, { status: "failed", retcode: 1400, data: null, msg: "请求体不是合法 JSON" });
          return;
        }
        action = payload.action || url.searchParams.get("action") || "";
        params = payload.params || {};
        if (payload.echo !== undefined) params.echo = payload.echo;
      } else {
        action = url.searchParams.get("action") || "";
      }
    } else if (req.method === "POST") {
      const raw = await readBody(req);
      if (raw) {
        try {
          const payload = JSON.parse(raw);
          params = payload.params || payload;
          if (payload.echo !== undefined) params.echo = payload.echo;
        } catch (error) {
          params = Object.fromEntries(url.searchParams.entries());
        }
      }
    } else {
      params = Object.fromEntries(url.searchParams.entries());
    }

    if (!action) {
      this.sendJson(res, 404, { status: "failed", retcode: 1404, data: null, msg: "缺少 action" });
      return;
    }

    const echo = params.echo;
    const result = await this.dispatch(action, coerceParams(params));
    this.sendJson(res, 200, { ...result, echo: echo === undefined ? null : echo });
  }

  async dispatch(action, params) {
    const handler = this.actions[action];
    if (typeof handler !== "function") {
      return { status: "failed", retcode: 1404, data: null, msg: "不支持的 action: " + action };
    }
    try {
      const data = await handler(params);
      return { status: "ok", retcode: 0, data: data === undefined ? null : data };
    } catch (error) {
      this.log.warn("[action] " + action + " 失败: " + (error && error.message));
      return {
        status: "failed",
        retcode: Number(error && error.retcode) || 1500,
        data: null,
        msg: String((error && error.message) || error),
      };
    }
  }

  attachClient(ws) {
    this.clients.add(ws);
    this.log.info("[ws] 客户端接入，当前 " + this.clients.size + " 个");
    this.sendTo(ws, this.factory.metaLifecycle("connect"));
    ws.on("message", async (raw) => {
      let payload;
      try {
        payload = JSON.parse(String(raw));
      } catch (error) {
        this.sendTo(ws, { status: "failed", retcode: 1400, echo: null, msg: "不是合法 JSON" });
        return;
      }
      const result = await this.dispatch(payload.action, coerceParams(payload.params || {}));
      this.sendTo(ws, { ...result, echo: payload.echo === undefined ? null : payload.echo });
    });
    ws.on("close", () => {
      this.clients.delete(ws);
      this.log.info("[ws] 客户端断开，剩 " + this.clients.size + " 个");
    });
    ws.on("error", (error) => {
      this.log.warn("[ws] 客户端错误: " + error.message);
    });
  }

  sendTo(ws, payload) {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch (error) {
      this.log.warn("[ws] 发送失败: " + error.message);
    }
  }

  syncSelfId() {
    const live = this.driver && this.driver.selfInfo && this.driver.selfInfo.user_id;
    if (live && Number(live) !== this.factory.selfId) this.factory.setSelfId(live);
  }

  publish(event) {
    this.syncSelfId();
    const targets = [...this.clients];
    if (this.reverse && this.reverse.readyState === WebSocket.OPEN) targets.push(this.reverse);
    for (const ws of targets) this.sendTo(ws, event);
  }

  startHeartbeat() {
    const interval = Number((this.config.onebot && this.config.onebot.heartbeat_interval) || 30000);
    if (interval <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      this.publish(this.factory.metaHeartbeat(interval, { online: !!this.driver.online, good: !!this.driver.online }));
    }, interval);
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  startReverse() {
    const list = (this.config.onebot && this.config.onebot.reverse_ws) || [];
    const target = list.find((item) => item && item.enabled !== false && item.url);
    if (!target) return;
    this.reverseUrl = target.url;
    this.reverseToken = target.access_token || this.token;
    this.connectReverse();
  }

  connectReverse() {
    if (this.stopping || !this.reverseUrl) return;
    const url = new URL(this.reverseUrl);
    if (this.reverseToken) url.searchParams.set("access_token", this.reverseToken);
    this.log.info("[reverse] 连接 " + url.toString());
    const ws = new WebSocket(url.toString());
    this.reverse = ws;

    ws.on("open", () => {
      this.reconnectDelay = 1000;
      this.log.info("[reverse] 已连接");
      this.sendTo(ws, this.factory.metaLifecycle("connect"));
    });

    ws.on("message", async (raw) => {
      let payload;
      try {
        payload = JSON.parse(String(raw));
      } catch (error) {
        return;
      }
      const result = await this.dispatch(payload.action, coerceParams(payload.params || {}));
      this.sendTo(ws, { ...result, echo: payload.echo === undefined ? null : payload.echo });
    });

    ws.on("close", () => {
      this.log.warn("[reverse] 断开，" + Math.round(this.reconnectDelay / 1000) + " 秒后重连");
      if (this.stopping) return;
      this.reverseTimer = setTimeout(() => this.connectReverse(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60000);
    });

    ws.on("error", (error) => {
      this.log.warn("[reverse] 错误: " + error.message);
    });
  }

  async stop() {
    this.stopping = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reverseTimer) clearTimeout(this.reverseTimer);
    for (const ws of this.clients) {
      try {
        ws.close();
      } catch (error) {
        /* ignore */
      }
    }
    this.clients.clear();
    if (this.reverse) {
      try {
        this.reverse.close();
      } catch (error) {
        /* ignore */
      }
    }
    if (this.wss) this.wss.close();
    if (this.httpServer) {
      await new Promise((resolve) => this.httpServer.close(() => resolve(undefined)));
    }
  }
}