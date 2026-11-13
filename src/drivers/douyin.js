import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { BaseDriver } from "./base.js";


function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const id = (hash & 0x7fffffff) || 1;
  return id;
}

function messageText(error) {
  if (!error) return "未知错误";
  return String(error.message || error);
}

export class DouyinDriver extends BaseDriver {
  constructor(opts = {}, log = console) {
    super(opts, log);
    this.name = "douyin";
    this.opts = opts || {};
    this.sdk = this.opts.sdk || null;
    this.client = null;
    this.account = null;
    this.dataDir = resolve(this.opts.dataDir || "data");
    this.qrcodeFile = resolve(this.opts.qrcodeFile || "data/login.png");
    this.qrcodeBuffer = null;
    this.verificationUrl = "";
    this.loginState = "idle";
    this.loginError = null;
    this.loginTask = null;
    this.smsAccount = null;
    this.smsQueue = [];
    this.messageSeq = 1;
    this.messages = new Map();
    this.friends = new Map();
    this.groups = new Map();
    this.fetchImpl = this.opts.fetch || globalThis.fetch;
  }

  stableId(value) {
    const text = String(value === undefined || value === null ? "" : value);
    if (!text) return 0;
    if (/^\d+$/.test(text)) {
      const numeric = Number(text);
      if (Number.isSafeInteger(numeric) && numeric > 0) return numeric;
    }
    return fnv1a(text);
  }

  async loadSdk() {
    if (this.sdk) return this.sdk;
    this.sdk = await import("douyin-im");
    return this.sdk;
  }

  async start() {
    const sdk = await this.loadSdk();
    if (typeof sdk.configureLogger === "function") {
      sdk.configureLogger({ level: this.opts.logLevel || "warn", color: false });
    }
    mkdirSync(this.dataDir, { recursive: true });
    const options = { dataDir: this.dataDir, autoLoad: true };
    if (this.opts.skipVerify) options.skipVerify = true;
    if (this.opts.localState !== undefined) options.localState = this.opts.localState;
    this.client = sdk.createClient(options);
    this.bind(this.client);
    this.startedAt = Date.now();
    this.online = false;
    this.loginState = "logging-in";
    this.loginTask = this.client
      .login()
      .then(() => {
        this.log.info("[douyin] login() 完成");
      })
      .catch((error) => {
        this.loginState = "error";
        this.loginError = messageText(error);
        this.online = false;
        this.log.error("[douyin] 登录失败: " + this.loginError);
        this.emit("login", { stage: "error", error: this.loginError });
      });
    return this;
  }

  bind(client) {
    const on = (name, fn) => {
      try {
        client.on(name, fn);
      } catch (error) {
        this.log.debug("[douyin] 事件 " + name + " 绑定失败: " + messageText(error));
      }
    };

    on("system.login.qrcode", async (payload) => {
      const account = payload && payload.account;
      const base64 = payload && payload.qrcodeBase64;
      this.loginState = "waiting-qrcode";
      if (base64) {
        this.qrcodeBuffer = Buffer.from(String(base64), "base64");
        try {
          mkdirSync(dirname(this.qrcodeFile), { recursive: true });
          writeFileSync(this.qrcodeFile, this.qrcodeBuffer, { mode: 0o600 });
        } catch (error) {
          this.log.warn("[douyin] 二维码写盘失败: " + messageText(error));
        }
      }
      this.emit("login", { stage: "qrcode", file: this.qrcodeBuffer ? this.qrcodeFile : "", buffer: this.qrcodeBuffer });
      this.log.info("[douyin] 需要扫码：二维码已写入 " + this.qrcodeFile + "（也可访问 OneBot 端口的 /qrcode 查看）");
      if (account && typeof account.continueLogin === "function") {
        account.continueLogin().catch((error) => this.log.warn("[douyin] continueLogin 失败: " + messageText(error)));
      }
    });

    on("system.login.sms", (payload) => this.waitSms(payload && payload.account, "sms"));
    on("system.login.voice", (payload) => this.waitSms(payload && payload.account, "voice"));

    on("system.login.verification", async (payload) => {
      const verification = payload && payload.verification;
      this.loginState = "waiting-verification";
      let url = "";
      try {
        if (verification && typeof verification.openUrl === "function") {
          const opened = await verification.openUrl({ openBrowser: !!this.opts.autoOpenVerification });
          if (typeof opened === "string") url = opened;
          else if (opened && typeof opened.url === "string") url = opened.url;
        } else if (verification && typeof verification.open === "function") {
          await verification.open();
        }
      } catch (error) {
        this.log.warn("[douyin] 打开验证页失败: " + messageText(error));
      }
      this.verificationUrl = url;
      this.emit("login", { stage: "verification", url });
      this.log.warn("[douyin] 平台要求安全验证，请打开验证页完成: " + (url || "(已尝试自动打开)") );
    });

    on("system.online", (payload) => {
      const account = (payload && payload.account) || this.account;
      this.account = account || this.account;
      this.online = true;
      this.loginState = "online";
      this.loginError = null;
      this.qrcodeBuffer = null;
      const uid = account && account.uid ? String(account.uid) : "";
      const nickname = (account && (account.nickname || (account.profile && account.profile.nickname))) || "douyin-bot";
      this.selfInfo = { user_id: this.stableId(uid) || 0, nickname, uid };
      this.log.info("[douyin] 已上线: " + nickname + " (" + (uid || "unknown uid") + ")");
      this.emit("online", this.selfInfo);
    });

    const onMessage = (event) => {
      try {
        this.onMessageEvent(event);
      } catch (error) {
        this.log.warn("[douyin] 处理消息出错: " + messageText(error));
      }
    };
    on("message.private", onMessage);
    on("message.stranger", onMessage);
    on("message.group", onMessage);

    const onNotice = (event) => {
      try {
        this.onNoticeEvent(event);
      } catch (error) {
        this.log.debug("[douyin] 处理通知出错: " + messageText(error));
      }
    };
    on("notice.friend.increase", onNotice);
    on("notice.friend.decrease", onNotice);
    on("notice.group.member-increase", onNotice);
    on("notice.group.member-decrease", onNotice);
    on("notice.message.recall", onNotice);
    on("notice", onNotice);

    on("system.login.error", (payload) => {
      this.loginState = "error";
      this.loginError = messageText(payload && payload.error);
      this.log.error("[douyin] 登录错误: " + this.loginError);
      this.emit("login", { stage: "error", error: this.loginError });
    });

    on("system.handler.error", (payload) => {
      this.log.warn("[douyin] 事件处理失败: " + messageText(payload && payload.error));
    });

    on("request", (request) => {
      this.log.info("[douyin] 收到待审核申请: " + messageText(request && request.type));
      this.emit("notice", { noticeType: "friend_add_request", userId: 0, subType: String((request && request.type) || "") });
    });
  }

  waitSms(account, channel) {
    this.loginState = "waiting-sms";
    this.smsAccount = account || this.smsAccount;
    this.emit("login", { stage: "sms", channel });
    this.log.warn("[douyin] 需要短信验证码（" + channel + "）: 调用 submitSmsCode(code) 或 POST OneBot 端口 /login/sms");
    const queued = this.smsQueue.shift();
    if (queued) this.continueSms(queued);
  }

  submitSmsCode(code) {
    const text = String(code === undefined || code === null ? "" : code).trim();
    if (!text) throw new Error("验证码为空");
    if (!this.smsAccount) {
      this.smsQueue.push(text);
      this.log.info("[douyin] 已暂存验证码，等待平台发起短信验证");
      return { accepted: true, queued: true };
    }
    this.continueSms(text);
    return { accepted: true, queued: false };
  }

  continueSms(code) {
    const account = this.smsAccount;
    this.smsAccount = null;
    if (!account || typeof account.continueLoginWithSms !== "function") {
      this.log.warn("[douyin] 当前没有可用的短信登录会话，验证码被丢弃");
      return;
    }
    account.continueLoginWithSms(code).catch((error) => {
      this.loginState = "error";
      this.loginError = messageText(error);
      this.log.error("[douyin] 提交验证码失败: " + this.loginError);
      this.emit("login", { stage: "error", error: this.loginError });
    });
  }

  loginStatus() {
    return {
      state: this.loginState,
      online: !!this.online,
      error: this.loginError,
      qrcode: this.qrcodeBuffer ? "ready" : "",
      qrcode_file: this.qrcodeBuffer ? this.qrcodeFile : "",
      verification_url: this.verificationUrl,
      self_id: Number(this.selfInfo && this.selfInfo.user_id) || 0,
      nickname: (this.selfInfo && this.selfInfo.nickname) || "",
    };
  }

  async waitOnline(timeoutMs) {
    if (this.online) return true;
    const limit = Number(timeoutMs) || 0;
    if (limit > 0) {
      const deadline = Date.now() + limit;
      while (Date.now() < deadline && !this.online && this.loginState !== "error") {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
      }
    }
    return this.online;
  }

  channelText(content) {
    if (!content) return "";
    if (content.kind === "image") return "[图片]";
    if (content.kind === "video") return "[视频]";
    if (content.kind === "emoji") return "[表情]";
    if (content.kind === "audio") return "[语音]";
    if (content.kind === "file") return "[文件]";
    if (content.kind === "share" || content.kind === "comment") return "[作品]";
    return String(content.text || "");
  }

  toSegments(event) {
    const content = event && event.content;
    const segments = [];
    const text = String((event && event.text) || "");
    if (content && content.kind === "image") {
      const image = content.image || {};
      const urls = [].concat(image.largeUrls || [], image.originUrls || [], image.thumbUrls || []);
      segments.push({ type: "image", data: { url: urls[0] || "", file: String(image.oid || ""), md5: String(image.md5 || "") } });
      if (text) segments.push({ type: "text", data: { text } });
      return segments;
    }
    if (content && content.kind === "emoji") {
      segments.push({ type: "image", data: { url: String(content.url || ""), sub_type: "emoji" } });
      if (text) segments.push({ type: "text", data: { text } });
      return segments;
    }
    if (content && (content.kind !== "text" && content.kind !== "unknown")) {
      const fallback = this.channelText(content);
      const merged = text && text !== fallback ? text + " " + fallback : (text || fallback);
      if (merged) segments.push({ type: "text", data: { text: merged } });
      return segments;
    }
    if (text) segments.push({ type: "text", data: { text } });
    return segments;
  }

  nicknameOf(contact, fallbackUid) {
    if (contact) {
      const name = contact.remark || contact.nickname || contact.name;
      if (name) return String(name);
    }
    return String(fallbackUid || "");
  }

  onMessageEvent(event) {
    const chatType = String((event && event.chatType) || "private");
    const isGroup = chatType === "group";
    const contact = isGroup ? event.group : event.friend || event.stranger;
    const senderUid = String((event && event.senderUid) || (contact && (contact.uid || contact.groupId)) || "");
    const userId = this.stableId(senderUid);
    const groupId = isGroup ? this.stableId(contact && (contact.groupId || contact.id) || (event && event.threadId) || "") : 0;
    const nickname = this.nicknameOf(contact, senderUid);
    const segments = this.toSegments(event);
    const messageId = this.messageSeq++;
    const record = {
      message_id: messageId,
      user_id: userId,
      nickname,
      message: segments,
      time: Math.floor(Date.now() / 1000),
      messageType: isGroup ? "group" : "private",
      groupId,
      uid: senderUid,
      nativeId: String((event && (event.serverMessageId || event.clientMessageId)) || ""),
    };
    this.messages.set(messageId, record);
    if (this.messages.size > 1000) {
      const oldest = this.messages.keys().next();
      if (!oldest.done) this.messages.delete(oldest.value);
    }
    this.log.info("[收] " + (isGroup ? "群 " + groupId + " / " : "") + nickname + ": " + this.segmentText(segments).slice(0, 80));
    this.emit("message", {
      userId,
      nickname,
      segments,
      nativeId: record.nativeId,
      timestamp: record.time,
      messageType: isGroup ? "group" : "private",
      subType: isGroup ? "normal" : (chatType === "stranger" ? "stranger" : "friend"),
      groupId,
    });
  }

  segmentText(segments) {
    const parts = [];
    for (const item of segments || []) {
      if (item.type === "text") parts.push(String((item.data && item.data.text) || ""));
      else if (item.type === "image") parts.push("[图片]");
      else if (item.type === "at") parts.push("@" + String((item.data && item.data.name) || ""));
    }
    return parts.join("");
  }

  onNoticeEvent(event) {
    const kind = String((event && event.type) || "");
    this.emit("notice", {
      noticeType: kind.replace(/\./g, "_") || "unknown",
      subType: kind,
      userId: this.stableId((event && (event.senderUid || event.operatorUid)) || (event && event.account && event.account.uid) || ""),
    });
  }

  requireAccount() {
    if (!this.account) {
      const error = new Error("抖音账号尚未登录完成，暂时无法发送消息");
      error.retcode = 1401;
      throw error;
    }
    return this.account;
  }

  findContact(userId, wantGroup) {
    const account = this.account;
    if (!account) return null;
    const source = wantGroup ? account.gl : account.fl;
    if (source && typeof source.forEach === "function") {
      let hit = null;
      source.forEach((contact) => {
        const key = wantGroup ? contact.groupId || contact.id : contact.uid;
        if (this.stableId(key) === Number(userId)) hit = contact;
      });
      if (hit) return hit;
    }
    const strangers = account.sl;
    if (!wantGroup && strangers && typeof strangers.forEach === "function") {
      let hit = null;
      strangers.forEach((contact) => {
        if (this.stableId(contact.uid) === Number(userId)) hit = contact;
      });
      if (hit) return hit;
    }
    return null;
  }

  async resolveContact(userId, wantGroup) {
    const cached = this.findContact(userId, wantGroup);
    if (cached) return cached;
    const account = this.requireAccount();
    if (wantGroup) {
      await account.getGroupList(true).catch(() => []);
    } else {
      await account.getFriendList().catch(() => []);
      if (typeof account.getStrangerList === "function") await account.getStrangerList().catch(() => []);
    }
    const found = this.findContact(userId, wantGroup);
    if (!found) {
      const error = new Error((wantGroup ? "找不到该群聊: " : "找不到该好友或会话: ") + userId);
      error.retcode = 1404;
      throw error;
    }
    return found;
  }

  async imageBytes(url) {
    if (!url) return null;
    if (String(url).startsWith("base64://")) return Buffer.from(String(url).slice(9), "base64");
    if (String(url).startsWith("data:")) {
      const comma = String(url).indexOf(",");
      if (comma < 0) return null;
      return Buffer.from(String(url).slice(comma + 1), "base64");
    }
    const response = await this.fetchImpl(String(url));
    if (!response || !response.ok) throw new Error("图片下载失败: " + url);
    return Buffer.from(await response.arrayBuffer());
  }

  async toSendable(segments, groupContact) {
    const sdk = await this.loadSdk();
    const parts = [];
    for (const segment of segments || []) {
      const type = String(segment.type || "text");
      const data = segment.data || {};
      if (type === "text") {
        if (data.text !== undefined && data.text !== "") parts.push(String(data.text));
      } else if (type === "at") {
        const uid = String(data.uid || data.qq || "");
        if (!uid) continue;
        if (groupContact && typeof sdk.segment === "object" && typeof sdk.segment.at === "function") {
          parts.push(sdk.segment.at(uid, String(data.name || "")));
        } else {
          parts.push("@" + String(data.name || uid) + " ");
        }
      } else if (type === "image") {
        const bytes = await this.imageBytes(data.url || data.file || "");
        if (bytes) {
          if (sdk.segment && typeof sdk.segment.image === "function") parts.push(sdk.segment.image(bytes));
          else parts.push({ type: "image", data: bytes });
        } else if (data.url) {
          parts.push("[图片]" + data.url);
        }
      } else if (type === "face") {
        parts.push("[表情]");
      } else {
        const text = data.text || data.url || "";
        if (text) parts.push(String(text));
      }
    }
    if (parts.length === 0) {
      const error = new Error("消息内容为空");
      error.retcode = 1400;
      throw error;
    }
    const textsOnly = parts.every((item) => typeof item === "string");
    if (textsOnly) return parts.join("");
    return parts.map((item) => (typeof item === "string" ? { type: "text", text: item } : item));
  }

  async sendPrivate(userId, segments) {
    const contact = await this.resolveContact(Number(userId), false);
    const payload = await this.toSendable(segments, null);
    const response = await contact.sendMsg(payload);
    const messageId = this.messageSeq++;
    this.log.info("[发] private -> " + userId + ": " + this.segmentText(segments).slice(0, 60));
    return { message_id: messageId, native: response };
  }

  async sendGroup(groupId, segments) {
    const contact = await this.resolveContact(Number(groupId), true);
    const payload = await this.toSendable(segments, contact);
    const response = await contact.sendMsg(payload);
    const messageId = this.messageSeq++;
    this.log.info("[发] group " + groupId + ": " + this.segmentText(segments).slice(0, 60));
    return { message_id: messageId, native: response };
  }

  async listFriends() {
    const account = this.account;
    if (!account) return [];
    this.friends.clear();
    const list = await account.getFriendList().catch(() => []);
    const out = [];
    for (const friend of list || []) {
      const userId = this.stableId(friend.uid);
      const nickname = this.nicknameOf(friend, friend.uid);
      this.friends.set(userId, friend);
      out.push({ user_id: userId, nickname, remark: friend.remark || "" });
    }
    return out;
  }

  async listGroups() {
    const account = this.account;
    if (!account) return [];
    this.groups.clear();
    const list = await account.getGroupList().catch(() => []);
    const out = [];
    for (const group of list || []) {
      const groupId = this.stableId(group.groupId || group.id);
      const name = this.nicknameOf(group, group.groupId);
      this.groups.set(groupId, group);
      out.push({ group_id: groupId, group_name: name, member_count: group.memberCount || 0 });
    }
    return out;
  }

  async getMessage(messageId) {
    return this.messages.get(Number(messageId)) || null;
  }

  async stop() {
    this.online = false;
    const client = this.client;
    this.client = null;
    if (client && typeof client.logout === "function") {
      try {
        await client.logout();
      } catch (error) {
        this.log.warn("[douyin] 退出登录失败: " + messageText(error));
      }
    }
  }
}

export default DouyinDriver;