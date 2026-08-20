// test/helpers.js - 测试辅助：临时 DSH_HOME
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
