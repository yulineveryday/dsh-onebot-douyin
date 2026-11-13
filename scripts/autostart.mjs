#!/usr/bin/env node
// 开机自启动管理（Windows 计划任务）。只吐一两行。
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(root, "data");
const cmdArg = process.argv[2] || "status";
const TASK = "dsh-onebot-douyin";
const nodePath = process.execPath;
const batchFile = join(dataDir, "autostart.cmd");
const vbsFile = join(dataDir, "autostart.vbs");
const Q = String.fromCharCode(34);

function sh(file, args) {
  const p = spawnSync(file, args, { encoding: "utf8" });
  return { code: p.status, out: ((p.stdout || "") + (p.stderr || "")).trim() };
}

function isWindows() { return process.platform === "win32"; }

function writeLaunchers() {
  mkdirSync(dataDir, { recursive: true });
  const batch = [
    "@echo off",
    "cd /d " + Q + root + Q,
    Q + nodePath + Q + " " + Q + join(root, "scripts", "ctl.mjs") + Q + " start >> " + Q + join(dataDir, "autostart.log") + Q + " 2>&1",
  ].join("\r\n") + "\r\n";
  writeFileSync(batchFile, batch);
  const vbs = [
    "Set sh = CreateObject(" + Q + "WScript.Shell" + Q + ")",
    "sh.Run " + Q + "cmd /c " + Q + Q + batchFile + Q + Q + Q + ", 0, False",
  ].join("\r\n") + "\r\n";
  writeFileSync(vbsFile, vbs);
}

function install() {
  if (!isWindows()) return console.log("unsupported  Windows only（Linux 用 systemd，见 README）");
  writeLaunchers();
  const r = sh("schtasks", ["/create", "/tn", TASK, "/tr", "wscript.exe " + Q + vbsFile + Q, "/sc", "onlogon", "/f"]);
  if (r.code !== 0) return console.log("fail  " + r.out.slice(-160));
  console.log("installed  task=" + TASK + " trigger=onlogon node=" + nodePath);
}

function uninstall() {
  if (!isWindows()) return console.log("unsupported");
  const r = sh("schtasks", ["/delete", "/tn", TASK, "/f"]);
  rmSync(vbsFile, { force: true });
  rmSync(batchFile, { force: true });
  console.log(r.code === 0 ? "removed  task=" + TASK : "no-task  " + r.out.slice(-120));
}

function status() {
  if (!isWindows()) return console.log("unsupported");
  if (!existsSync(vbsFile)) { console.log("absent  no launcher"); return; }
  const ps = [
    "$t = Get-ScheduledTask -TaskName " + Q + TASK + Q + "; $i = Get-ScheduledTaskInfo -TaskName " + Q + TASK + Q + ";",
    "Write-Output (" + Q + "state=" + Q + " + $t.State);",
    "Write-Output (" + Q + "trigger=" + Q + " + $t.Triggers[0].CimClass.CimClassName);",
    "Write-Output (" + Q + "last_run=" + Q + " + $i.LastRunTime);",
    "Write-Output (" + Q + "last_result=" + Q + " + $i.LastTaskResult)",
  ].join(" ");
  const r = sh("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps]);
  if (r.code !== 0) { console.log("absent  task=" + TASK + "  " + r.out.slice(-120)); return; }
  const kv = {};
  for (const line of r.out.split(/\r?\n/)) { const i = line.indexOf("="); if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  const node = (() => { try { return readFileSync(batchFile, "utf8").split("\r\n")[2].split(Q)[1]; } catch { return "?"; } })();
  console.log("installed  task=" + TASK + " state=" + (kv.state || "?") + " trigger=" + (kv.trigger || "?").replace("MSFT_Task", ""));
  console.log("last_run=" + (kv.last_run || "?") + " last_result=" + (kv.last_result || "?") + " (0=成功)");
  console.log("node=" + node);
}

function runNow() {
  if (!isWindows()) return console.log("unsupported");
  const r = sh("schtasks", ["/run", "/tn", TASK]);
  console.log(r.code === 0 ? "ran  task=" + TASK : "fail  " + r.out.slice(-160));
}

const actions = { install, uninstall, status, run: runNow };
if (!actions[cmdArg]) { console.log("usage: autostart.mjs install|uninstall|status|run"); process.exit(1); }
actions[cmdArg]();