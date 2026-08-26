// paths.js - 解析 DSH 用户目录。
// 统一使用官方 @deepseek-ai/dsh-home-paths 的 resolveDshHome()（P1-7）：
// 优先级 = 显式配置 > $DSH_HOME > ~/.dsh，与 dsh-rules-manager 口径一致。
import { join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";

export function dshHome() {
  return resolveDshHome();
}

export function agentsFilePath() {
  return join(dshHome(), "AGENTS.md");
}

export function auditFilePath() {
  return join(dshHome(), "rule-engine.log.jsonl");
}

export function configFilePath() {
  return join(dshHome(), "rule-engine.json");
}

export function understandingFilePath() {
  return join(dshHome(), "rule-understanding.json");
}

/** dsh-rules-manager 的已禁用规则存储（引擎据此把规则标记 disabled，P0-2） */
export function disabledRulesFilePath() {
  return join(dshHome(), "disabled-rules.json");
}

/** 需求基线文件（需求覆盖校验机制，RB-09，2026-08-24） */
export function baselineFilePath() {
  return join(dshHome(), "rule-engine-baseline.json");
}

/** v0.5.7 P0-4：验证通过记录持久化文件（热重载/重启不丢——规则 23④ 证据链） */
export function verifyFilePath() {
  return join(dshHome(), "rule-engine-verify.json");
}
