// lexicon-config.test.mjs - P8 小批 A：词表配置化等价性 + 双层模型单测（2026-09-08）
//
// 验收目标（第三方 §2.1）：迁移前后对同批样本句判定一致；发布面无中文行为词表。
// 等价性证明方式（不循环）：
//   ① 迁移前基线 LEGACY = 迁移前 lexicon.js 11 张表的逐字快照（硬编码在本文件，与运行时机制解耦）；
//   ② 对同一批样本句，比较「迁移前实现」new RegExp(LEGACY[key], "i").test(s)
//      与「迁移后实现」lexRe(key).test(s) —— 全样本、全键必须逐条一致。
import assert from "node:assert/strict";
import {
  LEXICON_KEYS,
  effectiveLexicons,
  lexRe,
  setLexicons,
  resetLexicons,
  hasLexiconOverride,
  approvalExecRe,
  actionWordsRe,
  questionWordsRe
} from "../lib/core/lexicon.js";
import { TEST_LEXICONS_ZH, useChineseLexicons } from "./helpers.mjs";

// ── ① 迁移前基线（迁移前 lexicon.js 逐字快照；独立于当前实现，作为对照物）──
const LEGACY = {
  approval: "(?:确认|同意|批准|授权|可以|允许|好|行|ok|yes)",
  exec_follow: "(?:即可|现在|马上|继续|开始|执行|落盘|去做|实施|进行|删除|修改|改|补|修|做|写入|创建|安装|发布|下载|提交|运行)",
  plan_only: "确认方案|确认理解|确认方向|确认无误|理解了|明白方向|了解|没问题|收到",
  action_words:
    "执行|跑|落|落盘|认可|开始|写入|写(?:下|好|完|成|作|文件)?|保存|另存为|删除|修改|改(?:为|成|动|一下|进|善)?|补(?:上|齐|全|充|写)?|修(?:改|复|一下)?|做(?:好|完|一下)?|创建|建(?:设|立|好|一下|个|一个)?|安装|发布|下载|提交|推送|push|运行|修复|替换|重建|启动|重启|停止|卸载|开始改|开始写|改进|优化|增强|完善|升级|迁移|整理|调整|实现|实施|添加|增加|补充|重写|改造|调试|排查|处理|解决|继续|推进|更新|部署|核实|梳理|诊断|对齐|跟进|落实|设计并实现|调查|开工|动手|进行|完成|选择|采纳|选定|产出|编写|撰写|生成|审查|阅读|查看|核对|检查|审阅|复核|查阅|验证|对照|调研|研究|转化|转换|读取|读(?:出|一下|一遍|完|出来)?|展示|打开|提取|还原|导入|导出|清理|移除|清空|残留|合入|合并|并入|融合|整合|起草|开展|搭建|重构|兼容|投产|校验|核验|过一遍|跑一遍|复验",
  strong_exec:
    "执行吧|开始执行|直接执行|立即执行|现在执行|马上执行|请落盘|开始写|开始改|执行以下|执行第|执行这个|执行它|落盘|开始蒸馏|开始迁移|开始修复|开始改进|开始优化|采纳|选定",
  directive:
    "(?:请\\s*)?(?:删除|移除|修改|编辑|替换|写入|写(?:下|好|完|成|作|文件)?|保存|另存为|创建|复制|移动|执行|运行|下载|提交|推送|备份|安装|卸载|清理|启动|停止|重建|修复|改(?:为|成|动|一下)?|补(?:上|齐|全|充|写)?|修(?:改|复|一下)?|做(?:好|完|一下)?|实施|推进|继续|处理|解决)",
  rejection: "(?:不允许|拒绝|不要|不同意|取消(?:这次|并停)?|(?:^|[^是])否(?:[^则]|$)|no(?!tes?|thing|pe)\\b|\\bno\\b|No)",
  question: "[？?]|吗|为什么|是否|能不能|行不行|难道|是不是|能否|怎么|为何|是否要|影响吗|可以吗|要不要|需不需要",
  status_signal:
    "(?:我已|我已经|我(?:们)?(?:刚)?(?:重启|输入|执行|完成|搞定|做完|弄好|输完|输好))(?:了|完毕|完成|好)?|(?:^|\\s)(?:已|已经)?(?:重启|输入|执行|完成|搞定|做完|弄好|输完|输好|unlock)(?:了|完毕|完成|好)?(?:\\s|$)|(?:^|\\s)已经(?:刚)?(?:重启|输入|执行|完成|搞定|做完|弄好|输完|输好|unlock)[^\\s]*(?:\\s|$)|(?:^|\\s)(?:重启|输入|命令|操作)(?:完成|完毕|好了|已输入)(?:\\s|$)|(?:^|\\s)好了(?:\\s|$)|^(?:done|restarted|finished|entered)$",
  dangerous_action: "删除|覆盖|移除|清空|卸载|remove-item|rm\\s+-r|del\\s+"
};

// ── ② 同批样本句（覆盖各表的命中/不命中/边界形态）──
const SAMPLES = {
  approval: ["确认", "同意", "批准", "授权", "可以", "允许", "好", "行", "ok", "YES", "Ok", "不行", "拒绝", "随便"],
  exec_follow: ["即可", "现在", "马上", "继续", "开始", "执行", "落盘", "去做", "实施", "进行", "删除", "修改", "写入", "创建", "安装", "发布", "下载", "提交", "运行", "run", "deploy", "确认", "方案"],
  plan_only: ["确认方案", "确认理解", "确认方向", "确认无误", "理解了", "明白方向", "了解", "没问题", "收到", "确认并执行", "执行"],
  action_words: ["执行", "跑", "落盘", "认可", "写入", "保存", "删除", "修改", "补齐", "创建", "建立", "安装", "发布", "提交", "推送", "push", "运行", "修复", "重构", "部署", "核实", "设计并实现", "过一遍", "复验", "确认", "方案", "为什么", "done"],
  strong_exec: ["执行吧", "开始执行", "直接执行", "立即执行", "现在执行", "马上执行", "请落盘", "开始写", "开始改", "执行以下", "执行第", "执行这个", "执行它", "落盘", "开始蒸馏", "开始迁移", "开始修复", "开始改进", "开始优化", "采纳", "选定", "执行", "确认"],
  directive: ["请删除", "请 修改", "移除", "修改", "编辑", "替换", "写入", "保存", "另存为", "创建", "复制", "移动", "执行", "运行", "下载", "提交", "推送", "备份", "安装", "卸载", "清理", "启动", "停止", "重建", "修复", "实施", "推进", "继续", "处理", "解决", "方案", "看看"],
  rejection: ["不允许", "拒绝", "不要", "不同意", "取消", "取消这次", "取消并停", "否", "是否", "no", "No", "no thanks", "nothing", "yes"],
  question: ["为什么", "是否", "能不能", "行不行", "难道", "是不是", "能否", "怎么", "为何", "是否要", "影响吗", "可以吗", "要不要", "需不需要", "吗", "?", "？", "。", "done"],
  status_signal: [
    "我已重启", "我已经输入", "我们刚重启", "我完成了", "我搞定了", "我弄好了", "我输完了", "我输好了",
    "已重启", "已经执行", "重启了", "输入完毕", "执行完成", "搞定好", "做完", "弄好", "输完", "输好", "unlock",
    "已经重启", "已经输入完成", "重启完成", "输入完毕", "命令完成", "操作好了", "已输入", "好了",
    "done", "restarted", "finished", "entered", "DONE", "我删除了文件", "重启服务", "完成 A 和 C 两项"
  ],
  dangerous_action: ["删除", "覆盖", "移除", "清空", "卸载", "remove-item", "rm -r", "del /s", "修改", "done"]
};

// ── 用例 1：迁移前基线 vs 迁移后实现 —— 同批样本句判定逐条一致 ──
useChineseLexicons();
for (const key of Object.keys(LEGACY)) {
  const before = new RegExp(LEGACY[key], "i");
  const after = lexRe(key);
  for (const s of SAMPLES[key]) {
    assert.equal(after.test(s), before.test(s), `等价性失败：键=${key} 样本="${s}"`);
  }
}
console.log("词表等价性（9 键 × 样本全量比对）：PASS");

// ── 用例 2：注入后生效 source 与基线逐字一致（键齐全性）──
{
  const eff = effectiveLexicons();
  for (const key of Object.keys(LEGACY)) {
    assert.equal(eff[key], LEGACY[key], `生效 source 与迁移前不一致：${key}`);
  }
  assert.equal(Object.keys(TEST_LEXICONS_ZH).length, 10, "夹具应含 10 张显式表（approval_exec 为派生键）");
  assert.ok(LEXICON_KEYS.includes("approval_exec"), "approval_exec 应在键清单中");
}

// ── 用例 3：派生键 approval_exec 的组合语义与迁移前公式一致 ──
{
  const legacyCombo = new RegExp(LEGACY.approval + "[^\\n]{0,16}" + LEGACY.exec_follow, "i");
  const samples = [
    "确认，现在执行", "同意马上做", "可以，执行吧", "确认方案", "确认",
    "批准\n执行", "授权" + "x".repeat(20) + "执行", "ok now run", "好的继续", "不行，别执行"
  ];
  for (const s of samples) {
    assert.equal(approvalExecRe().test(s), legacyCombo.test(s), `approval_exec 派生不一致：${s}`);
  }
}

// ── 用例 4：内置默认（无注入）= 通用最小集，且不含任何中文字符 ──
{
  resetLexicons();
  const eff = effectiveLexicons();
  for (const key of LEXICON_KEYS) {
    assert.doesNotMatch(eff[key], /[\u4e00-\u9fff]/, `内置默认 ${key} 含中文（发布面要求为 0）`);
  }
  // 内置默认下中文样本不命中（证明通用层与个人层已分离）
  assert.equal(actionWordsRe().test("执行"), false, "内置默认不应命中中文动作词");
  assert.equal(questionWordsRe().test("为什么"), false, "内置默认不应命中中文疑问词");
  // 内置默认仍保留语言无关能力
  assert.equal(actionWordsRe().test("deploy"), true, "内置默认应命中英文动作词");
  assert.equal(questionWordsRe().test("why"), true, "内置默认应命中英文疑问词");
  console.log("内置默认（通用最小集）无中文 + 英文能力在位：PASS");
}

// ── 用例 5：setLexicons 语义边界 ──
{
  // undefined/null = 不干预（保持当前状态）
  resetLexicons();
  assert.equal(hasLexiconOverride(), false);
  const r1 = setLexicons(undefined);
  assert.equal(r1.noop, true, "undefined 应标记 noop");
  assert.equal(hasLexiconOverride(), false);

  useChineseLexicons();
  assert.equal(hasLexiconOverride(), true);
  const r2 = setLexicons(undefined);
  assert.equal(r2.noop, true);
  assert.equal(hasLexiconOverride(), true, "undefined 不得清掉已注入的词表");

  // 对象 = 配置即真相；非法键/非法正则被拒绝且不影响其余键
  const r3 = setLexicons({ approval: "(?:确认)", bogus_key: "x", action_words: "([", question: "" });
  assert.deepEqual(r3.applied, ["approval"]);
  assert.deepEqual(
    r3.rejected.map((x) => `${x.key}:${x.reason}`).sort(),
    ["action_words:invalid-regex", "bogus_key:unknown-key", "question:empty-or-not-string"]
  );
  assert.equal(lexRe("approval").test("确认"), true);
  // 未配置的键回退内置默认（英文最小集），不残留上一次注入
  assert.equal(lexRe("action_words").test("执行"), false, "未配置键应回内置默认");

  // {} = 无有效键 = 回退内置默认
  setLexicons({});
  assert.equal(hasLexiconOverride(), false, "空对象应回退内置默认");

  useChineseLexicons(); // 还原夹具，供后续测试/单独运行
  assert.equal(lexRe("action_words").test("执行"), true);
}

// ── 用例 6：集成层（公共 API）判定与迁移前语义一致 ──
{
  const { isAuthMessage, isDirectiveMessage, isApprovalText, isRejectionText, isQuestionMessage } =
    await import("../lib/core/authorization.js");
  const { isStatusSignal, parseUserIntents } = await import("../lib/core/intent.js");

  assert.equal(isAuthMessage("确认，现在执行"), true);
  assert.equal(isAuthMessage("确认方案"), false);
  assert.equal(isAuthMessage("可以执行吗？"), false, "询问句不算授权");
  assert.equal(isDirectiveMessage("请删除这个文件"), true);
  assert.equal(isApprovalText("执行"), true);
  assert.equal(isApprovalText("确认方案"), false);
  assert.equal(isRejectionText("不允许"), true);
  assert.equal(isQuestionMessage("为什么"), true);
  assert.equal(isStatusSignal("我已重启"), true);
  assert.equal(isStatusSignal("我删除了文件"), false, "危险动作词不作状态信号");
  assert.equal(parseUserIntents("1、执行 A 2、评估 B").clauses[0].type, "execute");
  assert.equal(parseUserIntents("1、执行 A 2、评估 B").clauses[1].type, "plan");
}

console.log("lexicon-config.test.js PASS");
