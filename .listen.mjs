import WebSocket from "ws";
import { appendFileSync } from "node:fs";
const out = "D:/WORK1/onebot-douyin/data/events.log";
const log = (obj) => { appendFileSync(out, JSON.stringify(obj) + "\n"); };
const ws = new WebSocket("ws://127.0.0.1:5711/");
ws.on("open", () => log({ kind: "connected", at: Date.now() }));
ws.on("message", (raw) => log({ kind: "event", at: Date.now(), data: JSON.parse(String(raw)) }));
ws.on("error", (e) => log({ kind: "error", message: String(e && e.message) }));
ws.on("close", () => log({ kind: "closed", at: Date.now() }));