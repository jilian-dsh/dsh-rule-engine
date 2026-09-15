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
import { criticismSignals, hasExplicitExecWord, hasHighCapsRatio, hasShoutingWordShape, setCriticismPersonal } from "../lib/core/text-detect.js";
import { setLexicons, resetLexicons } from "../lib/core/lexicon.js";
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

// ── ①b 标识符回归（2026-09-15，踩坑 144 修法 (b) 收紧档）：编号标签／缩写不得判"喊叫" ──
{
  const labels = "继续执行A1→A3→A2→A4→B5→B6→D 提交";
  assert.equal(hasHighCapsRatio(labels), true, "纯比率函数仍会命中（保留导出，配置层复用）");
  assert.equal(hasShoutingWordShape(labels), false, "词形判据：编号标签不算喊叫（连续字母不足 4）");
  assert.equal(criticismSignals(labels).suspect, null, "编号标签消息 → 无信号（修复前为 strong，误冻结写类工具）");
  assert.equal(hasShoutingWordShape("看下 ESR 与 DSH 的报告"), false, "3 字母缩写不算喊叫");
  assert.equal(hasShoutingWordShape("ESR ESR"), false, "两个 3 字母缩写仍不算（词长不足）");
  assert.equal(hasShoutingWordShape("EXAMPLE ALL CAPS SENTENCE"), true, "多词全大写仍判喊叫（信号未退役）");
  assert.equal(hasShoutingWordShape("ABCDEF"), false, "单个 token 不算（词形 token 数 < 2）");
  assert.equal(hasShoutingWordShape("This is a Normal sentence"), false, "大小写混排不算");
  assert.equal(criticismSignals("!!!!! 你说什么呢").suspect, "strong", "连续叹号路径不受影响");
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

  // ── C2-C 档（批 3，2026-09-15）：/guard bypass 窗口内 A″ 必须让步 ──
  // 依据：/guard bypass 的语义是「全部守卫暂停」（guard status 文案原文），但 A″ 冻结闸此前
  // 只查 turn.criticismFrozen、不检查 state.bypassUntil → 用户显式放行后仍被冻结（语义不一致）。
  // 设计：bypassActive 由调用方从 state.bypassUntil 计算后传入（本函数保持纯函数、可单测）；
  // bypass 窗口内的留痕由 guard 路径既有的 bypass-action 审计统一负责（M2），此处不重复记。
  assert.equal(
    freeze(frozen, "write", { file_path: "D:/tmp/a.txt" }, { bypassActive: true }),
    null,
    "★ bypass 窗口内写类工具应放行（C2-C 修复点；实现前此处返回拒绝文本 → 必红）"
  );
  assert.equal(
    freeze(frozen, "pwsh", { command: "Set-Content D:/tmp/a.txt x" }, { bypassActive: true }),
    null,
    "bypass 窗口内写命令同样放行"
  );
  assert.equal(
    freeze(frozen, "read", { file_path: "D:/tmp/a.txt" }, { bypassActive: true }),
    null,
    "bypass 窗口内只读工具照常放行"
  );
  // 反向锁（防放行过宽）：非 bypass 窗口仍须冻结
  assert.equal(
    typeof freeze(frozen, "write", { file_path: "D:/tmp/a.txt" }, { bypassActive: false }),
    "string",
    "非 bypass 窗口仍须冻结（防 C2-C 改宽）"
  );
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

// ── ⑥ C3（批 3，2026-09-15，用户裁定方案 A）：批评 + 明确指令的混合消息不得把指令一起冻掉 ──
// 背景：置位逻辑原对强弱信号**不对称**——弱信号已做反向检查（hasExplicitExecWord），
// 强信号无条件冻结 → 「批评 + 明确指令」会把用户同时下达的指令一起冻掉（而那条指令本身是完整授权）。
// 判据（方案 A）：强信号下只有**完整执行许可**（许可词 + 执行语，approvalExecRe）才豁免——
// 比弱信号的反向检查（只认动作词）更严，避免「批评里提个动作词就算授权」的过宽。
{
  // 本用例走 approvalExecRe（许可词 + 执行语），而本测试进程用的是**临时 DSH_HOME**（不读本机配置）
  // → 不显式注入就等于拿内置**英文**最小集去判中文样本，正例恒不命中（假红）。
  // 故在此注入与真配置同形的中文最小集（真词表见 .dsh/rule-engine.json 的 lexicons 键）。
  // 注：**必须自带分组** `(?:…)`——派生键 approval_exec 由 `${approval}[^\n]{0,16}${exec_follow}`
  // 直接拼接（lexicon.js 的 resolveSource），若子键不带分组，`|` 的最低优先级会让最后一支脱离拼接，
  // 例如 `好|可以[^\n]{0,16}改|修|做` 里「做」会单独成立 → 任意含"做"的消息都被判成完整执行许可。
  // 本机真配置（.dsh/rule-engine.json）的 approval/exec_follow 均带分组，此注入与之同形。
  setLexicons({ approval: "(?:确认|同意|好|可以)", exec_follow: "(?:改|修|做|落盘|执行)" });
  const { criticismFreezeBySignal: bySignal } = await import("../lib/index.js");
  assert.equal(typeof bySignal, "function", "criticismFreezeBySignal 应为导出函数（C3 抽出的纯函数）");
  // 正例：强信号 + 完整执行许可（许可词「确认」+ 执行语「改掉」）→ 不冻结
  assert.equal(
    bySignal("strong", "你这做的什么玩意！！！确认，把那行配置改掉"),
    false,
    "★ 强信号 + 完整执行许可 → 不冻结（C3 修复点；实现前该函数不存在 → 必红）"
  );
  // 反向锁 1：只有动作词、没有许可词 ≠ 授权 → 仍冻结
  assert.equal(bySignal("strong", "你这做的什么玩意！！！改掉"), true, "只有动作词不算授权 → 仍冻结");
  // 反向锁 2：纯批评、无任何指令 → 仍冻结
  assert.equal(bySignal("strong", "你这做的什么玩意！！！"), true, "纯批评 → 仍冻结");
  // 弱信号路径不变（既有后果分级：从不冻结）
  assert.equal(bySignal("weak", "确认，改掉"), false, "弱信号从不冻结（既有分级不变）");
}

console.log("criticism-config.test.js PASS");
