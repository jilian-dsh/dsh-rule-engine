import assert from "node:assert/strict";
import { detectSilentError, extractToolOutput } from "../lib/core/silent-error.js";

// 全 false 输出
let res = detectSilentError("false\nfalse\nfalse\n");
assert.equal(res.suspicious, true);
assert.ok(res.reason.includes("false"));

// 全 0 / null
res = detectSilentError("0\nnull\n");
assert.equal(res.suspicious, true);

// 正常输出
res = detectSilentError("3 items\nok\n");
assert.equal(res.suspicious, false);

// 与上一条完全一致
res = detectSilentError("abc", "abc");
assert.equal(res.suspicious, true);
assert.ok(res.reason.includes("完全一致"));

// 与上一条不同
res = detectSilentError("abc", "def");
assert.equal(res.suspicious, false);

// 提取工具结果文本
const fakeResult = {
  message: {
    content: [
      {
        type: "tool-result",
        content: [{ type: "text", text: "false\nfalse" }]
      }
    ]
  }
};
assert.equal(extractToolOutput(fakeResult), "false\nfalse");

console.log("silent-error.test.js PASS");
