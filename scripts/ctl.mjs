#!/usr/bin/env node
// 极简运维 CLI：每条命令只吐一行到几行，专为省 token 设计。
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, openSync, statSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(root, "data");
const pidFile = join(dataDir, "bridge.pid");
const logFile = join(dataDir, "bridge.log");
const configFile = existsSync(join(root, "config.local.json")) ? "config.local.json" : "config.json";
const base = "http://127.0.0.1:" + (process.env.OB11_PORT || 5711);
const [cmd = "status", ...args] = process.argv.slice(2);

async function api(action, params) {
  const res = await fetch(base + "/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, params }),
  });
  return res.json();
}

async function status() {
  let data;
  try {
    data = await (await fetch(base + "/login/status")).json();
  } catch {
    console.log("down  " + base);
    return;
  }
  const d = data.data || {};
  console.log("state=" + d.state + " online=" + d.online + " self=" + d.self_id + " nick=" + d.nickname);
}

async function qr() {
  try {
    const res = await fetch(base + "/qrcode");
    if (res.status !== 200) {
      console.log("no-qr  " + base + "/login/status");
      return;
    }
    console.log("qr  " + base + "/qrcode  file=data/login.png");
  } catch {
    console.log("down  " + base);
  }
}

async function sms() {
  const code = args[0] || "";
  if (!code) return console.log("usage: ctl sms <code>");
  const res = await fetch(base + "/login/sms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  console.log((await res.json()).status + " " + res.status);
}

async function friends() {
  const r = await api("get_friend_list");
  for (const f of r.data || []) console.log(f.user_id + "  " + f.nickname + (f.remark ? " (" + f.remark + ")" : ""));
  console.log("total=" + (r.data || []).length);
}

async function groups() {
  const r = await api("get_group_list");
  for (const g of r.data || []) console.log(g.group_id + "  " + g.group_name + "  members=" + g.member_count);
  console.log("total=" + (r.data || []).length);
}

async function send() {
  const [uid, ...rest] = args;
  const text = rest.join(" ");
  if (!uid || !text) return console.log("usage: ctl send <user_id> <text>");
  const r = await api("send_private_msg", { user_id: Number(uid), message: text });
  console.log(r.status + " retcode=" + r.retcode + " id=" + (r.data && r.data.message_id));
}

async function events() {
  const n = Number(args[0] || 10);
  const file = join(dataDir, "events.log");
  if (!existsSync(file)) return console.log("no-events  (ctl watch 会写这里)");
  const lines = readFileSync(file, "utf8").trim().split("\n").slice(-n);
  for (const line of lines) {
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    if (item.kind === "connected") { console.log("connected"); continue; }
    const d = item.data || {};
    if (d.post_type === "message") {
      const text = (d.message || []).map((s) => s.type === "text" ? s.data.text : "[" + s.type + "]").join("");
      console.log("msg " + d.message_type + " " + d.user_id + " " + (d.sender && d.sender.nickname) + ": " + text);
    } else if (d.post_type === "notice") {
      console.log("notice " + d.notice_type + " " + d.user_id);
    } else if (d.post_type === "meta_event") {
      console.log("meta " + d.meta_event_type);
    } else {
      console.log(item.kind + " " + JSON.stringify(d).slice(0, 120));
    }
  }
}

function watch() {
  const file = join(dataDir, "events.log");
  mkdirSync(dataDir, { recursive: true });
  const child = spawn(process.execPath, [join(root, ".listen.mjs")], { stdio: "ignore", detached: true, cwd: root });
  child.unref();
  console.log("watching pid=" + child.pid + "  (ctl events 看)");
}

function start() {
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    try { process.kill(pid, 0); return console.log("already-running pid=" + pid); } catch {}
  }
  mkdirSync(dataDir, { recursive: true });
  try {
    if (existsSync(logFile) && statSync(logFile).size > 1024 * 1024) renameSync(logFile, logFile + ".1");
  } catch {}
  const fd = openSync(logFile, "a");
  const child = spawn(process.execPath, [join(root, "src/index.js"), "start", "--config", configFile], {
    cwd: root, detached: true, stdio: ["ignore", fd, fd],
  });
  child.unref();
  writeFileSync(pidFile, String(child.pid));
  console.log("started pid=" + child.pid + " log=data/bridge.log");
  return poll();
}

async function poll() {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const d = await (await fetch(base + "/login/status")).json();
      console.log("state=" + d.data.state + " self=" + d.data.self_id);
      return;
    } catch {}
  }
  console.log("not-ready  see data/bridge.log");
}

function stop() {
  if (!existsSync(pidFile)) return console.log("no-pid");
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  try { process.kill(pid, "SIGTERM"); } catch {}
  rmSync(pidFile, { force: true });
  console.log("stopped pid=" + pid);
}

async function doctor() {
  const child = spawn(process.execPath, [join(root, "src/index.js"), "doctor", "--config", configFile], { cwd: root });
  let out = "";
  child.stdout.on("data", (b) => { out += b; });
  child.stderr.on("data", (b) => { out += b; });
  await new Promise((r) => child.on("close", r));
  for (const line of out.split("\n")) if (/^(PASS|FAIL)/.test(line.trim())) console.log(line.trim());
}

const actions = { status, qr, sms, friends, groups, send, events, watch, start, stop, doctor };
if (!actions[cmd]) {
  console.log("commands: status qr sms friends groups send events watch start stop doctor");
  process.exit(1);
}
await actions[cmd]();