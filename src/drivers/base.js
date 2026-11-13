import { EventEmitter } from "node:events";

/**
 * 驱动契约。任何「接入端」只要实现这 6 个方法，就能挂到 OneBot 11 桥后面。
 *  - start/stop
 *  - self（getter）
 *  - listFriends / sendPrivate / getMessage
 * 收到对方消息时调用 this.publishMessage(...)。
 */
export class BaseDriver extends EventEmitter {
  constructor(opts = {}, log = console) {
    super();
    this.opts = opts || {};
    this.log = log || console;
    this.name = "base";
    this.online = false;
    this.startedAt = 0;
    this.selfInfo = { user_id: 0, nickname: "unknown" };
  }

  get self() {
    return this.selfInfo;
  }

  async start() {
    throw new Error("driver.start() 未实现");
  }

  async stop() {
    this.online = false;
  }

  async listFriends() {
    return [];
  }

  async listGroups() {
    return [];
  }

  async getMessage() {
    return null;
  }

  async sendPrivate() {
    throw new Error("driver.sendPrivate() 未实现");
  }

  async sendGroup() {
    const error = new Error("该平台没有群聊，send_group_msg 不可用");
    error.retcode = 1400;
    throw error;
  }

  publishMessage(payload) {
    const userId = Number(payload.userId);
    this.emit("message", {
      userId: Number.isFinite(userId) ? userId : 0,
      nickname: payload.nickname || String(payload.userId || ""),
      segments: payload.segments || [],
      nativeId: payload.nativeId || "",
      timestamp: payload.timestamp || Math.floor(Date.now() / 1000),
    });
  }
}
