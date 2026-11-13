// DSH（DeepSeek Harness）宿主插件：把 OneBot 11 桥装进 DSH。
//
// 导出 name / inject / apply / Config，bundle patch 插入一行配置：
//   - id: dsh-onebot-douyin
//     name: dsh-onebot-douyin
// 插件在 DSH 进程里启动桥（默认 127.0.0.1:5711），注册四个工具：
//   onebot_status / onebot_login / onebot_send / onebot_friends

import { homedir } from "node:os";
import { join } from "node:path";
import { createBridge } from "./plugin.js";

let z = null;
let defineTool = null;
try {
  const mod = await import("@deepseek-ai/schemastery");
  z = mod.default || mod;
} catch (err) {
  z = null;
}
try {
  const mod = await import("@deepseek-ai/dsh-tools");
  defineTool = mod.defineTool || null;
} catch (err) {
  defineTool = null;
}

export const name = "dsh-onebot-douyin";
export const inject = ["tools"];

export const Config = z
  ? z.object({
      enabled: z.boolean().default(true),
      autoStart: z.boolean().default(true),
      driver: z.union([z.const("douyin"), z.const("mock")]).default("douyin"),
      host: z.string().default("127.0.0.1"),
      port: z.number().default(5711),
      accessToken: z.string().default(""),
      dataDir: z.string().default(""),
      qrcodeFile: z.string().default(""),
    })
  : undefined;

export function createRuntime(ctx, cfgSource) {
  const getConfig = () => {
    try {
      const c = typeof cfgSource === "function" ? cfgSource() : cfgSource;
      return c || {};
    } catch (err) {
      return {};
    }
  };
  const dshHome = () => process.env.DSH_HOME || join(homedir(), ".dsh");
  const dataDir = () => getConfig().dataDir || join(dshHome(), "onebot-douyin", "data");
  const qrcodeFile = () => getConfig().qrcodeFile || join(dataDir(), "login.png");

  let bridge = null;
  let starting = null;
  let lastError = "";

  function bridgeConfig() {
    const c = getConfig();
    const port = Number(c.port);
    return {
      onebot: {
        host: c.host || "127.0.0.1",
        port: Number.isFinite(port) ? port : 5711,
        access_token: c.accessToken || "",
      },
      driver: {
        type: c.driver || "douyin",
        douyin: {
          dataDir: dataDir(),
          qrcodeFile: qrcodeFile(),
          autoOpenVerification: false,
          logLevel: "warn",
        },
      },
    };
  }

  async function start() {
    if (bridge && bridge.started) return bridge;
    if (starting) return starting;
    starting = (async () => {
      const b = createBridge({ config: bridgeConfig(), logLevel: "warn" });
      try {
        await b.start();
        bridge = b;
        lastError = "";
        return b;
      } catch (err) {
        lastError = (err && err.message) || String(err);
        try {
          await b.stop();
        } catch (e) {
          /* 半启动，尽力回收 */
        }
        throw err;
      } finally {
        starting = null;
      }
    })();
    return starting;
  }

  function status() {
    const b = bridge;
    let info = {};
    if (b && b.started && typeof b.status === "function") {
      try {
        info = b.status() || {};
      } catch (err) {
        info = {};
      }
    }
    return {
      driver: getConfig().driver || "douyin",
      online: !!(b && b.online),
      state: info.state || (lastError ? "error" : "stopped"),
      self_id: (b && b.selfId) || info.self_id || 0,
      nickname: info.nickname || "",
      address: b && b.started ? b.address : "",
      qrcode_file: info.qrcode_file || "",
      verification_url: info.verification_url || "",
      error: info.error || lastError || "",
    };
  }

  async function login(action, code) {
    if (action === "sms") {
      if (!code) throw new Error("login(action=sms) 需要 code");
      const b = await start();
      const drv = b.driver;
      if (typeof drv.submitSmsCode !== "function") {
        throw new Error("当前驱动不支持短信验证码");
      }
      await drv.submitSmsCode(String(code));
      return { state: status().state, qrcode_file: "", qrcode_url: "", verification_url: "", message: "验证码已提交，等待登录完成" };
    }

    const b = await start();
    if (action === "qrcode") {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const s = status();
        if (s.qrcode_file && s.state !== "stopped") {
          return {
            state: s.state,
            qrcode_file: s.qrcode_file,
            qrcode_url: s.address ? s.address + "/qrcode" : "",
            verification_url: s.verification_url,
            message: "用抖音 App 扫码登录",
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    const s = status();
    return {
      state: s.state,
      qrcode_file: s.qrcode_file,
      qrcode_url: s.address ? s.address + "/qrcode" : "",
      verification_url: s.verification_url,
      message: s.online ? "已登录" : "尚未登录",
    };
  }

  async function send(to, text, group) {
    const b = await start();
    const target = Number(to);
    const segments = [{ type: "text", data: { text: String(text) } }];
    const result = group
      ? await b.driver.sendGroup(target, segments)
      : await b.driver.sendPrivate(target, segments);
    return { message_id: result && result.message_id, to: target, group: !!group };
  }

  async function friends(withGroups) {
    const b = await start();
    const list = await b.driver.listFriends();
    const out = { friends: Array.isArray(list) ? list : [], groups: [] };
    if (withGroups && typeof b.driver.listGroups === "function") {
      out.groups = await b.driver.listGroups();
    }
    return out;
  }

  async function stop() {
    if (!bridge) return;
    const b = bridge;
    bridge = null;
    try {
      await b.stop();
    } catch (err) {
      lastError = (err && err.message) || String(err);
    }
  }

  return {
    start,
    stop,
    status,
    login,
    send,
    friends,
    config: getConfig,
    get bridge() {
      return bridge;
    },
  };
}

export function registerTools(ctx, runtime, defineToolApi) {
  const register = (definition) => ctx.tools.register(defineToolApi(definition));

  register({
    name: "onebot_status",
    description:
      "Status of the local OneBot 11 bridge backed by the Douyin driver: login state, self account id, nickname, HTTP address, last error.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          driver: { type: "string" },
          online: { type: "boolean" },
          state: { type: "string" },
          self_id: { type: "integer" },
          nickname: { type: "string" },
          address: { type: "string" },
          qrcode_file: { type: "string" },
          verification_url: { type: "string" },
          error: { type: "string" },
        },
      },
      render: (_args, v) => [{ type: "text", text: "driver=" + v.driver + " state=" + v.state + " online=" + v.online + " self=" + v.self_id + " nick=" + (v.nickname || "-") + " http=" + (v.address || "-") + (v.error ? " error=" + v.error : "") }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      return runtime.status();
    },
  });

  register({
    name: "onebot_login",
    description:
      "Douyin login helper. action=qrcode returns the QR PNG path and a URL to scan; action=status reports the current login state; action=sms submits a verification code received on the phone.",
    parameters: {
      action: { type: "string", required: true, description: "qrcode | status | sms" },
      code: { type: "string", description: "SMS code, required when action=sms" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          state: { type: "string" },
          qrcode_file: { type: "string" },
          qrcode_url: { type: "string" },
          verification_url: { type: "string" },
          message: { type: "string" },
        },
      },
      render: (_args, v) => [{ type: "text", text: v.message + " (state=" + v.state + ")" + (v.qrcode_file ? " qr=" + v.qrcode_file : "") + (v.qrcode_url ? " url=" + v.qrcode_url : "") + (v.verification_url ? " verify=" + v.verification_url : "") }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const action = String(args.action || "status");
      return runtime.login(action, args.code);
    },
  });

  register({
    name: "onebot_send",
    description:
      "Send a text message through the Douyin driver. Set group=true to send into a group chat, otherwise it is sent as a private message. The target id is the OneBot numeric id returned by onebot_friends.",
    parameters: {
      to: { type: "string", required: true, description: "Target user id or group id (numeric string)" },
      text: { type: "string", required: true, description: "Message text" },
      group: { type: "boolean", description: "Send to a group chat instead of a private chat" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          message_id: { type: "integer" },
          to: { type: "integer" },
          group: { type: "boolean" },
        },
      },
      render: (_args, v) => [{ type: "text", text: "sent to " + v.to + (v.group ? " (group)" : "") + ", message_id=" + v.message_id }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      return runtime.send(args.to, args.text, !!args.group);
    },
  });

  register({
    name: "onebot_friends",
    description:
      "List Douyin friends known to the logged-in account, with their OneBot numeric ids. Set groups=true to also list group chats.",
    parameters: {
      groups: { type: "boolean", description: "Also list group chats" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          friends: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                user_id: { type: "integer" },
                nickname: { type: "string" },
                remark: { type: "string" },
              },
            },
          },
          groups: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                group_id: { type: "integer" },
                group_name: { type: "string" },
                member_count: { type: "integer" },
              },
            },
          },
        },
      },
      render: (_args, v) => [{ type: "text", text: "friends=" + v.friends.length + (v.groups.length ? " groups=" + v.groups.length : "") + " " + v.friends.slice(0, 8).map((f) => f.nickname + "(" + f.user_id + ")").join(", ") }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      return runtime.friends(!!args.groups);
    },
  });
}

export function apply(ctx, config) {
  const runtime = createRuntime(ctx, () => {
    const c = typeof config?.get === "function" ? config.get() : config;
    return c || {};
  });

  const c = runtime.config();
  if (c.enabled === false) return;

  if (!defineTool || !ctx.tools || typeof ctx.tools.register !== "function") {
    console.warn("[dsh-onebot-douyin] 宿主未提供 tools/defineTool，工具未注册");
  } else {
    registerTools(ctx, runtime, defineTool);
  }

  if (c.autoStart !== false) {
    runtime.start().catch((err) => {
      const message = (err && err.message) || String(err);
      console.warn("[dsh-onebot-douyin] 桥启动失败: " + message);
    });
  }

  if (typeof ctx.effect === "function") {
    ctx.effect(() => () => {
      runtime.stop();
    });
  }
}
