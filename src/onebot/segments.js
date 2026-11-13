// OneBot 11 消息段编解码：string(CQ 码) <-> array(消息段)
const CQ_ESCAPE = [[ "&", "&amp;" ], [ "[", "&#91;" ], [ "]", "&#93;" ], [ ",", "&#44;" ]];

function escapeValue(input) {
  let out = String(input === undefined || input === null ? "" : input);
  for (const [from, to] of CQ_ESCAPE) out = out.split(from).join(to);
  return out;
}

function unescapeValue(input) {
  return String(input)
    .split("&#44;").join(",")
    .split("&#93;").join("]")
    .split("&#91;").join("[")
    .split("&amp;").join("&");
}

export function parseCQ(text) {
  const segments = [];
  const source = String(text === undefined || text === null ? "" : text);
  const pattern = /\[CQ:([A-Za-z0-9_.-]+)((?:,[^\]]*)?)\]/g;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    if (match.index > cursor) {
      segments.push({ type: "text", data: { text: unescapeValue(source.slice(cursor, match.index)) } });
    }
    const type = match[1];
    const data = {};
    const body = (match[2] || "").replace(/^,/, "");
    if (body) {
      for (const pair of body.split(",")) {
        if (!pair) continue;
        const eq = pair.indexOf("=");
        if (eq === -1) continue;
        data[pair.slice(0, eq)] = unescapeValue(pair.slice(eq + 1));
      }
    }
    segments.push({ type, data });
    cursor = match.index + match[0].length;
  }
  if (cursor < source.length) {
    segments.push({ type: "text", data: { text: unescapeValue(source.slice(cursor)) } });
  }
  if (segments.length === 0) segments.push({ type: "text", data: { text: "" } });
  return segments;
}

export function toCQ(segments) {
  const list = Array.isArray(segments) ? segments : [];
  return list
    .map((seg) => {
      if (!seg || typeof seg !== "object") return "";
      if (seg.type === "text") return escapeValue(seg.data && seg.data.text);
      const data = seg.data || {};
      const parts = Object.entries(data)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => key + "=" + escapeValue(typeof value === "object" ? JSON.stringify(value) : value));
      return "[CQ:" + seg.type + (parts.length ? "," + parts.join(",") : "") + "]";
    })
    .join("");
}

export function normalizeMessage(input) {
  if (input === undefined || input === null) return [{ type: "text", data: { text: "" } }];
  if (typeof input === "string") return parseCQ(input);
  if (Array.isArray(input)) {
    const list = input
      .filter((seg) => seg && typeof seg === "object" && typeof seg.type === "string")
      .map((seg) => ({ type: seg.type, data: seg.data && typeof seg.data === "object" ? seg.data : {} }));
    return list.length ? list : [{ type: "text", data: { text: "" } }];
  }
  if (typeof input === "object" && typeof input.type === "string") {
    return [{ type: input.type, data: input.data && typeof input.data === "object" ? input.data : {} }];
  }
  return [{ type: "text", data: { text: String(input) } }];
}

export function plainText(segments) {
  return normalizeMessage(segments)
    .filter((seg) => seg.type === "text")
    .map((seg) => seg.data.text || "")
    .join("");
}

export function imageUrls(segments) {
  return normalizeMessage(segments)
    .filter((seg) => seg.type === "image")
    .map((seg) => seg.data.url || seg.data.file || "")
    .filter(Boolean);
}
