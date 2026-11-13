import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export const DEFAULTS = {
  self_id: 10000,
  onebot: {
    http: { enabled: true },
    ws: { enabled: true },
    host: "127.0.0.1",
    port: 5700,
    access_token: "",
    message_format: "array",
    heartbeat_interval: 30000,
    reverse_ws: [],
  },
  driver: {
    type: "mock",
    mock: {
      self: { user_id: 10000, nickname: "mock-bot" },
      friends: [
        { user_id: 10001, nickname: "小明" },
        { user_id: 10002, nickname: "小红" },
      ],
    },
    douyin: {
      dataDir: "data",
      qrcodeFile: "data/login.png",
      autoOpenVerification: false,
      logLevel: "warn",
    },
    http: {
      inbound: { host: "127.0.0.1", port: 5702, token: "" },
      outbound: { url: "", token: "", timeout: 20000 },
      self: { user_id: 10000, nickname: "douyin-bot" },
    },
  },
};

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function mergeConfig(base, override) {
  if (!isObject(base) || !isObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = isObject(value) && isObject(base[key]) ? mergeConfig(base[key], value) : value;
  }
  return out;
}

const CONFIG_CANDIDATES = ["config.local.json", "config.json"];

export function loadConfig(explicitPath) {
  let file = explicitPath ? resolve(explicitPath) : null;
  if (!file) {
    for (const candidate of CONFIG_CANDIDATES) {
      if (existsSync(resolve(candidate))) { file = resolve(candidate); break; }
    }
  }
  let raw = {};
  if (file) {
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      throw new Error(`配置文件读取失败 ${file}: ${err.message}`);
    }
  }
  const cfg = mergeConfig(DEFAULTS, raw);
  cfg.source = file || "(内置默认配置)";

  if (process.env.OB11_PORT) cfg.onebot.port = Number(process.env.OB11_PORT);
  if (process.env.OB11_HOST) cfg.onebot.host = process.env.OB11_HOST;
  if (process.env.OB11_TOKEN !== undefined) cfg.onebot.access_token = process.env.OB11_TOKEN;
  if (process.env.OB11_DRIVER) cfg.driver.type = process.env.OB11_DRIVER;
  if (process.env.OB11_SELF_ID) cfg.self_id = Number(process.env.OB11_SELF_ID);
  return cfg;
}
