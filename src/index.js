#!/usr/bin/env node
// 入口保持极薄：真正的实现都在 cli.js / plugin.js 里。
import { run } from "./cli.js";

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
