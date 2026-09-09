// quality-ledger.test.mjs - 质量账本单测（第三批 §一 验收）
// 验收：①签名确定性 ②落盘格式 ③窗口对比逻辑 ④默认关不产生文件 ⑤机制不含数据
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_LEDGER_CONFIG,
  taskSignature,
  recordQuality,
  loadLedger,
  qualityTrend,
  ledgerPath
} from "../lib/core/quality-ledger.js";

// ── ① 签名确定性 + 归一化 ──
{
  const a = taskSignature("给插件加一个设置项", ["npm test 全绿"]);
  const b = taskSignature("给插件加一个设置项", ["npm test 全绿"]);
  assert.equal(a, b, "同输入必须同签名");
  assert.equal(a.length, 12, "签名取 12 位");
  assert.match(a, /^[0-9a-f]{12}$/, "签名是十六进制");

  // 归一化：数字/路径/引号/大小写/空白不影响签名
  const c = taskSignature("修复 3 个 bug（D:\\x\\y.js）", ["测试 12 条通过"]);
  const d = taskSignature("修复 7 个 bug（C:\\a\\b.js）", ["测试 99 条通过"]);
  assert.equal(c, d, "数字与绝对路径应被归一化");
  assert.equal(taskSignature("ABC"), taskSignature("abc"), "大小写归一化");
  assert.equal(taskSignature("a   b"), taskSignature("a b"), "空白归一化");
  // 不同语义必须不同签名
  assert.notEqual(taskSignature("加设置项"), taskSignature("删设置项"), "不同语义签名不同");
}

// ── ② 落盘格式 + ④ 默认关不产生文件 ──
{
  const home = mkdtempSync(join(tmpdir(), "qledger-"));
  try {
    // 默认关：不落盘、不建文件
    const off = recordQuality({ purpose: "默认关测试" }, { home });
    assert.equal(off.ok, false);
    assert.equal(off.skipped, "disabled");
    assert.equal(existsSync(ledgerPath(home)), false, "默认关不得产生文件");

    // 显式开启：落盘 jsonl，一行一条，字段齐全
    const cfg = { ...DEFAULT_LEDGER_CONFIG, enabled: true };
    const r1 = recordQuality({ purpose: "任务甲", assertions: ["a"], rework: 1, interventions: 2, frictions: 3, tokens: 100 }, { home, config: cfg, now: 1000 });
    assert.equal(r1.ok, true);
    recordQuality({ purpose: "任务甲", assertions: ["a"], rework: 0, interventions: 1, frictions: 1, tokens: 50 }, { home, config: cfg, now: 2000 });

    const lines = readFileSync(ledgerPath(home), "utf8").trim().split("\n");
    assert.equal(lines.length, 2, "两条记录两行");
    const rec = JSON.parse(lines[0]);
    assert.deepEqual(Object.keys(rec).sort(), ["frictions", "interventions", "rework", "sig", "tokens", "ts"], "字段齐全且无原文");
    assert.equal(rec.ts, 1000);
    assert.equal(typeof rec.sig, "string");
    // 隐私：落盘内容不含任务原文
    assert.doesNotMatch(readFileSync(ledgerPath(home), "utf8"), /任务甲/, "落盘不得含任务原文（单向指纹）");

    // ── ③ 窗口对比 ──
    const sig = taskSignature("任务甲", ["a"]);
    for (let i = 0; i < 10; i++) {
      // 前 5 单高返工，后 5 单低返工 → 应判「改善」
      const rework = i < 5 ? 3 : 0;
      recordQuality({ purpose: "任务甲", assertions: ["a"], rework, interventions: 1, frictions: 1, tokens: 10 }, { home, config: cfg, now: 3000 + i });
    }
    const t = qualityTrend(sig, { home, config: cfg, window: 5 });
    assert.equal(t.count, 12, "同签名共 12 单");
    assert.equal(t.recent.length, 5);
    assert.equal(t.previous.length, 5);
    assert.equal(t.metrics.rework.before, 3, "前窗均值 3");
    assert.equal(t.metrics.rework.after, 0, "后窗均值 0");
    assert.equal(t.metrics.rework.direction, "改善");
    assert.match(t.summary, /改善|持平/, "汇总应给出方向");

    // 反向：后窗变差 → 恶化
    for (let i = 0; i < 5; i++) {
      recordQuality({ purpose: "任务甲", assertions: ["a"], rework: 9, interventions: 1, frictions: 1, tokens: 10 }, { home, config: cfg, now: 4000 + i });
    }
    const t2 = qualityTrend(sig, { home, config: cfg, window: 5 });
    assert.equal(t2.metrics.rework.direction, "恶化");
    assert.match(t2.summary, /恶化/);

    // 样本不足
    const t3 = qualityTrend(taskSignature("从未记录的任务"), { home, config: cfg });
    assert.equal(t3.count, 0);
    assert.match(t3.summary, /样本不足/);

    // 坏行跳过（账本是旁路数据）
    const fs2 = await import("node:fs");
    fs2.appendFileSync(ledgerPath(home), "{bad json}\n", "utf8");
    assert.equal(loadLedger({ home }).length, 17, "坏行不影响读取（2+10+5=17 条有效记录）");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

console.log("quality-ledger.test.js PASS");
