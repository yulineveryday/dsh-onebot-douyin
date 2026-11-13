import test from "node:test";
import assert from "node:assert/strict";
import { name, inject, registerTools, createRuntime } from "../src/dsh-plugin.js";

function makeCtx() {
  const tools = [];
  const effects = [];
  return {
    tools: { register: (t) => { tools.push(t); return t; } },
    effect: (fn) => { effects.push(fn); },
    toolsList: tools,
    effects,
  };
}

test("插件元信息", () => {
  assert.equal(name, "dsh-onebot-douyin");
  assert.deepEqual(inject, ["tools"]);
});

test("注册四个 onebot 工具", () => {
  const ctx = makeCtx();
  const runtime = createRuntime(ctx, () => ({ driver: "mock", autoStart: false, port: 0 }));
  registerTools(ctx, runtime, (def) => def);
  const names = ctx.toolsList.map((t) => t.name).sort();
  assert.deepEqual(names, ["onebot_friends", "onebot_login", "onebot_send", "onebot_status"]);
});

test("mock 驱动下：启动、状态、发送、好友、停止", async () => {
  const ctx = makeCtx();
  const runtime = createRuntime(ctx, () => ({ driver: "mock", autoStart: false, port: 0 }));
  registerTools(ctx, runtime, (def) => def);
  const byName = Object.fromEntries(ctx.toolsList.map((t) => [t.name, t]));

  await runtime.start();
  const status = await byName.onebot_status.execute({});
  assert.equal(status.online, true);
  assert.equal(status.self_id, 10000);
  assert.match(status.address, /^http:\/\/127\.0\.0\.1:\d+$/);

  const sent = await byName.onebot_send.execute({ to: "10001", text: "hi" });
  assert.equal(sent.to, 10001);
  assert.equal(typeof sent.message_id, "number");
  assert.equal(runtime.bridge.driver.sent.length, 1);

  const list = await byName.onebot_friends.execute({});
  assert.equal(list.friends.length, 2);

  await runtime.stop();
  assert.equal(runtime.bridge, null);
});
