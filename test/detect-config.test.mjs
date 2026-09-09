// detect-config.test.mjs - 小批 B 第一小域等价性单测（2026-09-09）
//
// 验收：text-detect.js + matcher.js 的 22 条含中文正则迁入配置后，判定与迁移前一致。
// 基线 = test/helpers.mjs 的 TEST_PATTERNS_ZH / TEST_SELF_CERT_HINTS_ZH（迁移前逐字快照，
// 与本机 rule-engine.json 同源）；本文件另用独立样本句做行为比对（不只看 source）。
import assert from "node:assert/strict";
import {
  PATTERN_KEYS,
  effectivePatterns,
  patRe,
  patMap,
  resetPatterns
} from "../lib/core/patterns.js";
import { useChinesePatterns, TEST_PATTERNS_ZH, TEST_SELF_CERT_HINTS_ZH } from "./helpers.mjs";

// 第一小域新增的键（迁移前无中文 → 现在从配置层取）
const B1_KEYS = [
  "activate_skill", "activate_approval", "activate_network", "activate_backup",
  "activate_time", "activate_promise", "activate_source",
  "delivery_claim", "internal_ref", "verify_intent", "empty_talk", "delivery_no_verify",
  "verify_evidence", "mount_mention", "mount_audit_ok", "scope_overreach", "scope_bounded",
  "apology_only", "apology_with_cause", "version_record_mention", "version_record_only", "version_sync_ok"
];

// 样本句（覆盖命中/不命中/边界）
const SAMPLES = {
  activate_skill: ["技能调用", "skill 目录", "普通文本"],
  activate_approval: ["执行命令", "删除文件", "配置修改", "看看天气"],
  activate_network: ["下载页面", "curl 请求", "境外站点", "本地文件"],
  activate_backup: ["删除前备份", "迁移数据", "普通文本"],
  activate_time: ["今天几号", "昨天的事", "日期格式", "代码审查"],
  activate_promise: ["保证完成", "肯定可以", "承诺过", "也许吧"],
  activate_source: ["引用来源", "URL 链接", "出处在哪", "随便写写"],
  delivery_claim: ["已完成", "全部通过", "修复完成", "尚未完成", "正在完成", "还没有完成"],
  internal_ref: ["手册第 3 章", "踩坑 120", "SKILL.md 写了", "条款 22", "普通描述"],
  verify_intent: ["验证目标", "交叉对照", "确认一下", "随便聊聊"],
  empty_talk: ["我记下了", "记住了", "放心，我记住了", "已经落盘"],
  delivery_no_verify: ["完成", "交付", "处理中"],
  verify_evidence: ["运行时验证", "mock 启动", "实测通过", "口头声明"],
  mount_mention: ["重启 DSH", "装配变更", "挂载检查", "普通文本"],
  mount_audit_ok: ["审计通过", "MOUNT CONSISTENT", "全量审计完成", "还没审计"],
  scope_overreach: ["我补充一下", "顺便加一个", "仅按勾选"],
  scope_bounded: ["仅按勾选", "未选项单独确认", "我补充了"],
  apology_only: ["抱歉", "我错了", "这是我的错", "原因已说明"],
  apology_with_cause: ["原因是", "改正措施", "防再犯机制", "只道歉"],
  version_record_mention: ["版本记录", "v4.163", "无版本词"],
  version_record_only: ["已记入版本记录", "只加了版本记录", "正文已同步"],
  version_sync_ok: ["正文已同步", "无需改正文", "同步完成", "只写了版本记录"]
};

// ── ① 注入后生效 source 与迁移前快照逐字一致 ──
useChinesePatterns();
{
  const eff = effectivePatterns();
  for (const k of B1_KEYS) {
    assert.ok(PATTERN_KEYS.includes(k), `PATTERN_KEYS 应含 ${k}`);
    assert.equal(eff[k], TEST_PATTERNS_ZH[k], `生效 source 与迁移前不一致: ${k}`);
  }
  console.log(`小批 B 第一小域：${B1_KEYS.length} 键 source 逐字一致：PASS`);
}

// ── ② 样本句判定：迁移前实现（new RegExp(快照,"i")）vs 迁移后（patRe） ──
{
  let n = 0;
  for (const k of B1_KEYS) {
    const before = new RegExp(TEST_PATTERNS_ZH[k], "i");
    const after = patRe(k);
    for (const s of SAMPLES[k]) {
      n++;
      assert.equal(after.test(s), before.test(s), `判定不一致: 键=${k} 样本="${s}"`);
    }
  }
  console.log(`样本句判定比对（${B1_KEYS.length} 键 × ${n} 样本）：PASS`);
}

// ── ③ 映射键 self_cert_hints：15 条 source 一致 + 判定一致 ──
{
  const m = patMap("self_cert_hints");
  const ids = Object.keys(TEST_SELF_CERT_HINTS_ZH);
  assert.equal(ids.length, 15, "self_cert_hints 应含 15 条");
  for (const id of ids) {
    assert.equal(m[id], TEST_SELF_CERT_HINTS_ZH[id], `映射 source 不一致: ${id}`);
    const before = new RegExp(TEST_SELF_CERT_HINTS_ZH[id], "i");
    const after = new RegExp(m[id], "i");
    for (const s of ["总结", "完成", "抱歉", "撞墙", "普通文本", "重启", "下载"]) {
      assert.equal(after.test(s), before.test(s), `映射判定不一致: ${id} / ${s}`);
    }
  }
  console.log(`映射键 self_cert_hints（${ids.length} 条）等价性：PASS`);
}

// ── ④ 内置默认（无注入）：语言无关、不含中文 ──
{
  resetPatterns();
  const eff = effectivePatterns();
  for (const k of B1_KEYS) {
    assert.doesNotMatch(eff[k], /[\u4e00-\u9fff]/, `内置默认 ${k} 含中文`);
  }
  const m = patMap("self_cert_hints");
  for (const id of Object.keys(m)) {
    assert.doesNotMatch(m[id], /[\u4e00-\u9fff]/, `内置默认 self_cert_hints.${id} 含中文`);
  }
  assert.equal(patRe("activate_skill").test("技能"), false, "内置默认不命中中文");
  assert.equal(patRe("activate_skill").test("skill"), true, "内置默认命中英文");
  console.log("内置默认无中文 + 英文能力在位：PASS");
  useChinesePatterns();
}

console.log("detect-config.test.js PASS");
