// hotwords.test.mjs - B1 热词学习（纯函数：load/save/hasHotwordAction/learn）。
// 独立运行安全：先设临时 DSH_HOME 再动态 import（热词/审计文件都写临时目录）。
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";

process.env.DSH_HOME = join(mkdtempSync(join(tmpdir(), "dsh-rule-engine-hotwords-")));

const { loadHotwords, saveHotwords, hasHotwordAction, learnHotword, hotwordFilePath } = await import("../lib/core/hotwords.js");

// 1) 缺文件容错
assert.deepEqual(loadHotwords().words, [], "缺文件返回空表");

// 2) 学习 + 去重幂等
assert.equal(learnHotword("通读"), true, "学习成功");
assert.equal(learnHotword("通读"), true, "重复学习幂等");
assert.equal(loadHotwords().words.filter((w) => w === "通读").length, 1, "词内不重复");

// 3) 非法词拒收（长度/清洗）
assert.equal(learnHotword("a"), false, "过短拒收");
assert.equal(learnHotword("x".repeat(20)), false, "过长拒收");
assert.equal(learnHotword("  通读  "), true, "带空白清洗后学习");

// 4) 命中/未命中
assert.equal(hasHotwordAction("请通读这份报告"), true, "文本命中热词");
assert.equal(hasHotwordAction("请校对这份报告"), false, "未学词不命中");

// 5) save/load 往返
const store = loadHotwords();
assert.equal(saveHotwords(store), true, "保存成功");
assert.ok(loadHotwords().words.includes("通读"), "往返保留");

// 6) 损坏文件容错
writeFileSync(hotwordFilePath(), "{broken", "utf8");
assert.deepEqual(loadHotwords().words, [], "损坏容错为空表");
assert.equal(hasHotwordAction("通读"), false, "损坏后判定不炸");

// 7) 接入测试：词表未命中但有热词 → parseUserIntents 判 execute
const { parseUserIntents } = await import("../lib/core/intent.js");
learnHotword("通读");
assert.equal(parseUserIntents("请通读这份报告").hasExecute, true, "热词命中 → execute 分点");
assert.equal(parseUserIntents("请校对这份报告").hasExecute, false, "未学词 → 不误判 execute");

console.log("hotwords.test.mjs PASS");
