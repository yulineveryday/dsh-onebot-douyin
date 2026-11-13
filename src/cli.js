import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { log, setLevel } from "./logger.js";
import { createDriver } from "./drivers/index.js";
import { EventFactory } from "./onebot/events.js";
import { OneBotServer } from "./onebot/server.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function findConfigFile(cwd = process.cwd()) {
  // 先看当前目录（npm 安装后用户在哪跑就找哪），再看包自身目录
  for (const dir of [cwd, ROOT]) {
    for (const name of ["config.local.json", "config.json"]) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) return file;
    }
  }
  return null;
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift() || "start";
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const item = args[i];
    if (item === "--config") {
      options.config = args[i + 1];
      i += 1;
    } else if (item.startsWith("--config=")) {
      options.config = item.slice("--config=".length);
    } else if (item === "--port") {
      options.port = Number(args[i + 1]);
      i += 1;
    }
  }
  return { command, options };
}

async function start(config) {
  const driver = createDriver(config, log);
  const factory = new EventFactory(config.self_id || driver.self.user_id, config.onebot.message_format);
  const server = new OneBotServer({ config, driver, factory, log });

  await driver.start();

  if (typeof driver.on === "function" && typeof driver.loginStatus === "function") {
    const base = "http://" + config.onebot.host + ":" + config.onebot.port;
    driver.on("login", (info) => {
      const stage = info && info.stage;
      if (stage === "qrcode") {
        log.info("抖音需要扫码登录：二维码已保存到 " + (info.file || "(内存)") + "，或浏览器打开 " + base + "/qrcode");
      } else if (stage === "sms") {
        log.warn("抖音需要短信验证码：POST " + base + "/login/sms  body {\"code\":\"123456\"}");
      } else if (stage === "verification") {
        log.warn("抖音要求安全验证：" + (info.url ? "打开 " + info.url : "见日志中的验证页"));
      } else if (stage === "error") {
        log.error("抖音登录失败：" + info.error);
      }
    });
  }

  factory.setSelfId(config.self_id || driver.self.user_id);
  await server.start();

  log.info("已启动 self_id=" + (config.self_id || driver.self.user_id) + " driver=" + driver.name + " 配置=" + config.source);

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    log.info("收到 " + signal + "，正在关闭…");
    try {
      await server.stop();
    } catch (error) {
      log.warn("关闭 OneBot 服务失败: " + error.message);
    }
    try {
      await driver.stop();
    } catch (error) {
      log.warn("关闭驱动失败: " + error.message);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  return { driver, server };
}

async function doctor(config) {
  const checks = [];
  const push = (name, ok, detail) => checks.push({ name, ok, detail });

  const major = Number(process.versions.node.split(".")[0]);
  push("node >= 20（内置 fetch/WebSocket）", major >= 20, "当前 " + process.version);

  try {
    await import("ws");
    push("依赖 ws 可加载", true, "ok");
  } catch (error) {
    push("依赖 ws 可加载", false, error.message + "（先跑 pnpm install）");
  }

  const configFile = findConfigFile();
  push("配置文件", true, configFile || "未找到 config.json / config.local.json，使用内置默认值（mock 驱动）");
  push("配置来源", true, config.source);

  let driver = null;
  try {
    driver = createDriver(config, log);
    push("驱动可实例化", true, driver.name);
  } catch (error) {
    push("驱动可实例化", false, error.message);
  }

  if (driver && driver.name === "mock") {
    push("mock 驱动自检", true, "无需真实 App，可直接联调框架");
  }

  if (driver && driver.name === "douyin") {
    try {
      await import("douyin-im");
      push("依赖 douyin-im 可加载", true, "ok");
    } catch (error) {
      push("依赖 douyin-im 可加载", false, error.message + "（先在项目目录执行 pnpm add douyin-im）");
    }
    push("抖音数据目录", true, driver.dataDir + "（会话/账号保存在这里，别删）");
  }

  if (driver && driver.name === "http") {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const response = await fetch(driver.outbound.url, {
        method: "POST",
        headers: Object.assign(
          { "content-type": "application/json" },
          driver.outbound.token ? { authorization: "Bearer " + driver.outbound.token } : {}
        ),
        body: JSON.stringify({ action: "ping" }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await response.text();
      push("适配器出站可达", response.ok, response.status + " " + text.slice(0, 120));
    } catch (error) {
      push("适配器出站可达", false, driver.outbound.url + " -> " + error.message + "（先启动 adapters/android/adapter.py 或改配置）");
    }
  }

  for (const item of checks) {
    console.log((item.ok ? "PASS " : "FAIL ") + item.name + " —— " + item.detail);
  }
  const failed = checks.filter((item) => !item.ok).length;
  console.log("");
  console.log("OneBot 11 监听地址: http://" + config.onebot.host + ":" + config.onebot.port);
  console.log("正向 WS: 同端口（机器人的「反向 WS」填 ws://" + config.onebot.host + ":" + config.onebot.port + "/）");
  console.log("反向 WS: " + ((config.onebot.reverse_ws || []).length ? JSON.stringify(config.onebot.reverse_ws) : "未配置"));
  console.log(failed === 0 ? "自检通过。" : "自检发现 " + failed + " 项问题。");
  return failed === 0 ? 0 : 1;
}

export async function run(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  const config = loadConfig(options.config || findConfigFile() || undefined);
  setLevel(process.env.OB11_LOG_LEVEL || config.log_level || "info");
  if (options.port) config.onebot.port = options.port;

  if (command === "doctor") {
    const code = await doctor(config);
    process.exit(code);
  }

  if (command === "start") {
    await start(config);
    return;
  }

  console.log("用法: node src/index.js [start|doctor] [--config 路径] [--port 端口]");
  process.exit(1);
}

export { start, doctor, parseArgs, findConfigFile };

// 直接执行本文件时也按 CLI 跑（方便 node src/cli.js start）
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  run().catch((error) => {
    log.error("启动失败: " + (error && error.stack ? error.stack : error));
    process.exit(1);
  });
}