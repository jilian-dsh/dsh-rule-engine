// natural-mode-config.test.mjs — 域 3 第一枪（2026-09-22）：naturalMode 五条正则迁配置层
//   ① LEGACY ＝json 五键逐字快照；② 夹具与 LEGACY 逐字一致；
//   ③ 行为锁：只审查→review／只回答→answer／帮我修复这个问题→null／前序 review＋请修改→change／
//      停止／停下来→answer（source=explicit-stop）／只监控／只观察→monitor；
//   ④ 还原内置后中文「只回答」不命中、answer only 命中；自重置。
// 注：本文件**不 import** index.js（其启动注入会清 override）。
import assert from "node:assert/strict";
import { defaultContract, naturalMode, setNaturalMode } from "../lib/core/contract.js";
import { TEST_NATURAL_MODE_ZH, useChineseNaturalMode } from "./helpers.mjs";

// ── ① 迁移前基线（现盘逐字快照）──
const LEGACY = {
  stop: "^(?:停止|停下来)[.!。！\\s]*$",
  review: "只审查|只看不改|不要修改(?:任何|代码|文件)",
  answer: "只回答",
  monitor: "只监控|只观察",
  change: "^(?:请)?(?:修复|修改|实现|应用补丁)|^把.+(?:修复|修改|改掉)"
};

// ── ② 夹具与基线逐字一致 ──
assert.deepEqual(TEST_NATURAL_MODE_ZH, LEGACY, "夹具 naturalMode 应与现盘基线逐字一致");

// ── ③ 配置层生效（自注入）＋ 行为锁 ──
useChineseNaturalMode();

assert.equal(naturalMode("只审查，不要修改任何代码").mode, "review", "只审查 → review");
assert.equal(naturalMode("只回答").mode, "answer", "只回答 → answer");
assert.equal(naturalMode("帮我修复这个问题"), null, "非 ^ 起始 → 不判 change（默认契约）");

const prevReview = { ...defaultContract(), mode: "review" };
assert.equal(naturalMode("请修改配置", prevReview).mode, "change", "前序 review ＋ 显式变更 → change");

const stopScopes = ["停止", "停下来"];
for (const t of stopScopes) {
  const r = naturalMode(t);
  assert.equal(r.mode, "answer", `${t} → answer`);
  assert.equal(r.source, "explicit-stop", `${t} → source=explicit-stop`);
}
for (const t of ["只监控", "只观察"]) {
  assert.equal(naturalMode(t).mode, "monitor", `${t} → monitor`);
}

// ── ③b 件 D 先红（2026-09-22）：haystack 收窄锁 —— 剥围栏 + 首条非空行 ──
// 现盘（contract.js L199–219）对 trim 后整段 .test → 下列 N1／N2／N6／N7／未闭合应 RED；N3／N4／N5 应仍绿。
// 样本不用三连反引号字面量（以 \u0060 拼），避免源码内出现代码围栏。
const F = "\u0060\u0060\u0060";
const I = "\u0060"; // 行内反引号
{
  // N1：开关只出现在围栏代码块内，首行不是开关 → 三键均不命中
  const t = `先看这段样例：\n${F}js\n只回答\n只监控\n${F}\n后面照旧。`;
  assert.equal(naturalMode(t), null, "N1 开关仅在围栏块内 → review/answer/monitor 不命中");
}
{
  // N2：开关只出现在行内反引号内，首行不是开关 → 三键均不命中
  const t = `先看这段样例：${I}只回答${I}，其余照旧。`;
  assert.equal(naturalMode(t), null, "N2 开关仅在行内反引号内 → 三键不命中");
}
{
  // N2b：开关只出现在**两连**行内反引号内（样本与 N2 同形，只把包裹改成两连）→ 三键均不命中
  // 两连须整段优先于一连：若一连空对先吃掉两连开头，内容会漏出 → 该条转红。
  const II = I + I;
  const t = `先看这段样例：${II}只回答${II}，其余照旧。`;
  assert.equal(naturalMode(t), null, "N2b 开关仅在两连行内反引号内 → 三键不命中");
}
{
  // N6：首行是围栏行（文本在围栏内），开关在围栏内 → 剥后无非空行 → 三键不命中
  const t = `${F}txt\n只回答\n${F}`;
  assert.equal(naturalMode(t), null, "N6 首行＝围栏行 → 剥后取行 → 三键不命中");
}
{
  // N7：整条只有围栏块 → 剥后 s2 为空 → null
  const t = `${F}js\nconsole.log(1)\n${F}`;
  assert.equal(naturalMode(t), null, "N7 整条仅围栏块 → 空剥后结果 null");
}
{
  // 未闭合围栏（有开头无收尾，开关只在围栏内，首行不是开关）→ 须剥到串尾 → null
  const t = `先看这段样例：\n${F}js\n只回答\n只监控\n后面照旧。`;
  assert.equal(naturalMode(t), null, "未闭合围栏 开关仅在围栏内 → 剥到串尾 → 三键不命中");
}
{
  // N3：开关在第一条非空行 → 三键仍命中（首行样本下 stop 的 ^…$ 语义不受影响）
  assert.equal(naturalMode(`只审查，其余照旧。\n${F}js\nconsole.log(1)\n${F}`).mode, "review", "N3 首行开关 → review 仍命中");
  assert.equal(naturalMode(`只回答\n${F}js\nconsole.log(1)\n${F}`).mode, "answer", "N3 首行开关 → answer 仍命中");
  assert.equal(naturalMode(`只监控\n${F}js\nconsole.log(1)\n${F}`).mode, "monitor", "N3 首行开关 → monitor 仍命中");
}
{
  // N4：stop 对整段（后随围栏块）→ 仍 answer ＋ source=explicit-stop
  const r = naturalMode(`停止\n${F}js\nconsole.log(1)\n${F}`);
  assert.equal(r.mode, "answer", "N4 stop 整段样例 → answer");
  assert.equal(r.source, "explicit-stop", "N4 stop 整段样例 → source=explicit-stop");
}
{
  // N5：change 对整段（后随围栏块）→ 前序 review 下仍 change
  const prevReview2 = { ...defaultContract(), mode: "review" };
  assert.equal(naturalMode(`请修改配置\n${F}js\nconsole.log(1)\n${F}`, prevReview2).mode, "change", "N5 change 整段样例仍绿");
}

// ── ④ 还原内置（空对象＝五键全还原）后：中文不命中、英文命中 ──
setNaturalMode({});
assert.equal(naturalMode("只回答"), null, "还原内置后中文「只回答」不命中");
assert.equal(naturalMode("answer only").mode, "answer", "还原内置后英文 answer only 命中");

// 自重置（供后续测试／单独运行；run-all 循环亦会重申各夹具）
setNaturalMode({}, { clear: true });

console.log("natural-mode-config.test.mjs PASS");
