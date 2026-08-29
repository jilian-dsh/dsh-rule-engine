// whitelist v2 存储格式测试（0.5.9）：v1 兼容 / v2 元数据 / 合并语义 / 损坏容错
import test from "node:test";
import assert from "node:assert";
const { parseWhitelist, mergeWhitelist, serializeWhitelist } = await import("../lib/core/whitelist.js");

test("v1 字符串数组兼容读取", () => {
  const rows = parseWhitelist('["run_code","esr_task"]');
  assert.deepEqual(rows, [
    { name: "run_code", time: null, session: null },
    { name: "esr_task", time: null, session: null }
  ]);
});

test("v2 对象数组带元数据", () => {
  const rows = parseWhitelist('[{"name":"run_code","time":123,"session":"s1"}]');
  assert.deepEqual(rows, [{ name: "run_code", time: 123, session: "s1" }]);
});

test("损坏/空/非数组容错", () => {
  assert.deepEqual(parseWhitelist("not json"), []);
  assert.deepEqual(parseWhitelist("{}"), []);
  assert.deepEqual(parseWhitelist(""), []);
  assert.deepEqual(parseWhitelist('["ok", 42, {"name":5}, {"name":"only"}]'), [
    { name: "ok", time: null, session: null },
    { name: "only", time: null, session: null }
  ]);
});

test("merge：既有条目保留元数据，新条目带当前时间与来源会话", () => {
  const prev = [{ name: "run_code", time: 10, session: "old-sid" }];
  const rows = mergeWhitelist(prev, ["run_code", "new_tool"], "sid1", 999);
  assert.deepEqual(rows, [
    { name: "run_code", time: 10, session: "old-sid" },
    { name: "new_tool", time: 999, session: "sid1" }
  ]);
});

test("序列化往返", () => {
  const rows = parseWhitelist(serializeWhitelist([{ name: "a", time: 1, session: "s" }]));
  assert.deepEqual(rows, [{ name: "a", time: 1, session: "s" }]);
});
