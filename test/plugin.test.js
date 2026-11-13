import test from "node:test";
import assert from "node:assert/strict";
import { createBridge } from "../src/plugin.js";

test("createBridge 用内联配置起一个可用的桥", async (t) => {
  const bridge = createBridge({
    logLevel: "silent",
    config: {
      self_id: 10000,
      onebot: { host: "127.0.0.1", port: 0, heartbeat_interval: 0 },
      driver: { type: "mock", mock: { self: { user_id: 10000, nickname: "mock-bot" }, friends: [] } },
    },
  });
  t.after(() => bridge.stop());

  assert.equal(bridge.started, false);
  await bridge.start();
  assert.equal(bridge.started, true);
  const port = bridge.server.httpServer.address().port;
  assert.equal(bridge.config.onebot.port, port);
  assert.equal(bridge.address, "http://127.0.0.1:" + port);
  assert.equal(bridge.selfId, 10000);

  const res = await fetch("http://127.0.0.1:" + port + "/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "get_login_info" }),
  });
  const body = await res.json();
  assert.equal(body.data.user_id, 10000);
  assert.equal(body.data.nickname, "mock-bot");

  const status = bridge.status();
  assert.equal(status.state, "unsupported");
});

test("createBridge 暴露 on/off 并转发驱动事件", async (t) => {
  const bridge = createBridge({
    logLevel: "silent",
    config: { onebot: { host: "127.0.0.1", port: 0, heartbeat_interval: 0 }, driver: { type: "mock", mock: { self: { user_id: 1, nickname: "b" }, friends: [] } } },
  });
  t.after(() => bridge.stop());
  await bridge.start();
  const seen = [];
  bridge.on("message", (msg) => seen.push(msg));
  bridge.driver.inject(20001, "hi", "小明");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].userId, 20001);
  assert.equal(seen[0].segments[0].data.text, "hi");
});
