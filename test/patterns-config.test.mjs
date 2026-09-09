// patterns-config.test.mjs - P8 小批 B：检测正则配置化等价性 + 双层模型单测（2026-09-08）
//
// 验收目标（第三方 §2.1）：迁移前后对同批样本句判定一致；发布面 patterns.js 只留机制与英文常量。
// 等价性证明方式（不循环）：迁移前基线 LEGACY = 迁移前 patterns.js 16 张表的逐字快照（硬编码于本文件）；
// 对同一批样本句比较「迁移前实现」new RegExp(LEGACY[key], "i") 与「迁移后实现」patRe(key)。
import assert from "node:assert/strict";
import {
  PATTERN_KEYS,
  PATTERN_NUM_KEYS,
  effectivePatterns,
  patRe,
  patNum,
  setPatterns,
  resetPatterns,
  hasPatternOverride,
  isNegatingSuggestion,
  isQuoteOrParaphraseContext,
  isPromiseQuoteContext,
  needsApprovalReminder,
  promiseWordsRe,
  timeWordsRe,
  sourceMarkRe,
  evidenceMarkRe,
  criticismShapeRe,
  criticismWeakRe
} from "../lib/core/patterns.js";
import { criticismSignals, hasHighCapsRatio } from "../lib/core/text-detect.js";
import { TEST_PATTERNS_ZH, useChinesePatterns } from "./helpers.mjs";

// ── ① 迁移前基线（迁移前 patterns.js 逐字快照）──
const LEGACY = {
  time_words: "今天|昨天|前天|上周|本周|刚才|\\d+\\s*分钟前",
  historic_date:
    "\\d{1,2}\\s*月\\s*\\d{1,2}\\s*日|\\d{4}\\s*年\\s*\\d{1,2}\\s*月\\s*\\d{1,2}\\s*日|20\\d{2}[-/.]\\d{1,2}[-/.]\\d{1,2}",
  evidence_mark:
    "日志\\s*(?:ts|时间戳)|mtime|启动时间|进程\\s*StartTime|文件\\s*修改时间|来源[:：]|ts\\s*[:＝]|Get-Date\\s*输出|事件时间已核实|【时间未核实】|\\b[0-9a-f]{7,40}\\b|\\bv\\d+(?:\\.\\d+){1,2}\\b|踩坑\\s*\\d+|版本(?:记录)?\\s*v\\d+(?:\\.\\d+){1,2}",
  promise_words: "包在我身上|肯定能|绝对没问题|保证(?!不|无法)|一定可以|放心(?:，|,)?肯定|万无一失",
  source_mark: "来源|出处|via|source|reference|引自|参考",
  domain_words: "DSH|dsh|插件|技能|规则|配置|迁移|手册|会话|装配|profile|bundle",
  plan_instruction: "方案|调整|补充|建议|评估|草案|完善|优化|改进|提炼|重构|梳理",
  write_instruction: "落盘|写入|发布|正式写入|正式落盘|改为|改成|保存到手册|写进手册|确定为|确认后(?:落盘|写入|发布)",
  execute_action: "执行|推进|实施|开始|落实|继续|启动|办理|开展|落地|操作|运行",
  tech_term:
    "\\b(?:API|JSON|REST|WebSocket|OAuth|JWT|ORM|Schema|SSR|CSR|DI|Docker|Kubernetes|K8s|npm|pnpm|Node\\.js|TypeScript|Git)\\b|正则(?:表达|表达式)?|异步|回调|闭包|哈希|令牌|中间件|依赖注入|虚拟DOM|虚拟 DOM|数据库|SQL|序列化|反序列化|面向对象|函数式|类型推断|泛型",
  term_explanation: "例如|比如|即\\b|就是|简单说|换言之|类比|也就是说|通俗|直白|理解为|打个比方|举个例子",
  suggest_words: "我建议|建议用|推荐|更优方案|建议(?:是|考虑|换成|用|来)|档位建议|不如换|优化建议",
  negating_suggestion:
    "(?:不再|不重复|避免|停止|取消|暂不|未再|不要(?:再)?|以后(?:不|别)|今后(?:不|别)|已呼应|已回应|无(?:新)?(?:建议|重复)|没有(?:新)?(?:建议|重复)|只等待)",
  paraphrase_before:
    "(?:用户|你|他|她|它|对方|作者|维护者|客户|大家|网友|某人|群友|别人).{0,6}?(?:说|说过|表示|提到|提到过|称|强调|认为|写道|原话)",
  paraphrase_mark_before: "引述|引用|原文|转述|转发|据\\S{0,5}说|写过|改成|改为|换成",
  paraphrase_mark_after: "改成|改为|换成|转述|引用"
};

// ── ② 同批样本句 ──
const SAMPLES = {
  time_words: ["今天", "昨天", "前天", "上周", "本周", "刚才", "5 分钟前", "5分钟前", "3 分钟前", "明天", "today", "yesterday"],
  historic_date: ["8月27日", "2026年8月27日", "2026-08-27", "2026/8/27", "2026.8.27", "8-27", "昨天", "2026年"],
  evidence_mark: [
    "日志 ts=2026-08-27T15:21:05Z", "日志 时间戳=...", "mtime", "启动时间", "进程 StartTime", "文件 修改时间",
    "来源：xx", "ts：12:00", "ts=12:00", "Get-Date 输出", "事件时间已核实", "【时间未核实】",
    "abc1234def", "v4.163", "v4.163.2", "踩坑 120", "版本记录 v4.5", "版本 v4.5", "随机文本", "MTIME"
  ],
  promise_words: ["包在我身上", "肯定能", "绝对没问题", "保证", "保证不", "保证无法", "一定可以", "放心，肯定", "放心,肯定", "万无一失", "也许可以"],
  source_mark: ["来源", "出处", "via", "source", "reference", "引自", "参考", "SOURCE", "随便"],
  domain_words: ["DSH", "dsh", "插件", "技能", "规则", "配置", "迁移", "手册", "会话", "装配", "profile", "bundle", "PROFILE", "hello"],
  plan_instruction: ["方案", "调整", "补充", "建议", "评估", "草案", "完善", "优化", "改进", "提炼", "重构", "梳理", "执行", "今天天气"],
  write_instruction: ["落盘", "写入", "发布", "正式写入", "正式落盘", "改为", "改成", "保存到手册", "写进手册", "确定为", "确认后落盘", "确认后写入", "随便"],
  execute_action: ["执行", "推进", "实施", "开始", "落实", "继续", "启动", "办理", "开展", "落地", "操作", "运行", "方案"],
  tech_term: ["API", "JSON", "WebSocket", "K8s", "npm", "Node.js", "TypeScript", "Git", "正则", "正则表达式", "异步", "回调", "闭包", "哈希", "令牌", "中间件", "依赖注入", "虚拟DOM", "虚拟 DOM", "数据库", "SQL", "序列化", "反序列化", "面向对象", "函数式", "类型推断", "泛型", "普通文本"],
  term_explanation: ["例如", "比如", "即", "就是", "简单说", "换言之", "类比", "也就是说", "通俗", "直白", "理解为", "打个比方", "举个例子", "随便"],
  suggest_words: ["我建议", "建议用", "推荐", "更优方案", "建议是", "建议考虑", "建议换成", "建议用", "建议来", "档位建议", "不如换", "优化建议", "我执行"],
  negating_suggestion: ["不再", "不重复", "避免", "停止", "取消", "暂不", "未再", "不要再", "不要", "以后不", "以后别", "今后不", "今后别", "已呼应", "已回应", "无建议", "无新建议", "无重复", "没有建议", "没有新建议", "没有重复", "只等待", "我建议用这个方案"],
  paraphrase_before: ["用户说", "用户之前说", "他说", "他说过", "她表示", "它提到", "对方提到过", "作者称", "维护者强调", "客户认为", "大家写道", "网友说", "某人说", "群友说", "别人说", "我保证", "保证", "随便"],
  paraphrase_mark_before: ["引述", "引用", "原文", "转述", "转发", "据用户说", "据作者说", "写过", "改成", "改为", "换成", "随便"],
  paraphrase_mark_after: ["改成", "改为", "换成", "转述", "引用", "随便"]
};

// ── 用例 1：迁移前基线 vs 迁移后实现 —— 全键 × 全样本逐条一致 ──
useChinesePatterns();
let compared = 0;
for (const key of Object.keys(LEGACY)) {
  const before = new RegExp(LEGACY[key], "i");
  const after = patRe(key);
  for (const s of SAMPLES[key]) {
    compared++;
    assert.equal(after.test(s), before.test(s), `等价性失败：键=${key} 样本="${s}"`);
  }
}
console.log(`检测正则等价性（${Object.keys(LEGACY).length} 键 × ${compared} 样本）：PASS`);

// ── 用例 2：注入后生效 source 与基线逐字一致 ──
{
  const eff = effectivePatterns();
  for (const key of Object.keys(LEGACY)) assert.equal(eff[key], LEGACY[key], `生效 source 不一致：${key}`);
  assert.equal(Object.keys(TEST_PATTERNS_ZH).length, PATTERN_KEYS.length, "夹具正则键数应等于 PATTERN_KEYS");
  // 小批 C：A″ 形态键存在且强形态为语言无关默认
  assert.ok(PATTERN_KEYS.includes("criticism_shape") && PATTERN_KEYS.includes("criticism_weak"), "A″ 形态键应在 PATTERN_KEYS");
  assert.equal(eff.criticism_shape, "(?:[？?]{3,}|[!！]{4,})", "强形态应与迁移前一致");
  assert.equal(eff.criticism_caps_ratio, 0.6, "大写比率阈值内置默认 0.6");
}

// ── 用例 3：内置默认 = 通用最小集，不含中文 ──
{
  resetPatterns();
  const eff = effectivePatterns();
  for (const key of PATTERN_KEYS) {
    assert.doesNotMatch(eff[key], /[\u4e00-\u9fff]/, `内置默认 ${key} 含中文（发布面要求为 0）`);
  }
  assert.equal(timeWordsRe().test("昨天"), false, "内置默认不应命中中文时间词");
  assert.equal(timeWordsRe().test("yesterday"), true, "内置默认应命中英文时间词");
  assert.equal(sourceMarkRe().test("来源"), false);
  assert.equal(sourceMarkRe().test("via"), true);
  assert.equal(evidenceMarkRe().test("abc1234def"), true, "commit 锚是语言无关的，内置默认保留");
  console.log("检测正则内置默认（通用最小集）无中文 + 英文能力在位：PASS");
}

// ── 用例 4：setPatterns 语义边界 ──
{
  resetPatterns();
  assert.equal(hasPatternOverride(), false);
  assert.equal(setPatterns(undefined).noop, true);
  assert.equal(hasPatternOverride(), false);

  useChinesePatterns();
  assert.equal(hasPatternOverride(), true);
  assert.equal(setPatterns(undefined).noop, true);
  assert.equal(hasPatternOverride(), true, "undefined 不得清掉已注入的配置");

  const r = setPatterns({ time_words: "(?:今天)", bogus: "x", promise_words: "([", source_mark: "" });
  assert.deepEqual(r.applied, ["time_words"]);
  assert.deepEqual(
    r.rejected.map((x) => `${x.key}:${x.reason}`).sort(),
    ["bogus:unknown-key", "promise_words:invalid-regex", "source_mark:empty-or-not-string"]
  );
  assert.equal(patRe("time_words").test("今天"), true);
  assert.equal(patRe("promise_words").test("保证"), false, "未配置键应回内置默认（无中文）");

  setPatterns({});
  assert.equal(hasPatternOverride(), false, "空对象应回退内置默认");
  useChinesePatterns();
}

// ── 用例 5：集成层判定与迁移前语义一致 ──
{
  assert.equal(isNegatingSuggestion("不再提出新建议"), true);
  assert.equal(isNegatingSuggestion("我建议用这个方案"), false);
  assert.equal(isPromiseQuoteContext("认真一点，别说'保证'这样的词"), true);
  assert.equal(isPromiseQuoteContext("我保证能修好"), false);
  assert.equal(isQuoteOrParaphraseContext("用户之前说万无一失", promiseWordsRe()), true);
  assert.equal(isQuoteOrParaphraseContext("我昨天完成了", timeWordsRe()), false);
  // M7 提醒（经配置层正则）
  assert.equal(needsApprovalReminder("请你调整补充方案"), true);
  assert.equal(needsApprovalReminder("请把方案落盘"), false);
  assert.equal(needsApprovalReminder("调整一下然后落盘到手册"), false);
  assert.equal(needsApprovalReminder("今天天气不错"), false);
  assert.equal(needsApprovalReminder("调整补充方案", { askApproved: true }), false);
  assert.equal(needsApprovalReminder("按第三方的建议按顺序执行修改"), false);
}

console.log("patterns-config.test.js PASS");
