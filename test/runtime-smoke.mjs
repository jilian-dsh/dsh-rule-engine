// runtime-smoke.js - 插件运行时冒烟验证（mock Cordis ctx）。
// 用临时 DSH_HOME，验证 apply() 能注册 guard 与命令、guard 回调可执行且不抛错。
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "dsh-rule-engine-runtime-"));
process.env.DSH_HOME = dir;
writeFileSync(
  join(dir, "AGENTS.md"),
  [
    "## 一、执行与安全",
    "### [规则 18] 先查手册再动手（执行等级：A 弱）",
    "- **触发**：任务涉及 DSH 插件。",
    "- **检查**：首次工具调用前未读手册。",
    "- **动作**：拒绝。",
    "- **豁免**：读取手册本身。",
    "### [规则 9] PS 编码与命令执行（执行等级：A+D）",
    "- **触发**：任何含中文的脚本/命令。",
    "- **检查**：拦内联命令。",
    "- **动作**：拒绝。",
    "- **豁免**：无。"
  ].join("\n"),
  "utf8"
);

const mod = await import("../lib/index.js");
const disposers = [];
let guardFn = null;
let registeredCommand = null;

const ctx = {
  effect(fn) {
    const it = fn();
    const first = it.next();
    if (!first.done && typeof first.value === "function") disposers.push(first.value);
  },
  on() {},
  tools: {
    guard(fn) {
      guardFn = fn;
      return () => {};
    }
  },
  commands: {
    register(cmd) {
      registeredCommand = cmd;
      return () => {};
    }
  },
  agents: {
    get() {
      return null;
    }
  },
  logger: {
    info() {},
    warn() {}
  }
};

mod.apply(ctx);

assert.equal(typeof mod.name, "string");
assert.equal(typeof mod.inject, "object");
assert.ok(Array.isArray(mod.inject));
assert.ok(mod.inject.includes("tools"), "inject tools");
assert.ok(mod.inject.includes("commands"), "inject commands");
assert.ok(mod.inject.includes("agents"), "inject agents");
assert.equal(typeof guardFn, "function", "guard registered");
assert.equal(registeredCommand?.name, "guard", "/guard command registered");

// guard 对普通只读调用返回 undefined（放行）
const res = guardFn({ name: "read", arguments: { file_path: "D:/x.txt" }, agent: null });
assert.equal(res, undefined, "normal read allowed");

// guard 对内联命令返回拒绝
const denied = guardFn({ name: "pwsh", arguments: { command: "node -e \"x\"" }, agent: null });
assert.ok(typeof denied === "string" && denied.includes("内联"), "inline command denied");

// 清理 disposers
for (const d of disposers) {
  if (typeof d === "function") d();
}
rmSync(dir, { recursive: true, force: true });
delete process.env.DSH_HOME;

console.log("runtime-smoke.mjs PASS");
