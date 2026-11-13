// 编程接口：把桥当成一个「插件对象」嵌到别的 Node 程序里。
//
//   import { createBridge } from "onebot-douyin";
//
//   const bridge = createBridge({ config: { driver: { type: "douyin" } } });
//   await bridge.start();
//   console.log(bridge.address, bridge.status());
//   await bridge.stop();

import { DEFAULTS, mergeConfig, loadConfig } from "./config.js";
import { log as defaultLog, setLevel } from "./logger.js";
import { createDriver } from "./drivers/index.js";
import { EventFactory } from "./onebot/events.js";
import { OneBotServer } from "./onebot/server.js";

export function createBridge(options = {}) {
  const config = options.config
    ? { ...mergeConfig(DEFAULTS, options.config), source: "(inline config)" }
    : loadConfig(options.configPath);

  const log = options.log || defaultLog;
  if (!options.log) setLevel(options.logLevel || (config.log_level || "info"));

  const driver = createDriver(config, log);
  const factory = new EventFactory(config.self_id || 0, config.onebot.message_format);
  const server = new OneBotServer({ config, driver, factory, log });

  let started = false;

  const selfId = () => Number(config.self_id) || (driver.selfInfo && Number(driver.selfInfo.user_id)) || (driver.self && Number(driver.self.user_id)) || 0;

  const bridge = {
    config,
    driver,
    server,
    log,
    get selfId() { return selfId(); },
    get online() { return !!driver.online; },
    get started() { return started; },
    get address() { return "http://" + config.onebot.host + ":" + config.onebot.port; },
    async start() {
      if (started) return bridge;
      await driver.start();
      factory.setSelfId(selfId());
      await server.start();
      const address = server.httpServer && server.httpServer.address();
      if (address && address.port) config.onebot.port = address.port;
      started = true;
      return bridge;
    },
    async stop() {
      if (!started) return;
      started = false;
      await server.stop();
      await driver.stop();
    },
    status() {
      return typeof driver.loginStatus === "function" ? driver.loginStatus() : { state: "unsupported", online: !!driver.online, self_id: selfId() };
    },
    on(event, handler) { driver.on(event, handler); return bridge; },
    off(event, handler) { driver.off(event, handler); return bridge; },
  };
  return bridge;
}

export { DEFAULTS, mergeConfig, loadConfig };
export default createBridge;
