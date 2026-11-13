import { MockDriver } from "./mock.js";
import { HttpDriver } from "./http.js";
import { DouyinDriver } from "./douyin.js";

export function createDriver(config, log) {
  const driverConfig = config.driver || {};
  const type = String(driverConfig.type || "mock").toLowerCase();
  if (type === "mock") return new MockDriver(driverConfig.mock || {}, log);
  if (type === "http" || type === "adapter") return new HttpDriver(driverConfig.http || {}, log);
  if (type === "douyin") return new DouyinDriver(driverConfig.douyin || {}, log);
  throw new Error("未知 driver.type: " + type + "（可选 mock | http | douyin）");
}

export { MockDriver, HttpDriver, DouyinDriver };
