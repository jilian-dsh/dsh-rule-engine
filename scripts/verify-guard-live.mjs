// verify-guard-live.mjs — 0.5.11 运行态实弹验证（验收⑥）：版本守卫端到端行为
// 场景：edit 一个版本化文件（SKILL.md 类），old 唯一、单行整句重写 → 应放行；多行真覆盖 → 应拦
import { validateEditedFile } from "../lib/core/version-guard.js";

// 模拟：current 含 3 行，old="第二行旧句"唯一出现，new="第二行新句"（单行整句重写）
const current = "第一行\n第二行旧句\n第三行\n";
const simulated = "第一行\n第二行新句\n第三行\n";
const old = "第二行旧句";
const newS = "第二行新句";

// 唯一性（模拟工具已确认 old 唯一）
const unique = current.split(old).length - 1 === 1;
console.log("old 唯一匹配:", unique, unique ? "✅" : "❌");

const res1 = validateEditedFile(current, simulated, old, newS, unique);
console.log("单行整句重写:", res1.ok ? "✅ 放行" : "❌ 拦截(" + (res1.errors || []).join(";") + ")");

// 多行真覆盖（old 两行被无关内容替换）
const current2 = "line1\nline2\nline3\n";
const sim2 = "line1\nREPLACED\n";
const res2 = validateEditedFile(current2, sim2, "line2\nline3", "REPLACED", true);
console.log("多行真覆盖:", res2.ok ? "❌ 放行(危险!)" : "✅ 拦截");

// 删除/缩短（old 子串 new）仍放行 = 正常删行
const res3 = validateEditedFile(current2, "line1\n", "line2\nline3", "", true);
console.log("删除行(new 为空=缩短):", res3.ok ? "✅ 放行(删除属正常编辑)" : "❌ 拦截");

const pass = res1.ok && !res2.ok && res3.ok;
console.log("\n=== " + (pass ? "LIVE VERIFY PASS" : "LIVE VERIFY FAIL") + " ===");
process.exit(pass ? 0 : 1);
