import test from "node:test";
import assert from "node:assert/strict";
import { parseCQ, toCQ, normalizeMessage, plainText, imageUrls } from "../src/onebot/segments.js";

test("纯文本解析成一个 text 段", () => {
  const segments = parseCQ("你好");
  assert.deepEqual(segments, [{ type: "text", data: { text: "你好" } }]);
});

test("CQ 码解析成多段", () => {
  const segments = parseCQ("看图[CQ:image,file=a.jpg,url=http://x/a.jpg]好吗");
  assert.equal(segments.length, 3);
  assert.equal(segments[1].type, "image");
  assert.equal(segments[1].data.file, "a.jpg");
  assert.equal(segments[2].data.text, "好吗");
});

test("at 段保留 qq 字段", () => {
  const segments = parseCQ("[CQ:at,qq=12345] 在吗");
  assert.deepEqual(segments[0], { type: "at", data: { qq: "12345" } });
});

test("特殊字符往返不丢", () => {
  const original = "a&b[c],d";
  const segments = [{ type: "text", data: { text: original } }];
  const cq = toCQ(segments);
  assert.equal(cq, "a&amp;b&#91;c&#93;&#44;d");
  assert.equal(plainText(parseCQ(cq)), original);
});

test("array 输入与对象输入都归一化", () => {
  assert.deepEqual(normalizeMessage({ type: "text", data: { text: "x" } }), [{ type: "text", data: { text: "x" } }]);
  assert.equal(normalizeMessage([{ type: "text", data: { text: "y" } }])[0].data.text, "y");
  assert.deepEqual(normalizeMessage(null), [{ type: "text", data: { text: "" } }]);
});

test("imageUrls 只取图片段", () => {
  const segments = normalizeMessage("[CQ:image,file=f1.jpg][CQ:image,file=f2.jpg]");
  assert.deepEqual(imageUrls(segments), ["f1.jpg", "f2.jpg"]);
});
