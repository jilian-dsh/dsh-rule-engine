// intent-checks-config.test.mjs - 分点级意图判定词迁配置层（第三批，2026-09-21）
//
// ① 等价性证明方式（不循环）：LEGACY = 迁移前 intent.js 九条正则的**逐字快照**（硬编码于本文件）；
//    「迁移前实现」= 直接用这九条编；「迁移后实现」= 经 patterns.intent_checks（patMap）取值后编同一条。
//    比较面：extractTag／TAG_RE 判定、parseUserIntents 的**逐子句完整产物**（type/tag/各布尔位/ambiguous）、
//    isStatusSignal（status_exclude 分支）。
// ② flags 口径：specific_action 与 at_action 用 "i"（其余空）——两面同口径，逐条断言。
// ③ 形态正则不迁：NUMBERED_ITEM_RE／AT_REF_RE 仍留 intent.js（只断言其行为在迁移前后一致）。
import assert from "node:assert/strict";
import { parseUserIntents, extractTag, TAG_RE, isStatusSignal } from "../lib/core/intent.js";
import { patMap, setPatterns, resetPatterns } from "../lib/core/patterns.js";
import { questionWordsRe, actionWordsRe, strongExecRe, statusSignalRe, dangerousActionRe } from "../lib/core/lexicon.js";
import { hasHotwordAction } from "../lib/core/hotwords.js";
import { useChinesePatterns, TEST_PATTERNS_ZH } from "./helpers.mjs";

// ── ① 迁移前基线：九条逐字快照（flags 与迁移前一致）──
const LEGACY = [
  ["tag", "【(执行|方案|问询|信息)】", ""],
  ["defer", "待确认|确认后再|等我确认|先方案|先别|不要执行|之后再说|确认后|再确认|先确认|不要直接", ""],
  [
    "conditional",
    "(?:完成|结束|做完|弄完|搞定|好了|恢复|重启?)\\s*(?:了|之后|后|以后|再)|(?:等|待|等\\s*[\\u4e00-\\u9fff]{0,6}?)\\s*[\\u4e00-\\u9fff]{0,8}?(?:后|之后|了)\\s*|(?:推送|上传|提交|发布|执行)\\s*(?:完成|结束|完|好)\\s*(?:了|之?后)?",
    ""
  ],
  ["plan", "方案|建议|评估|分析|设计|规划|计划|给出|提供", ""],
  [
    "specific_action",
    "写入|写(?:下|好|完|成|作|文件)?|保存|另存为|删除|修改|改(?:为|成|动|一下|进|善)?|补(?:上|齐|全|充|写)?|修(?:改|复|一下)?|做(?:好|完|一下)?|创建|安装|发布|下载|提交|运行|修复|替换|重建|启动|重启|停止|卸载|改进|优化|增强|完善|升级|迁移|整理|调整|实现|实施|添加|增加|补充|重写|改造|调试|排查|处理|解决|更新|部署|核实|梳理|诊断|对齐|跟进|落实|设计并实现|调查|产出|编写|撰写|生成|审查|阅读|查看|核对|检查|审阅|复核|查阅|验证|对照|调研|研究|转化|转换|读取|读(?:完|出|一下|一遍|出来)?|展示|打开|提取|还原|导入|导出|采纳|选择|选定|落盘|落地|清理|移除|清空|合入|合并|并入|融合|整合|起草|开展|搭建|重构|兼容|投产|校验|核验|过一遍|跑一遍|复验",
    "i"
  ],
  [
    "plan_executing",
    "(?:方案|计划|步骤|清单|安排)[^\\n]{0,16}?(?:执行|开始|继续|开工|去做|照做|落地)|(?:执行|开始|继续|做)[^\\n]{0,12}(?:该|此|这个|上述|已有|给出(?:的)?|拟定(?:的)?)?方案",
    ""
  ],
  [
    "plan_request",
    "(?:给出|提供|出|设计|评估|分析|规划|计划|整理|拟定|撰写|编写|看看|讲解|说说|如何|怎么|哪里|要(?:一|个|份)|需?(?:要|求)(?:一|个|份)?)",
    ""
  ],
  ["at_action", "看|读|改|写|转|查|处理|提取|打开|展示|审阅|检查|分析|整理|校对|核对|还原|更新|删除|移动|执行|处理", "i"],
  ["status_exclude", "^(?:请|帮我)?\\s*(?:先|接着|然后)?\\s*(?:完成|重启|执行|搞定|做完|弄好)\\s+\\S", ""]
];
const legacyRe = (key) => {
  const row = LEGACY.find(([k]) => k === key);
  return new RegExp(row[1], row[2]);
};

// ── ② 迁移前实现（照抄旧 classifyClause／splitClauses／normalizeTag 口径）──
const TAG_RE_LEGACY = legacyRe("tag");
const NUMBERED_ITEM_RE = /^\s*(?:\(?(\d+)[\)\.．)]\s*)/;
const AT_REF_RE = /(?:^|[\s（(【《"'，。；：！？])\s*@(?:["']?(?:[A-Za-z]:[\\/]|[^"'\\\s，。；：！？（）【】《》、]+\.(?:docx?|md|txt|pdf|json|ya?ml|xlsx?|csv|pptx?|html?|zip|mjs|js|ts|py|exe|ps1)))/i;
const ALIAS = { "执行": "execute", "方案": "plan", "问询": "question", "信息": "info" };

function extractTagLegacy(text) {
  const m = String(text || "").match(TAG_RE_LEGACY);
  return m ? m[1] : "";
}
function isStatusSignalLegacy(text) {
  const t = String(text || "");
  if (legacyRe("status_exclude").test(t.trim())) return false;
  return statusSignalRe().test(t) && !dangerousActionRe().test(t);
}
function classifyClauseLegacy(raw) {
  const text = String(raw || "").trim();
  const tagType = ALIAS[extractTagLegacy(text).trim()] || null;
  const hasQuestion = questionWordsRe().test(text);
  const hasDefer = legacyRe("defer").test(text);
  const hasAction = actionWordsRe().test(text) || hasHotwordAction(text);
  const hasPlan = legacyRe("plan").test(text);
  const hasStrongExec = strongExecRe().test(text);
  const hasAtRef = AT_REF_RE.test(text) && legacyRe("at_action").test(text);
  let type = "info";
  let ambiguous = false;
  if (tagType) {
    if (tagType === "execute" && hasQuestion) {
      type = "ambiguous";
      ambiguous = true;
    } else type = tagType;
  } else if (hasQuestion) type = "question";
  else if (isStatusSignalLegacy(text)) type = "status";
  else if (legacyRe("conditional").test(text)) type = "conditional";
  else if (hasDefer && hasAction) type = "plan";
  else if (hasAction && hasPlan && !legacyRe("specific_action").test(text) && !(legacyRe("plan_executing").test(text) && !legacyRe("plan_request").test(text))) type = "plan";
  else if (hasAction) type = "execute";
  else if (hasPlan && !hasStrongExec) type = "plan";
  else if (hasAtRef) type = "execute";
  else if (hasPlan) type = "plan";
  return { type, hasAction, hasQuestion, deferred: hasDefer, ambiguous };
}

// ── ③ 样本池（覆盖九子键与主要分支）──
const SAMPLES = [
  "1、执行 2、方案 3、问询",
  "【执行】改文件",
  "【执行】这个怎么办？",
  "【方案】给我一个计划",
  "【问询】怎么回事",
  "【信息】知道了",
  "先别动，等我确认再说",
  "待确认：是否删除",
  "推送完成后发地址",
  "等测试跑完了再发布",
  "给我一个方案",
  "按已有方案依次执行",
  "上述方案执行",
  "将建议书内容转化到业务通告中",
  "改进一下这个提示词",
  "请直接执行",
  "再检查一遍测试",
  "重启服务",             // status_exclude 应排除
  "我已重启",
  "重启完成",
  "@reports/INDEX.md 读一下",
  "看下 @D:/x/y.md",
  "邮箱 a@b.com 不是引用",
  "完成 A 和 C 两项",
  "给出执行方案",
  "设计方案并实现",
  "1. 跑测试\n2. 提交代码",
  "【标题】正文内容",
  "帮我做三件事：1、改配置 2、跑测试 3、发报告",
  "",
  "no keywords here"
];

// ── ④ 默认层（未注入）：九键内置默认＝语言无关最小集（无中文）──
resetPatterns();
const builtin = patMap("intent_checks");
assert.deepEqual(Object.keys(builtin).sort(), LEGACY.map(([k]) => k).sort(), "内置默认九子键齐备");
for (const [k, v] of Object.entries(builtin)) {
  assert.doesNotMatch(v, /[\u4e00-\u9fff]/, `内置默认 intent_checks.${k} 含中文（应语言无关）`);
}
// 英文默认可用性抽验（证明默认不是空串占位）
assert.ok(new RegExp(builtin.plan, "i").test("give me a plan"), "内置 plan 命中英文样本");
assert.ok(new RegExp(builtin.specific_action, "i").test("Please DELETE the file"), "内置 specific_action 命中英文样本（i 生效）");
assert.ok(new RegExp(builtin.status_exclude).test("restart the service"), "内置 status_exclude 命中英文命令式");
assert.ok(!new RegExp(builtin.status_exclude).test("I have restarted"), "内置 status_exclude 不误伤状态确认");

// ── ⑤ 个人层（中文夹具）注入后：与 LEGACY 逐字一致 ──
const injected = useChinesePatterns();
assert.deepEqual(injected.rejected, [], "中文夹具注入无拒绝");
const map = patMap("intent_checks");
assert.deepEqual(Object.keys(map).sort(), LEGACY.map(([k]) => k).sort(), "九子键齐备");
for (const [key, src] of LEGACY) {
  assert.equal(map[key], src, `intent_checks.${key} 源与 LEGACY 逐字一致`);
}
assert.deepEqual(Object.keys(TEST_PATTERNS_ZH.intent_checks).sort(), LEGACY.map(([k]) => k).sort(), "夹具九子键齐备");

// ── ⑥ 缓存活性自证：切换配置后**立即**生效（缓存锁死时此段必红）──
//    观察量取 extractTag（＝TAG_RE 取词结果），不受"标签归一化"影响。
{
  const before = extractTag("【A】改文件");
  const r = setPatterns({ intent_checks: { tag: "【(A|B)】" } });
  assert.deepEqual(r.rejected, [], "自定义 tag 源被接受");
  const after = extractTag("【A】改文件");
  assert.equal(before, "", "旧配置下【A】不是标签（内置源不认它）");
  assert.equal(after, "A", "setPatterns 后立即生效（缓存已清）");
  // resetPatterns 同样要清：回退内置英文源后【A】不再被认作标签
  resetPatterns();
  assert.equal(extractTag("【A】改文件"), "", "resetPatterns 后回退内置默认（缓存已清）");
  assert.equal(extractTag("【execute】x"), "execute", "内置英文标签源可用");
  useChinesePatterns(); // 还原夹具供后续断言
  assert.equal(extractTag("【执行】x"), "执行", "夹具注入后中文标签恢复可用");
}

// ── ⑦ 逐样本等价：extractTag／TAG_RE／isStatusSignal／parseUserIntents 全产物 ──
for (const s of SAMPLES) {
  const label = JSON.stringify(s.slice(0, 30));
  assert.equal(extractTag(s), extractTagLegacy(s), `extractTag 等价：${label}`);
  assert.equal(!!TAG_RE()?.test(s), !!TAG_RE_LEGACY.test(s), `TAG_RE 判定等价：${label}`);
  assert.equal(isStatusSignal(s), isStatusSignalLegacy(s), `isStatusSignal 等价：${label}`);
  const nowI = parseUserIntents(s);
  const oldI = { clauses: nowI.clauses.map((c) => classifyClauseLegacy(c.raw)) };
  for (let i = 0; i < nowI.clauses.length; i++) {
    const a = nowI.clauses[i];
    const b = oldI.clauses[i];
    assert.deepEqual(
      { type: a.type, tag: String(a.tag || ""), hasAction: a.hasAction, hasQuestion: a.hasQuestion, deferred: a.deferred, ambiguous: a.ambiguous },
      { type: b.type, tag: String(extractTagLegacy(a.raw) || ""), hasAction: b.hasAction, hasQuestion: b.hasQuestion, deferred: b.deferred, ambiguous: b.ambiguous },
      `子句产物等价：${label} #${i}`
    );
  }
}

// ── ⑥ flags 口径：仅 specific_action／at_action 带 i（与 LEGACY 逐条一致）──
const FLAGS = { specific_action: "i", at_action: "i" };
for (const [key, , flags] of LEGACY) {
  assert.equal(FLAGS[key] || "", flags, `${key} 的 flags 口径与迁移前一致`);
}

// ── ⑧ 内置默认亦无中文（与 patterns 其他键同一策略；中文源只在夹具/本机配置）──
console.log("intent-checks-config.test.mjs PASS");
