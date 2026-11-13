import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { HttpDriver } from "../src/drivers/http.js";
import { EventFactory } from "../src/onebot/events.js";
import { OneBotServer } from "../src/onebot/server.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server.address().port));
  });
}

test("http 驱动：适配器入站转 OneBot 事件，OneBot 动作转适配器出站", async (t) => {
  const received = [];
  const adapter = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, messageId: 77 }));
  });
  const adapterPort = await listen(adapter, 0);
  t.after(() => new Promise((resolve) => adapter.close(resolve)));

  const config = {
    self_id: 10001,
    onebot: { host: "127.0.0.1", port: 0, access_token: "", message_format: "array", heartbeat_interval: 0, reverse_ws: [] },
    driver: {},
  };
  const driver = new HttpDriver(
    {
      inbound: { host: "127.0.0.1", port: 0, token: "" },
      outbound: { url: "http://127.0.0.1:" + adapterPort + "/", token: "", timeout: 5000 },
      self: { user_id: 10001, nickname: "adapter-bot" },
    },
    silent
  );
  const factory = new EventFactory(10001, "array");
  const server = new OneBotServer({ config, driver, factory, log: silent });
  await driver.start();
  await server.start();
  t.after(async () => {
    await server.stop();
    await driver.stop();
  });

  const inboundPort = driver.server.address().port;
  const bridgePort = server.httpServer.address().port;

  const ws = new WebSocket("ws://127.0.0.1:" + bridgePort + "/");
  const inbox = [];
  ws.addEventListener("message", (event) => inbox.push(JSON.parse(event.data)));
  await new Promise((resolve) => ws.addEventListener("open", resolve));
  t.after(() => ws.close());

  await fetch("http://127.0.0.1:" + inboundPort + "/message", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "message",
      userId: 30001,
      nickname: "小李",
      nativeId: "n1",
      message: [{ type: "text", data: { text: "你好" } }],
    }),
  });

  const deadline = Date.now() + 3000;
  while (!inbox.some((item) => item.post_type === "message") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const event = inbox.find((item) => item.post_type === "message");
  assert.ok(event, "应收到消息事件: " + JSON.stringify(inbox));
  assert.equal(event.user_id, 30001);
  assert.equal(event.sender.nickname, "小李");

  const response = await fetch("http://127.0.0.1:" + bridgePort + "/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "send_private_msg", params: { user_id: 30001, message: "收到" }, echo: "x" }),
  });
  const body = await response.json();
  assert.equal(body.status, "ok");
  assert.equal(body.data.message_id, 77);
  assert.equal(received.length, 1);
  assert.equal(received[0].action, "send_message");
  assert.equal(received[0].userId, 30001);
  assert.deepEqual(received[0].message, [{ type: "text", data: { text: "收到" } }]);
});
