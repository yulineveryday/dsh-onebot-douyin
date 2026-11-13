import { BaseDriver } from "./base.js";
import { normalizeMessage, plainText } from "../onebot/segments.js";

/** 离线自测驱动：不连任何 App，用 inject() 模拟对方发消息。 */
export class MockDriver extends BaseDriver {
  constructor(opts = {}, log) {
    super(opts, log);
    this.name = "mock";
    this.friends = [...(opts.friends || [])];
    this.sent = [];
    this.history = new Map();
    this.nextId = 1000;
    this.selfInfo = opts.self || { user_id: 10000, nickname: "mock-bot" };
  }

  async start() {
    this.online = true;
    this.startedAt = Date.now();
    this.log.info("[mock] 已启动，self_id=" + this.selfInfo.user_id);
  }

  async listFriends() {
    return this.friends.map((friend) => ({
      user_id: Number(friend.user_id),
      nickname: friend.nickname || String(friend.user_id),
      remark: friend.remark || "",
    }));
  }

  async sendPrivate(userId, segments) {
    const messageId = this.nextId++;
    const record = {
      user_id: Number(userId),
      message: segments,
      message_id: messageId,
      time: Math.floor(Date.now() / 1000),
    };
    this.sent.push(record);
    this.history.set(messageId, record);
    this.log.info("[mock] 发出 -> " + userId + ": " + plainText(segments));
    return { message_id: messageId };
  }

  async getMessage(messageId) {
    return this.history.get(Number(messageId)) || null;
  }

  /** 测试用：模拟一条对方发来的消息 */
  inject(userId, input, nickname) {
    this.publishMessage({
      userId,
      nickname: nickname || "user-" + userId,
      segments: normalizeMessage(input),
      nativeId: "mock-" + this.nextId++,
    });
  }
}
