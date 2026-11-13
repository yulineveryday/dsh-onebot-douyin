import test from "node:test";
import assert from "node:assert/strict";
import { MockDriver } from "../src/drivers/mock.js";
import { EventFactory } from "../src/onebot/events.js";
import { OneBotServer } from "../src/onebot/server.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

async function boot(overrides = {}) {
  const config = {
    self_id: 10000,
    onebot: {
      host: "127.0.0.1",
      port: 0,
      access_token: overrides.accessToken || "",
      message_format: "array",
      heartbeat_interval: 0,
      reverse_ws: [],
    },
    driver: {
      type: "mock",
      mock: {
        self: { user_id: 10000, nickname: "mock-bot" },
        friends: [{ user_id: 20001, nickname: "小明" }],
      },
    },
  };
  const driver = new MockDriver(config.driver.mock, silent);
  const factory = new EventFactory(config.self_id, config.onebot.message_format);
  const server = new OneBotServer({ config, driver, factory, log: silent });
  await driver.start();
  await server.start();
  const { port } = server.httpServer.address();
  return { config, driver, server, port, base: "http://127.0.0.1:" + port };
}

function post(base, body, headers = {}) {
  return fetch(base + "/", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("get_login_info 返回自身信息", async (t) => {
  const app = await boot();
  t.after(() => app.server.stop());
  const response = await post(app.base, { action: "get_login_info", echo: "e1" });
  const body = await response.json();
  assert.equal(body.status, "ok");
  assert.equal(body.retcode, 0);
  assert.equal(body.echo, "e1");
  assert.equal(body.data.user_id, 10000);
  assert.equal(body.data.nickname, "mock-bot");
});

test("GET 查询串形式的动作也能用", async (t) => {
  const app = await boot();
  t.after(() => app.server.stop());
  const response = await fetch(app.base + "/get_friend_list");
  const body = await response.json();
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].user_id, 20001);
});

test("send_private_msg 走驱动并返回 message_id", async (t) => {
  const app = await boot();
  t.after(() => app.server.stop());
  const response = await post(app.base, {
    action: "send_private_msg",
    params: { user_id: 20001, message: "hello" },
  });
  const body = await response.json();
  assert.equal(body.status, "ok");
  assert.ok(body.data.message_id > 0);
  assert.equal(app.driver.sent.length, 1);
  assert.equal(app.driver.sent[0].user_id, 20001);
});

test("send_group_msg 明确报不支持", async (t) => {
  const app = await boot();
  t.after(() => app.server.stop());
  const response = await post(app.base, { action: "send_group_msg", params: { group_id: 1, message: "x" } });
  const body = await response.json();
  assert.equal(body.status, "failed");
  assert.equal(body.retcode, 1400);
});

test("未知 action 返回 1404", async (t) => {
  const app = await boot();
  t.after(() => app.server.stop());
  const body = await (await post(app.base, { action: "nope" })).json();
  assert.equal(body.retcode, 1404);
});

test("access_token 生效", async (t) => {
  const app = await boot({ accessToken: "s3cret" });
  t.after(() => app.server.stop());
  const denied = await post(app.base, { action: "get_login_info" });
  assert.equal(denied.status, 401);
  const allowed = await post(app.base, { action: "get_login_info" }, { authorization: "Bearer s3cret" });
  assert.equal((await allowed.json()).status, "ok");
});

test("正向 WS：动作应答 + 入站消息广播", async (t) => {
  const app = await boot();
  t.after(() => app.server.stop());
  const ws = new WebSocket("ws://127.0.0.1:" + app.port + "/");
  const inbox = [];
  const waiters = [];
  ws.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);
    inbox.push(data);
    for (const waiter of [...waiters]) waiter();
  });
  await new Promise((resolve) => ws.addEventListener("open", resolve));

  function waitFor(predicate, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("超时，已收到: " + JSON.stringify(inbox))), timeoutMs);
      const check = () => {
        const hit = inbox.find(predicate);
        if (hit) {
          clearTimeout(timer);
          resolve(hit);
        } else {
          waiters.push(check);
        }
      };
      check();
    });
  }

  ws.send(JSON.stringify({ action: "get_status", echo: "s1" }));
  const status = await waitFor((item) => item.echo === "s1");
  assert.equal(status.status, "ok");
  assert.equal(status.data.online, true);

  app.driver.inject(20001, "在吗", "小明");
  const message = await waitFor((item) => item.post_type === "message");
  assert.equal(message.user_id, 20001);
  assert.equal(message.sub_type, "friend");
  assert.deepEqual(message.message, [{ type: "text", data: { text: "在吗" } }]);
  ws.close();
});

test("message_format=string 时 message 为 CQ 码", async (t) => {
  const app = await boot();
  t.after(() => app.server.stop());
  const factory = new EventFactory(10000, "string");
  const event = factory.message({ userId: 1, nickname: "a", messageId: 1, segments: [{ type: "text", data: { text: "hi" } }] });
  assert.equal(event.message, "hi");
  assert.equal(event.raw_message, "hi");
});
test("/login/status 对 mock 驱动返回 unsupported", async (t) => {
  const app = await boot();
  t.after(() => app.server.stop());
  const body = await (await fetch(app.base + "/login/status")).json();
  assert.equal(body.status, "ok");
  assert.equal(body.data.state, "unsupported");
});

test("/qrcode 没有待扫码二维码时返回 404", async (t) => {
  const app = await boot();
  t.after(() => app.server.stop());
  const response = await fetch(app.base + "/qrcode");
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.retcode, 1404);
});

test("/login/sms 对 mock 驱动明确拒绝", async (t) => {
  const app = await boot();
  t.after(() => app.server.stop());
  const response = await fetch(app.base + "/login/sms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "123456" }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.retcode, 1400);
});
