// criticism-config.test.mjs - P8 小批 C：A″ 批评检测配置化 + 三态单测（2026-09-08）
//
// 验收目标（第三方 §1.3 / §2.1）：
//   ① 形态检测（连续 ？?/！！+ 英文大写比率）留通用层作内置默认，且可配置；
//   ② 辱骂枚举零残留（本机词表经 rule-engine.json.criticismPersonal 注入）；
//   ③ 三态单测：强信号 → 冻结写类工具；弱信号 → 仅疑似（不冻结）；无信号 → 放行。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  criticismShapeRe,
  criticismWeakRe,
  patNum,
  setPatterns,
  resetPatterns
} from "../lib/core/patterns.js";
import { criticismSignals, hasExplicitExecWord, hasHighCapsRatio, setCriticismPersonal } from "../lib/core/text-detect.js";
import { useChinesePatterns } from "./helpers.mjs";

useChinesePatterns();

// ── ① 三态：强 / 弱 / 无（中文样本，经本机 patterns 注入）──
{
  setCriticismPersonal(["示例辱骂词"]);
  assert.equal(criticismSignals("你疯了吗？？？？").suspect, "strong", "连续问号 → 强形态");
  assert.equal(criticismSignals("!!!!! 你说什么呢").suspect, "strong", "连续叹号 → 强形态");
  assert.equal(criticismSignals("EXAMPLE ALL CAPS SENTENCE").suspect, "strong", "全大写比率 → 强形态");
  assert.equal(criticismSignals("你就是个示例辱骂词").suspect, "strong", "个人词（注入）→ 强形态");
  assert.equal(criticismSignals("你怎么还在做这个呢").suspect, "weak", "中文反问形态 → 弱信号");
  assert.equal(criticismSignals("这不对吧").suspect, "weak", "否定比较形态 → 弱信号");
  assert.equal(criticismSignals("请帮我改一下这段代码").suspect, null, "普通指令 → 无信号");
  assert.equal(criticismSignals("这个函数怎么用？").suspect, "weak", "普通技术疑问也进弱嫌疑（设计：偏宽，判定权在 judge）");
  assert.equal(criticismSignals("麻烦看一下这个文件").suspect, null, "中性请求 → 无信号");
  setCriticismPersonal([]);
  assert.equal(criticismSignals("示例辱骂词").suspect, null, "清空个人词后不命中（发布面恒空）");
}

// ── ② 行为闸三态：强信号冻结写类工具 / 弱信号不冻结 / 无信号放行 ──
{
  const home = mkdtempSync(join(tmpdir(), "dsh-rule-engine-criticism-"));
  const saved = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  let freeze;
  try {
    ({ criticismFreezeDecision: freeze } = await import("../lib/index.js"));
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = saved;
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  assert.equal(typeof freeze, "function", "criticismFreezeDecision 应为导出函数");

  const frozen = { turn: { criticismFrozen: true, criticismSuspect: "strong" } };
  const notFrozen = { turn: { criticismFrozen: false } };

  // 强信号：写类工具被冻结（返回拒绝原因文本）
  for (const [name, args] of [["write", { file_path: "D:/tmp/a.txt" }], ["edit", { file_path: "D:/tmp/a.txt" }], ["pwsh", { command: "Set-Content D:/tmp/a.txt x" }]]) {
    const r = freeze(frozen, name, args);
    assert.equal(typeof r, "string", `${name} 在强信号回合应被冻结`);
    assert.match(r, /冻结/, "拒绝原因应说明冻结");
  }
  // 只读工具不受限
  for (const [name, args] of [["read", { file_path: "D:/tmp/a.txt" }], ["grep", { pattern: "x" }], ["glob", { pattern: "*" }]]) {
    assert.equal(freeze(frozen, name, args), null, `${name} 只读工具不受冻结限制`);
  }
  // 弱信号 / 无信号：不冻结
  assert.equal(freeze(notFrozen, "write", { file_path: "D:/tmp/a.txt" }), null, "弱信号回合不冻结");
  assert.equal(freeze(null, "write", { file_path: "D:/tmp/a.txt" }), null, "无 session 不冻结");
}

// ── ③ 形态可配置（通用层内置默认可覆盖）──
{
  useChinesePatterns();
  assert.equal(criticismShapeRe().test("？？？"), true, "内置/注入默认：连续 3 个问号命中");
  assert.equal(hasHighCapsRatio("ABCDEF"), true, "6 字母全大写 → 命中（比率 1.0 ≥ 0.6）");
  assert.equal(patNum("criticism_caps_ratio"), 0.6, "大写比率阈值默认 0.6");

  // 改强形态：只在 2 个以上问号时命中
  setPatterns({ criticism_shape: "(?:[？?]{2,}|[!！]{2,})" });
  assert.equal(criticismShapeRe().test("？？"), true, "覆盖后 2 个问号即命中");

  // 改大写比率阈值：0.9 → "ABCDEf"（5/6≈0.83）不再命中
  setPatterns({ criticism_caps_ratio: 0.9 });
  assert.equal(patNum("criticism_caps_ratio"), 0.9);
  assert.equal(hasHighCapsRatio("ABCDEf"), false, "阈值 0.9 时 0.83 不命中");
  assert.equal(hasHighCapsRatio("ABCDEF"), true, "阈值 0.9 时 1.0 仍命中");

  // 弱形态覆盖：英文最小集下中文反问不再命中；注入中文表后恢复
  setPatterns({ criticism_weak: "this is wrong" });
  assert.equal(criticismWeakRe().test("你怎么还在做这个呢"), false, "覆盖后中文反问不命中");
  assert.equal(criticismWeakRe().test("this is wrong"), true, "覆盖后英文形态命中");
  useChinesePatterns();
  assert.equal(criticismWeakRe().test("你怎么还在做这个呢"), true, "还原中文表后命中");

  // 非法数值被拒绝
  const bad = setPatterns({ criticism_caps_ratio: 2 });
  assert.deepEqual(bad.rejected, [{ key: "criticism_caps_ratio", reason: "invalid-number" }]);
  assert.equal(patNum("criticism_caps_ratio"), 0.6, "非法值不生效，回退默认");
}

// ── ④ 内置默认（无注入）仍保留语言无关强形态，弱形态无中文 ──
{
  resetPatterns();
  assert.equal(criticismShapeRe().test("？？？"), true, "强形态是语言无关的，内置默认即命中");
  assert.equal(hasHighCapsRatio("ABCDEF"), true, "大写比率是语言无关的");
  assert.equal(criticismWeakRe().test("你怎么还在做这个呢"), false, "内置弱形态不含中文");
  assert.equal(criticismWeakRe().test("why are you still doing this"), true, "内置弱形态命中英文形态");
  assert.doesNotMatch(criticismWeakRe().source, /[\u4e00-\u9fff]/, "内置弱形态不得含中文");
  useChinesePatterns();
}

// ── ⑤ A″ 后果分级（2026-09-09 第三批）：反向检查负例 ──
{
  // 负例 1：真实误阻断消息（含"还是"命中弱形态，但含明确执行指令词）→ 只留痕不提示
  const misfired = "请将全部新情况反馈（包括未提交的内容范围）更新一份/写一份交接文档，我交给第三方一起评估，具体是更新还是写，看你。";
  assert.equal(criticismSignals(misfired).suspect, "weak", "该消息命中弱形态（'还是'）");
  assert.equal(hasExplicitExecWord(misfired), true, "含明确执行指令词（更新/写）→ 反向检查命中 → 不注入提示");
  // 负例 2：弱信号但无执行词 → 注入提示（反向检查不命中）
  assert.equal(hasExplicitExecWord("你怎么还在做这个呢"), false, "无执行词 → 注入提示");
  assert.equal(hasExplicitExecWord("还是老问题啊"), false, "纯'还是'不构成执行指令词");
  assert.equal(hasExplicitExecWord("还有一处要确认"), false, "纯'还有'不构成执行指令词");
  assert.equal(hasExplicitExecWord("还要再改一遍"), false, "'改一遍'不在词表（词表为 改为/改成/改一下）");
  assert.equal(hasExplicitExecWord("请改一下这段代码"), true, "'改一下'命中执行指令词");
  // 强信号不受反向检查影响：含执行词也仍走行为闸
  assert.equal(criticismSignals("你疯了吗？？？？请写一份报告").suspect, "strong", "强信号仍判 strong（执行词不降级）");
  assert.equal(hasExplicitExecWord("你疯了吗？？？？请写一份报告"), true, "反向检查命中但不影响强信号冻结");
}

console.log("criticism-config.test.js PASS");
