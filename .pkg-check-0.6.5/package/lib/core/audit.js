// audit.js - 审计台账（JSONL）。
// 每次拦截/纠察/自证都追加一行；超限自动裁剪保留尾部。
// P2-9：裁剪改为惰性——每 APPEND_TRIM_INTERVAL 次追加才做一次大小检查，
// 避免每次写入都 statSync（高频 deny/纠察时降低 IO）。
// B2（2026-09-03）：判定来源可溯源字段约定（判例回灌前置）——
//   verdictSource: "guard"（工具守卫 intercept，机器判定）| "lexicon"（词表直判/降级）
//   | "judge"（LLM 裁决分流）| "llm-intent"（意图 LLM 兜底）；缺失 = 历史记录（无此字段）。
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { auditFilePath } from "./paths.js";

// 审计归档（2026-09-08 第二批 §1.1-②）：上限 512KB→2MB；超限时被裁头部先写入
// <dshHome>/logs/rule-engine-archive/log-YYYYMM.jsonl（按月文件）再保留尾部——历史可回溯。
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const LOG_KEEP_LINES = 400;
const APPEND_TRIM_INTERVAL = 32;

let appendCount = 0;

export function audit(entry) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), eventId: randomUUID(), ...entry }) + "\n";
    appendFileSync(auditFilePath(), line, "utf8");
    appendCount++;
    if (appendCount >= APPEND_TRIM_INTERVAL) {
      appendCount = 0;
      trimLog();
    }
  } catch {
    // 审计失败不阻断主流程
  }
}

/** 被裁头部写入月归档（失败静默——审计裁剪本身容错） */
function archiveTrimmed(headLines) {
  try {
    const dir = join(dirname(auditFilePath()), "logs", "rule-engine-archive");
    mkdirSync(dir, { recursive: true });
    const ym = new Date().toISOString().slice(0, 7).replace("-", "");
    appendFileSync(join(dir, `log-${ym}.jsonl`), headLines.join("\n") + "\n", "utf8");
  } catch {
    // 归档失败忽略
  }
}

function trimLog() {
  try {
    const p = auditFilePath();
    if (statSync(p).size <= LOG_MAX_BYTES) return;
    const lines = readFileSync(p, "utf8").split("\n");
    const keptLines = lines.slice(-LOG_KEEP_LINES);
    const head = lines.slice(0, Math.max(0, lines.length - LOG_KEEP_LINES)).filter(Boolean);
    if (head.length) archiveTrimmed(head);
    writeFileSync(p, keptLines.join("\n"), "utf8");
  } catch {
    // 裁剪失败忽略
  }
}

export function readAuditLog(n) {
  try {
    const lines = readFileSync(auditFilePath(), "utf8").split("\n").filter(Boolean);
    return lines.slice(-n).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });
  } catch {
    return [];
  }
}
