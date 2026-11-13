const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
let current = LEVELS[process.env.OB11_LOG_LEVEL] ?? LEVELS.info;

export function setLevel(name) {
  current = LEVELS[name] ?? LEVELS.info;
}

function emit(level, args) {
  if (LEVELS[level] < current) return;
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const sink = level === "error" ? console.error : console.log;
  sink(`[${ts}] ${level.toUpperCase().padEnd(5)} ${args.map(format).join(" ")}`);
}

function format(v) {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack || String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

export const log = {
  debug: (...a) => emit("debug", a),
  info: (...a) => emit("info", a),
  warn: (...a) => emit("warn", a),
  error: (...a) => emit("error", a),
};

export default log;
