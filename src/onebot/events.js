import { toCQ } from "./segments.js";

export class EventFactory {
  constructor(selfId, messageFormat) {
    this.selfId = Number(selfId) || 0;
    this.format = messageFormat === "string" ? "string" : "array";
  }

  setSelfId(selfId) {
    this.selfId = Number(selfId) || 0;
  }

  base(postType) {
    return { time: Math.floor(Date.now() / 1000), self_id: this.selfId, post_type: postType };
  }

  message(input) {
    const segments = input.segments || [];
    return {
      ...this.base("message"),
      message_type: input.messageType || "private",
      sub_type: input.subType || "friend",
      message_id: Number(input.messageId) || 0,
      user_id: Number(input.userId) || 0,
      target_id: Number(input.targetId || input.userId) || 0,
      message: this.format === "string" ? toCQ(segments) : segments,
      raw_message: toCQ(segments),
      font: 0,
      sender: {
        user_id: Number(input.userId) || 0,
        nickname: input.nickname || String(input.userId || ""),
        card: "",
        sex: "unknown",
        age: 0,
      },
    };
  }

  notice(input) {
    return {
      ...this.base("notice"),
      notice_type: input.noticeType,
      sub_type: input.subType || "",
      user_id: Number(input.userId) || 0,
      message_id: input.messageId === undefined ? undefined : Number(input.messageId),
      operator_id: input.operatorId === undefined ? undefined : Number(input.operatorId),
    };
  }

  metaLifecycle(subType) {
    return { ...this.base("meta_event"), meta_event_type: "lifecycle", sub_type: subType };
  }

  metaHeartbeat(interval, status) {
    return {
      ...this.base("meta_event"),
      meta_event_type: "heartbeat",
      interval: Number(interval) || 30000,
      status: status || { online: true, good: true },
    };
  }
}
