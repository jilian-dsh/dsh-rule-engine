// test/helpers.js - 测试辅助：临时 DSH_HOME
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 残余1 剥离后（2026-08-31）：本机回归测试夹具需注入默认偏好表（模拟本机配置 handlerDefaultMap）——
// 代码层默认表已下沉配置，测试经此表绑定执行器（与真实环境守门 consistency-live 读配置口径一致）
export const TEST_DEFAULT_MAP = {
  "1": "rule1-retry",
  "2": "rule2-time",
  "5": "rule5-source",
  "7": "rule7-promise",
  "9": "rule9-inline-bom",
  "11": "rule11-language",
  "12A": "rule12a-approval",
  "12B": "rule12b-skill",
  "12C": "rule12c-network",
  "13A": "rule13a-backup",
  "18": "rule18-manual-first",
  "21": "rule21-meta",
  "22": "rule22-7-direct",
  "23": "rule23-runtime-verify",
  "24": "rule24-assembly-type",
  "26": "rule26-release-asset",
  "27": "rule27-mount-audit"
};

export function makeTempHome() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-rule-engine-test-"));
  process.env.DSH_HOME = dir;
  return dir;
}

export function writeAgents(dir, text) {
  const file = join(dir, "AGENTS.md");
  writeFileSync(file, text, "utf8");
  return file;
}

export function cleanupTempHome(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  delete process.env.DSH_HOME;
}
