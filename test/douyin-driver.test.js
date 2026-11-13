import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DouyinDriver } from "../src/drivers/douyin.js";

function makeContact(kind, id, nickname) {
  const contact = {
    sendMsg: async (payload) => { contact.sent.push(payload); return { statusCode: 0, statusMsg: "ok" }; },
    sent: [],
  };
  if (kind === "friend" || kind === "stranger") {
    contact.uid = id;
    contact.nickname = nickname;
  } else {
    contact.groupId = id;
    contact.name = nickname;
  }
  return contact;
}

function makeAccount() {
  const friend = makeContact("friend", "uid-alice", "Alice");
  const group = makeContact("group", "gid-100", "测试群");
  const account = {
    uid: "self-uid",
    nickname: "我的抖音",
    profile: { nickname: "我的抖音" },
    fl: new Map([["uid-alice", friend]]),
    gl: new Map([["gid-100", group]]),
    sl: new Map(),
    smsCodes: [],
    getFriendList: async () => [friend],
    getGroupList: async () => [group],
    getStrangerList: async () => [],
    continueLogin: async () => { account.continued = true; },
    continueLoginWithSms: async (code) => { account.smsCodes.push(code); },
  };
  account.friend = friend;
  account.group = group;
  return account;
}

class FakeClient extends EventEmitter {
  constructor(account) {
    super();
    this.account = account;
    this.loginCalls = 0;
    this.logoutCalls = 0;
  }
  async login() { this.loginCalls += 1; }
  async logout() { this.logoutCalls += 1; }
}

function makeDriver() {
  const account = makeAccount();
  const client = new FakeClient(account);
  const sdk = {
    configureLogger: () => {},
    createClient: () => client,
    segment: { at: (uid, name) => ({ type: "at", uid, name }), image: (data) => ({ type: "image", data }) },
  };
  const dir = mkdtempSync(join(tmpdir(), "douyin-driver-"));
  const driver = new DouyinDriver({ sdk, dataDir: dir, qrcodeFile: join(dir, "login.png"), fetch: async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }) }, console);
  return { driver, account, client, dir };
}

function privateEvent(account, overrides = {}) {
  return Object.assign({
    chatType: "private",
    type: "message.private",
    account,
    friend: account.friend,
    senderUid: "uid-alice",
    text: "你好",
    content: { kind: "text", text: "你好" },
    serverMessageId: "srv-1",
  }, overrides);
}

test("private 消息转成 OneBot message 事件", async () => {
  const { driver, account, client } = makeDriver();
  await driver.start();
  assert.equal(client.loginCalls, 1);
  const received = [];
  driver.on("message", (msg) => received.push(msg));
  client.emit("message.private", privateEvent(account));
  assert.equal(received.length, 1);
  const msg = received[0];
  assert.equal(msg.messageType, "private");
  assert.equal(msg.subType, "friend");
  assert.equal(msg.nickname, "Alice");
  assert.equal(msg.segments[0].data.text, "你好");
  assert.ok(msg.userId > 0);
  assert.equal(msg.userId, driver.stableId("uid-alice"));
});

test("群消息带上 group_id 与 normal 子类型", async () => {
  const { driver, account, client } = makeDriver();
  await driver.start();
  client.emit("system.online", { account });
  const received = [];
  driver.on("message", (msg) => received.push(msg));
  client.emit("message.group", {
    chatType: "group",
    type: "message.group",
    account,
    group: account.group,
    member: { uid: "uid-bob" },
    senderUid: "uid-bob",
    text: "@我 在吗",
    content: { kind: "text", text: "@我 在吗" },
  });
  assert.equal(received[0].messageType, "group");
  assert.equal(received[0].subType, "normal");
  assert.equal(received[0].groupId, driver.stableId("gid-100"));
});

test("上线后填充 self 信息", async () => {
  const { driver, account, client } = makeDriver();
  await driver.start();
  client.emit("system.online", { account });
  assert.equal(driver.online, true);
  assert.equal(driver.self.nickname, "我的抖音");
  assert.equal(driver.self.user_id, driver.stableId("self-uid"));
  assert.equal(driver.loginStatus().state, "online");
});

test("二维码写入文件并保住 buffer", async () => {
  const { driver, account, client, dir } = makeDriver();
  await driver.start();
  client.emit("system.login.qrcode", { account, qrcodeBase64: Buffer.from("PNGDATA").toString("base64") });
  assert.ok(existsSync(join(dir, "login.png")));
  assert.equal(driver.qrcodeBuffer.toString(), "PNGDATA");
  assert.equal(driver.loginStatus().qrcode, "ready");
  assert.equal(account.continued, true);
});

test("短信验证码转给 SDK", async () => {
  const { driver, account, client } = makeDriver();
  await driver.start();
  client.emit("system.login.sms", { account });
  const result = driver.submitSmsCode("123456");
  assert.equal(result.accepted, true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(account.smsCodes, ["123456"]);
});

test("sendPrivate 走好友 sendMsg", async () => {
  const { driver, account, client } = makeDriver();
  await driver.start();
  client.emit("system.online", { account });
  const userId = driver.stableId("uid-alice");
  const result = await driver.sendPrivate(userId, [{ type: "text", data: { text: "pong" } }]);
  assert.ok(result.message_id > 0);
  assert.deepEqual(account.friend.sent, ["pong"]);
});

test("sendGroup 带上 @ 片段", async () => {
  const { driver, account, client } = makeDriver();
  await driver.start();
  client.emit("system.online", { account });
  const groupId = driver.stableId("gid-100");
  await driver.sendGroup(groupId, [
    { type: "at", data: { uid: "uid-bob", name: "Bob" } },
    { type: "text", data: { text: " 来了" } },
  ]);
  const payload = account.group.sent[0];
  assert.ok(Array.isArray(payload));
  assert.deepEqual(payload[0], { type: "at", uid: "uid-bob", name: "Bob" });
  assert.deepEqual(payload[1], { type: "text", text: " 来了" });
});

test("listFriends / listGroups 暴露稳定数字 id", async () => {
  const { driver, account, client } = makeDriver();
  await driver.start();
  client.emit("system.online", { account });
  const friends = await driver.listFriends();
  const groups = await driver.listGroups();
  assert.equal(friends[0].user_id, driver.stableId("uid-alice"));
  assert.equal(friends[0].nickname, "Alice");
  assert.equal(groups[0].group_id, driver.stableId("gid-100"));
  assert.equal(groups[0].group_name, "测试群");
});

test("图片消息转成 image 片段", async () => {
  const { driver, account, client } = makeDriver();
  await driver.start();
  const received = [];
  driver.on("message", (msg) => received.push(msg));
  client.emit("message.private", privateEvent(account, {
    text: "",
    content: { kind: "image", text: "", image: { oid: "oid-1", md5: "md5", largeUrls: ["https://example.com/a.jpg"] } },
  }));
  assert.equal(received[0].segments[0].type, "image");
  assert.equal(received[0].segments[0].data.url, "https://example.com/a.jpg");
});

test("未登录时发送报 1401", async () => {
  const { driver } = makeDriver();
  await driver.start();
  await assert.rejects(() => driver.sendPrivate(1, [{ type: "text", data: { text: "x" } }]), (error) => error.retcode === 1401);
});
