// paths.js - 解析 DSH 用户目录。
// 不依赖 @deepseek-ai/dsh-home-paths，优先使用 DSH_HOME 环境变量，回退到 ~/.dsh。
import { homedir } from "node:os";
import { join } from "node:path";

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
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
