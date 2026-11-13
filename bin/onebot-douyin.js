#!/usr/bin/env node
import { run } from "../src/cli.js";

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
