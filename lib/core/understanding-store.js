// understanding-store.js - 理解产物读写。
// rule-understanding.json 对模型只读（由守卫保护），unlock 后可改。
import { readFileSync, writeFileSync } from "node:fs";
import { understandingFilePath } from "./paths.js";

export function writeUnderstanding(configs) {
  try {
    const payload = {
      generatedAt: new Date().toISOString(),
      engine: "pattern-v1",
      rules: configs
    };
    writeFileSync(understandingFilePath(), JSON.stringify(payload, null, 2), "utf8");
    return { ok: true, path: understandingFilePath() };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

export function readUnderstanding() {
  try {
    const raw = readFileSync(understandingFilePath(), "utf8");
    return { ok: true, data: JSON.parse(raw) };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}
