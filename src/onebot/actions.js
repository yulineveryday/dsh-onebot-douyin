import { normalizeMessage, toCQ, plainText } from "./segments.js";

const APP_NAME = "onebot-douyin-bridge";
const APP_VERSION = "0.1.0";

export function createActions(ctx) {
  const { driver, factory, config, log } = ctx;

  function toSegments(params) {
    const raw = params.message !== undefined ? params.message : "";
    if (typeof raw === "string" && params.auto_escape === true) {
      return [{ type: "text", data: { text: raw } }];
    }
    return normalizeMessage(raw);
  }

  function requireUserId(params) {
    const id = Number(params.user_id);
    if (!Number.isFinite(id) || id <= 0) {
      const err = new Error("缺少 user_id");
      err.retcode = 1400;
      throw err;
    }
    return id;
  }

  async function doSend(params, messageType) {
    const userId = requireUserId(params);
    const segments = toSegments(params);
    const result = await driver.sendPrivate(userId, segments);
    log.info("发送 private -> " + userId + ": " + plainText(segments).slice(0, 60));
    return { message_id: Number((result && result.message_id) || 0) };
  }

  return {
    async get_login_info() {
      return {
        user_id: Number(driver.self.user_id) || 0,
        nickname: driver.self.nickname || "unknown",
      };
    },

    async get_status() {
      return {
        online: !!driver.online,
        good: !!driver.online,
        driver: driver.name,
        uptime: driver.startedAt ? Math.floor((Date.now() - driver.startedAt) / 1000) : 0,
      };
    },

    async get_version_info() {
      return {
        app_name: APP_NAME,
        app_version: APP_VERSION,
        protocol_version: "v11",
        extra: { driver: driver.name },
      };
    },

    async can_send_image() {
      return { yes: true };
    },

    async can_send_record() {
      return { yes: false };
    },

    async get_friend_list() {
      return await driver.listFriends();
    },

    async get_group_list() {
      if (typeof driver.listGroups !== "function") return [];
      return await driver.listGroups();
    },

    async get_stranger_info(params) {
      const userId = requireUserId(params);
      const friends = await driver.listFriends();
      const hit = friends.find((item) => Number(item.user_id) === userId);
      return {
        user_id: userId,
        nickname: (hit && hit.nickname) || String(userId),
        sex: "unknown",
        age: 0,
      };
    },

    async send_private_msg(params) {
      return await doSend(params, "private");
    },

    async send_msg(params) {
      const messageType = params.message_type || (params.group_id ? "group" : "private");
      if (messageType === "group") {
        const groupId = Number(params.group_id);
        if (!Number.isFinite(groupId) || groupId <= 0) {
          const err = new Error("缺少 group_id");
          err.retcode = 1400;
          throw err;
        }
        if (typeof driver.sendGroup !== "function") {
          const err = new Error("当前驱动不支持群聊");
          err.retcode = 1400;
          throw err;
        }
        const segments = toSegments(params);
        const result = await driver.sendGroup(groupId, segments);
        log.info("发送 group -> " + groupId + ": " + plainText(segments).slice(0, 60));
        return { message_id: Number((result && result.message_id) || 0) };
      }
      return await doSend(params, "private");
    },

    async send_group_msg(params) {
      const groupId = Number(params.group_id);
      if (!Number.isFinite(groupId) || groupId <= 0) {
        const err = new Error("缺少 group_id");
        err.retcode = 1400;
        throw err;
      }
      if (typeof driver.sendGroup !== "function") {
        const err = new Error("当前驱动不支持群聊");
        err.retcode = 1400;
        throw err;
      }
      const segments = toSegments(params);
      const result = await driver.sendGroup(groupId, segments);
      log.info("发送 group -> " + groupId + ": " + plainText(segments).slice(0, 60));
      return { message_id: Number((result && result.message_id) || 0) };
    },

    async get_msg(params) {
      const messageId = Number(params.message_id);
      if (!Number.isFinite(messageId)) {
        const err = new Error("缺少 message_id");
        err.retcode = 1400;
        throw err;
      }
      const record = await driver.getMessage(messageId);
      if (!record) {
        const err = new Error("消息不存在或已过期: " + messageId);
        err.retcode = 1404;
        throw err;
      }
      return {
        message_id: messageId,
        real_id: messageId,
        message_type: "private",
        sender: { user_id: Number(record.user_id) || 0, nickname: record.nickname || "" },
        time: record.time || Math.floor(Date.now() / 1000),
        message: record.message,
        raw_message: toCQ(record.message),
      };
    },

    async delete_msg() {
      return {};
    },

    async clean_cache() {
      return {};
    },

    async get_cookies() {
      return { cookies: "" };
    },

    async get_image() {
      const err = new Error("get_image 需要文件存储，当前驱动未实现");
      err.retcode = 1400;
      throw err;
    },
  };
}
