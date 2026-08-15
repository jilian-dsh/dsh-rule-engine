// audit.js - 审计台账（JSONL）。
// 每次拦截/纠察/自证都追加一行；超限自动裁剪保留尾部。
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { auditFilePath } from "./paths.js";

const LOG_MAX_BYTES = 512 * 1024;
const LOG_KEEP_LINES = 400;

export function audit(entry) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    appendFileSync(auditFilePath(), line, "utf8");
    trimLog();
  } catch {
    // 审计失败不阻断主流程
  }
}

function trimLog() {
  try {
    const p = auditFilePath();
    if (statSync(p).size <= LOG_MAX_BYTES) return;
    const lines = readFileSync(p, "utf8").split("\n");
    const kept = lines.slice(-LOG_KEEP_LINES).join("\n");
    writeFileSync(p, kept, "utf8");
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
