import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, getSessionState } from "../lib/core/state.js";
import { understandRule } from "../lib/core/understander.js";
import { guardDecision, markAskSeen, markBackupSeen, markManualRead } from "../lib/core/guard-core.js";

// 防止 maybeReloadIfChanged 读到真实 AGENTS.md 覆盖手工测试配置
process.env.DSH_HOME = join(tmpdir(), "dsh-rule-engine-guard-test-no-agents");
process.env.DSH_WORKSPACE = process.cwd();

const rule9 = understandRule({
  index: "9",
  title: "PS 编码与命令执行（执行等级：A+D）",
  level: "A+D",
  body: "- **触发**：任何含中文的脚本/命令。\n- **检查**：拦内联命令（node -e / pwsh -c / node -p）；拦 Set-Content -Encoding UTF8 写 .json。\n- **动作**：硬拦项拒绝。\n- **豁免**：无。"
});
const rule18 = understandRule({
  index: "18",
  title: "先查手册再动手（执行等级：A 弱）",
  level: "A弱",
  body: "- **触发**：任务涉及 DSH 插件。\n- **检查**：首次工具调用前未读手册。\n- **动作**：拒绝。\n- **豁免**：读取手册本身。"
});
const rule13 = understandRule({
  index: "13A",
  title: "备份与验证闭环（执行等级：A+D）",
  level: "A+D",
  body: "- **触发**：删除/覆盖/迁移。\n- **检查**：删除/覆盖且无备份→拒绝。\n- **动作**：拒绝。\n- **豁免**：低风险新建。"
});
const rule12b = understandRule({
  index: "12B",
  title: "技能调用流程（执行等级：C）",
  level: "C",
  body: "- **触发**：技能调用。\n- **检查**：四步时序：关键词→授权→调用。\n- **动作**：跳过授权直接调用→拒绝。\n- **豁免**：dsh-usage-manual、task-planner。"
});
const rule21 = understandRule({
  index: "21",
  title: "规则管理（执行等级：M）",
  level: "M",
  body: "- **触发**：规则变更。\n- **检查**：双通道变更。\n- **动作**：未经确认不落盘。\n- **豁免**：无。"
});
const rule1 = understandRule({
  index: "1",
  title: "异常处理（执行等级：A）",
  level: "A",
  body: "- **触发**：工具调用失败或卡住。\n- **检查**：同工具同参数连续失败≥2次。\n- **动作**：拒绝第3次重试。\n- **豁免**：用户明确要求重试。"
});
const rule12d = understandRule({
  index: "12D",
  title: "敏感操作授权时序（执行等级：C）",
  level: "C",
  body: "- **触发**：git push/commit、工作区外写入、删除类、改配置。\n- **检查**：无授权证据→拒绝。\n- **动作**：拒绝。\n- **豁免**：无。"
});
const rule24 = understandRule({
  index: "24",
  title: "插件装配类型确认（执行等级：A 硬拦）",
  level: "A",
  body: "- **触发**：新增/修改 DSH 插件装配。\n- **检查**：只有 dsh.bundle 才能加入 bundles。\n- **动作**：拒绝。\n- **豁免**：官方 bundle。"
});
const rule25 = understandRule({
  index: "25",
  title: "插件变更类工具统一守卫覆盖（执行等级：A 硬拦）",
  level: "A",
  body: "- **触发**：开发/维护规则守卫类插件。\n- **检查**：所有变更工具都必须纳入统一守卫。\n- **动作**：拒绝未覆盖变更工具。\n- **豁免**：只读工具。"
});
const rule27 = understandRule({
  index: "27",
  title: "插件挂载唯一性与重启前全量审计（执行等级：C+D）",
  level: "C+D",
  body: "- **触发**：新增/修改/移除/升级 DSH 插件装配；或准备重启。\n- **检查**：装配变更后先跑全量审计；重启前有审计通过记录。\n- **动作**：缺审计通过记录先跑审计；审计发现重复停止装配/重启。\n- **豁免**：官方 bundle 自身装配；只读查看装配。"
});

function makeState() {
  const state = createState();
  state.configs = [rule9, rule18, rule13, rule12b, rule21, rule1, rule12d];
  return state;
}

const state = makeState();
const sid = "s1";
const s = getSessionState(state, sid);
s.turn.userText = "请帮我写插件";
const g = getSessionState(state, "global");
g.turn.userText = "请帮我写插件";

// 规则 9：内联命令
let hit = guardDecision(state, { name: "pwsh", arguments: { command: "node -e \"console.log(1)\"" } });
assert.ok(hit && hit.ruleId === "9", "deny inline node -e");

// 规则 9：BOM 写
hit = guardDecision(state, { name: "pwsh", arguments: { command: "Set-Content -Path x.json -Value '{}' -Encoding UTF8" } });
assert.ok(hit && hit.ruleId === "9", "deny BOM write");

// 规则 18：首次工具非手册（只读必须放行，变更类才拦）
hit = guardDecision(state, { name: "read", arguments: { file_path: "D:/project/a.txt" } });
assert.equal(hit, null, "read-only first tool allowed");
hit = guardDecision(state, { name: "read", arguments: { file_path: "D:/DeepSeek harness/.dsh/AGENTS.md" } });
assert.equal(hit, null, "read AGENTS.md allowed");
hit = guardDecision(state, { name: "write", arguments: { file_path: "D:/project/a.txt", content: "x" } });
assert.ok(hit && hit.ruleId === "18", "deny first mutating tool without manual");

// 手册读取放行
hit = guardDecision(state, { name: "read", arguments: { file_path: "C:/Users/x/.dsh/skills/dsh-usage-manual/SKILL.md" } });
assert.equal(hit, null, "manual read allowed");
markManualRead(state, "global");
getSessionState(state, "global").turn.toolCount = 1;

// 规则 9：含中文 .ps1 未按 UTF-8 带 BOM
hit = guardDecision(state, { name: "write", arguments: { file_path: "D:/DeepSeek harness/dsh-project/projects/oss/dsh-rule-engine/test/中文.ps1", content: "Write-Output '中文'" } });
assert.ok(hit && hit.ruleId === "9", "deny Chinese ps1 write");
hit = guardDecision(state, { name: "write", arguments: { file_path: "D:/DeepSeek harness/dsh-project/projects/oss/dsh-rule-engine/test/ok.ps1", content: "Write-Output 'ascii'" } });
assert.equal(hit, null, "allow ascii ps1 write");
hit = guardDecision(state, { name: "pwsh", arguments: { command: "Set-Content -Path x.ps1 -Value '中文'" } });
assert.ok(hit && hit.ruleId === "9", "deny Chinese ps1 command without BOM");
hit = guardDecision(state, { name: "pwsh", arguments: { command: "Set-Content -Path x.ps1 -Value '中文' -Encoding UTF8" } });
assert.equal(hit, null, "allow Chinese ps1 command with UTF8 BOM");

// 规则 13A：删除无备份
hit = guardDecision(state, { name: "pwsh", arguments: { command: "Remove-Item -Recurse C:/temp/x" } });
assert.ok(hit && hit.ruleId === "13A", "deny destructive without backup");

// 备份后放行（删除类还需授权，因此同时给授权）
markBackupSeen(state, "global", "C:/temp/x");
markAskSeen(state, "global");
hit = guardDecision(state, { name: "pwsh", arguments: { command: "Remove-Item -Recurse C:/temp/x" } });
assert.equal(hit, null, "allow after backup and auth");

// 备份路径不匹配：备份了 A，删除 B 仍应被规则 13A 拦
const stateWrongBackup = makeState();
markBackupSeen(stateWrongBackup, "global", "C:/temp/a");
hit = guardDecision(stateWrongBackup, { name: "pwsh", arguments: { command: "Remove-Item -Recurse C:/temp/b" } });
assert.ok(hit && hit.ruleId === "13A", "backup of different path does not allow delete");

// 备份记录存在但备份文件不存在 → 仍拦
const stateMissingBackup = makeState();
getSessionState(stateMissingBackup, "global").backups.push({
  targetPath: "c:/temp/x",
  backupPath: "C:/nonexistent/backup.bak",
  at: Date.now()
});
hit = guardDecision(stateMissingBackup, { name: "pwsh", arguments: { command: "Remove-Item -Recurse C:/temp/x" } });
assert.ok(hit && hit.ruleId === "13A" && hit.reason.includes("不存在"), "backup file missing denied");

// 含空格引号路径：备份记录完整路径，删除命令也应提取完整路径并放行
const stateQuoted = makeState();
markBackupSeen(stateQuoted, "global", "D:/DeepSeek harness/dsh-project/research/_session-repair/session-a.jsonl.zstd");
markAskSeen(stateQuoted, "global");
hit = guardDecision(stateQuoted, {
  name: "pwsh",
  arguments: { command: "Remove-Item -LiteralPath 'D:\\DeepSeek harness\\dsh-project\\research\\_session-repair\\session-a.jsonl.zstd'" }
});
assert.equal(hit, null, "quoted path delete allowed with matching backup");

// 13A：复制到不存在的新目标 → 跳过备份要求（创建新文件，非覆盖）
const stateNewCopy = createState();
stateNewCopy.configs = [rule13];
const newTarget = join(tmpdir(), "dsh-rule-engine-new-copy-" + Date.now() + ".txt");
assert.equal(existsSync(newTarget), false, "new target should not exist");
hit = guardDecision(stateNewCopy, {
  name: "pwsh",
  arguments: { command: `Copy-Item -LiteralPath 'D:/source.txt' -Destination '${newTarget}' -Force` }
});
assert.equal(hit, null, "copy to new file skips 13A backup");

// 13A：覆盖已存在文件时，目标路径必须有备份；无备份则拦
const stateOverwrite = createState();
stateOverwrite.configs = [rule13];
const overwriteTarget = join(tmpdir(), "dsh-rule-engine-overwrite-" + Date.now() + ".txt");
writeFileSync(overwriteTarget, "old", "utf8");
hit = guardDecision(stateOverwrite, {
  name: "pwsh",
  arguments: { command: `Copy-Item -LiteralPath 'D:/source.txt' -Destination '${overwriteTarget}' -Force` }
});
assert.ok(hit && hit.ruleId === "13A", "overwrite existing file without backup denied");
markBackupSeen(stateOverwrite, "global", overwriteTarget);
hit = guardDecision(stateOverwrite, {
  name: "pwsh",
  arguments: { command: `Copy-Item -LiteralPath 'D:/source.txt' -Destination '${overwriteTarget}' -Force` }
});
assert.equal(hit, null, "overwrite existing file allowed with backup");

// 规则 12B：skill 未授权拦截；豁免放行；授权后放行
const stateSkill = makeState();
hit = guardDecision(stateSkill, { name: "skill", arguments: { name: "some-skill" } });
assert.ok(hit && hit.ruleId === "12B", "deny skill without ask");
hit = guardDecision(stateSkill, { name: "skill", arguments: { name: "dsh-usage-manual" } });
assert.equal(hit, null, "allow exempt skill");
hit = guardDecision(stateSkill, { name: "skill", arguments: { name: "some-skill" } });
assert.ok(hit && hit.ruleId === "12B", "still deny before ask");
markAskSeen(stateSkill, "global");
hit = guardDecision(stateSkill, { name: "skill", arguments: { name: "some-skill" } });
assert.equal(hit, null, "allow skill after ask");

// 规则 21 / 自护：配置写保护
const state2 = makeState();
hit = guardDecision(state2, { name: "edit", arguments: { file_path: "C:/Users/x/.dsh/rule-engine.json", old_string: "a", new_string: "b" } });
assert.ok(hit && hit.ruleId === "__self-protect", "deny config write without unlock");
state2.unlockUntil = Date.now() + 60000;
hit = guardDecision(state2, { name: "edit", arguments: { file_path: "C:/Users/x/.dsh/rule-engine.json", old_string: "a", new_string: "b" } });
assert.equal(hit, null, "allow config write with unlock");

// 规则 1：重试拦截（基于真实失败计数；失败次数由 tool/result 更新）
const state3 = makeState();
const exec = { name: "edit", arguments: { file_path: "D:/DeepSeek harness/dsh-project/projects/oss/dsh-rule-engine/test/x.txt", old_string: "a", new_string: "b" } };
const retryKey = `edit:${JSON.stringify(exec.arguments)}`;
assert.equal(guardDecision(state3, exec), null, "retry 1 allowed (no failures yet)");
state3.retryCounts.set(retryKey, 2);
const third = guardDecision(state3, exec);
assert.ok(third && third.ruleId === "1", "retry 3 denied after 2 failures");
// 用户明确要求重试 → 豁免
getSessionState(state3, "global").turn.userText = "请重试";
assert.equal(guardDecision(state3, exec), null, "retry exempted when user asks retry");
state3.retryCounts.delete(retryKey);
assert.equal(guardDecision(state3, exec), null, "allowed after success clears failures");

// 授权范围不匹配：已有 write 授权在 D:/other，本次写 D:/target → 仍拦
const stateScope = makeState();
getSessionState(stateScope, "global").authorizations.push({ type: "write", pathPrefix: "d:/other", at: Date.now(), source: "test" });
hit = guardDecision(stateScope, { name: "edit", arguments: { file_path: "D:/target/file.txt", old_string: "a", new_string: "b" } });
assert.ok(hit && (hit.ruleId === "12D" || hit.ruleId === "12A"), "scope mismatch denied");

// 询问型用户消息：即使有历史授权，当前轮敏感操作也应提示“询问非授权”
const stateQuestion = makeState();
getSessionState(stateQuestion, "global").turn.questionOnly = true;
getSessionState(stateQuestion, "global").authorizations.push({ type: "any", pathPrefix: "", at: Date.now(), source: "test" });
hit = guardDecision(stateQuestion, { name: "edit", arguments: { file_path: "D:/target/file.txt", old_string: "a", new_string: "b" } });
assert.ok(hit && hit.reason.includes("询问"), "question-only denied");

// 规则 24：dev_install_package 非 bundle 包拒绝，bundle 包放行
const state24 = createState();
state24.configs = [rule24];
const nonBundleDir = mkdtempSync(join(tmpdir(), "dsh-rule-engine-nonbundle-"));
writeFileSync(join(nonBundleDir, "package.json"), JSON.stringify({ name: "x", dsh: { plugin: { platform: "host" } } }), "utf8");
hit = guardDecision(state24, { name: "dev_install_package", arguments: { dir: nonBundleDir } });
assert.ok(hit && hit.ruleId === "24", "non-bundle install denied");
const bundleDir = mkdtempSync(join(tmpdir(), "dsh-rule-engine-bundle-"));
writeFileSync(join(bundleDir, "package.json"), JSON.stringify({ name: "x", dsh: { bundle: { patch: "./cordis.patch.yml" } } }), "utf8");
hit = guardDecision(state24, { name: "dev_install_package", arguments: { dir: bundleDir } });
assert.equal(hit, null, "bundle install allowed");

// 规则 24：手工编辑 profile package.json 写入非 bundle 也应拒绝
const state24Manual = createState();
state24Manual.configs = [rule24];
const profileRoot = mkdtempSync(join(tmpdir(), "dsh-rule-engine-profile-"));
const webDir = join(profileRoot, "profiles", "web");
mkdirSync(join(webDir, "node_modules", "bad-pkg"), { recursive: true });
writeFileSync(join(webDir, "node_modules", "bad-pkg", "package.json"), JSON.stringify({ name: "bad-pkg", dsh: { plugin: {} } }), "utf8");
mkdirSync(join(webDir, "node_modules", "good-pkg"), { recursive: true });
writeFileSync(join(webDir, "node_modules", "good-pkg", "package.json"), JSON.stringify({ name: "good-pkg", dsh: { bundle: { patch: "./cordis.patch.yml" } } }), "utf8");
const profilePkgPath = join(webDir, "package.json");
hit = guardDecision(state24Manual, { name: "write", arguments: { file_path: profilePkgPath, content: JSON.stringify({ dsh: { profile: { bundles: ["bad-pkg"] } } }) } });
assert.ok(hit && hit.ruleId === "24", "manual write non-bundle into bundles denied");
hit = guardDecision(state24Manual, { name: "write", arguments: { file_path: profilePkgPath, content: JSON.stringify({ dsh: { profile: { bundles: ["good-pkg"] } } }) } });
assert.equal(hit, null, "manual write bundle into bundles allowed");

// 规则 25：未覆盖的变更工具拒绝，安全/只读工具放行
const state25 = createState();
state25.configs = [rule25];
hit = guardDecision(state25, { name: "run_code", arguments: { code: "writeFileSync('x','y')" } });
assert.ok(hit && hit.ruleId === "25", "uncovered mutating tool denied");
hit = guardDecision(state25, { name: "ask_user_question", arguments: { questions: [] } });
assert.equal(hit, null, "safe tool allowed");
hit = guardDecision(state25, { name: "read", arguments: { file_path: "C:/x" } });
assert.equal(hit, null, "read-only allowed");

// 规则 25 扩展：通用执行器已纳入覆盖集合；敏感授权由 12A/12D 负责
const state25Exec = createState();
state25Exec.configs = [rule25];
hit = guardDecision(state25Exec, { name: "dev_stage_add", arguments: { name: "x", execute: "writeFileSync('x','y')" } });
assert.equal(hit, null, "covered generic executor not denied by rule25");
const state25ExecAuth = createState();
state25ExecAuth.configs = [rule12d];
hit = guardDecision(state25ExecAuth, { name: "dev_stage_call", arguments: { name: "x", args: {} } });
assert.ok(hit && (hit.ruleId === "12D" || hit.ruleId === "12A"), "generic executor without auth denied by sensitive auth");

// 规则 27：装配变更后未审计 → 继续装配被拒；本会话审计通过后放行；其他会话未审计仍被拒
const state27 = createState();
state27.configs = [rule27];
hit = guardDecision(state27, { name: "dev_install_package", arguments: { dir: "D:/some-bundle" } });
assert.equal(hit, null, "first assembly mutation allowed when clean");
state27.mountRevision = 1;
hit = guardDecision(state27, { name: "dev_install_package", arguments: { dir: "D:/another-bundle" } });
assert.ok(hit && hit.ruleId === "27", "assembly mutation denied while audit pending");
hit = guardDecision(state27, { name: "read", arguments: { file_path: "C:/x" } });
assert.equal(hit, null, "read-only allowed while audit pending");
getSessionState(state27, "global").mountAuditRevision = 1;
hit = guardDecision(state27, { name: "dev_install_package", arguments: { dir: "D:/another-bundle" } });
assert.equal(hit, null, "assembly mutation allowed after this session audit pass");
// 另一个会话没有审计证据，即使全局已有人通过，也仍被拒（B 语义）
const state27b = createState();
state27b.configs = [rule27];
state27b.mountRevision = 1;
getSessionState(state27b, "s-other").mountAuditRevision = 1;
hit = guardDecision(state27b, { name: "dev_install_package", arguments: { dir: "D:/another-bundle" } });
assert.ok(hit && hit.ruleId === "27", "session without own audit evidence denied");

// 规则 27：装配内容哈希相同，即使 mountRevision 增加也放行
const state27Sig = createState();
state27Sig.configs = [rule27];
state27Sig.mountRevision = 2;
getSessionState(state27Sig, "global").mountAuditRevision = 1;
getSessionState(state27Sig, "global").mountAuditSignature = "missing-profile:web";
hit = guardDecision(state27Sig, { name: "dev_install_package", arguments: { dir: "D:/another-bundle" } });
assert.equal(hit, null, "same mount signature allows despite revision increase");

// 规则 27：装配内容哈希不同仍拦
const state27SigDiff = createState();
state27SigDiff.configs = [rule27];
state27SigDiff.mountRevision = 2;
getSessionState(state27SigDiff, "global").mountAuditRevision = 1;
getSessionState(state27SigDiff, "global").mountAuditSignature = "different-hash";
hit = guardDecision(state27SigDiff, { name: "dev_install_package", arguments: { dir: "D:/another-bundle" } });
assert.ok(hit && hit.ruleId === "27", "different mount signature denied");

// 规则 19：dsh-usage-manual/SKILL.md 正文更新免逐次确认
const stateManual = makeState();
getSessionState(stateManual, "global").manualReadSeen = true;
getSessionState(stateManual, "global").turn.toolCount = 1;
// 用合法的 old/new（new 包含 old，通过写前版本校验）测试 12A 豁免
hit = guardDecision(stateManual, { name: "edit", arguments: { file_path: "D:/DeepSeek harness/.dsh/skills/dsh-usage-manual/SKILL.md", old_string: "原文行", new_string: "原文行\n新增行" } });
assert.equal(hit, null, "manual SKILL.md edit exempt from 12A");
hit = guardDecision(stateManual, { name: "edit", arguments: { file_path: "D:/DeepSeek harness/.dsh/other.txt", old_string: "a", new_string: "b" } });
assert.ok(hit && (hit.ruleId === "12D" || hit.ruleId === "12A"), "non-manual outside workspace still denied");

// 写前版本校验：SKILL.md 无包含关系的编辑 → __version-guard 拦截（写前而非写后回滚）
const stateVG = makeState();
getSessionState(stateVG, "global").manualReadSeen = true;
getSessionState(stateVG, "global").turn.toolCount = 1;
hit = guardDecision(stateVG, { name: "edit", arguments: { file_path: "D:/DeepSeek harness/.dsh/skills/dsh-usage-manual/SKILL.md", old_string: "a", new_string: "b" } });
assert.ok(hit && hit.ruleId === "__version-guard", "pre-write version guard blocks non-containment edit");

// 规则 24：link 依赖可推断 bundle 类型
const state24Link = createState();
state24Link.configs = [rule24];
const linkRoot = mkdtempSync(join(tmpdir(), "dsh-rule-engine-link-"));
const linkProfile = join(linkRoot, "profiles", "web");
mkdirSync(linkProfile, { recursive: true });
const linkPkgDir = join(linkRoot, "packages", "link-pkg");
mkdirSync(linkPkgDir, { recursive: true });
writeFileSync(join(linkPkgDir, "package.json"), JSON.stringify({ name: "link-pkg", dsh: { bundle: { patch: "./cordis.patch.yml" } } }), "utf8");
const linkPkgPath = join(linkProfile, "package.json");
const linkContent = JSON.stringify({ dependencies: { "link-pkg": "link:../../packages/link-pkg" }, dsh: { profile: { bundles: ["link-pkg"] } } });
hit = guardDecision(state24Link, { name: "write", arguments: { file_path: linkPkgPath, content: linkContent } });
assert.equal(hit, null, "link dependency bundle allowed");

// 规则 24：版本声明且包未安装 → 拒绝并给出明确下一步
const state24Ver = createState();
state24Ver.configs = [rule24];
const verProfile = join(linkRoot, "profiles", "ver");
mkdirSync(verProfile, { recursive: true });
const verPkgPath = join(verProfile, "package.json");
const verContent = JSON.stringify({ dependencies: { "missing-pkg": "^1.0.0" }, dsh: { profile: { bundles: ["missing-pkg"] } } });
hit = guardDecision(state24Ver, { name: "write", arguments: { file_path: verPkgPath, content: verContent } });
assert.ok(hit && hit.ruleId === "24" && hit.reason.includes("请先用 dev_install_package"), "version dep with missing package denied with next-step hint");

// bypass 放行
const state4 = makeState();
state4.bypassUntil = Date.now() + 60000;
hit = guardDecision(state4, { name: "pwsh", arguments: { command: "node -e \"x\"" } });
assert.equal(hit, null, "bypass allows all");

// v3.74：含 $ 变量路径跳过 13A 备份检查（P0-2）
const stateVar = makeState();
stateVar.configs = [rule13];
hit = guardDecision(stateVar, { name: "pwsh", arguments: { command: "Copy-Item 'C:\\x\\a.txt' \"D:\\out\\$ts.bak\"" } });
assert.equal(hit, null, "variable path skips backup check");

// v3.74：已获授权的操作跳过 13A 机械备份（P1-2）——12A 授权即用户确认
const stateAuth13 = makeState();
stateAuth13.configs = [rule13];
markAskSeen(stateAuth13, "global"); // ask 授权登记（any 类型）
hit = guardDecision(stateAuth13, { name: "pwsh", arguments: { command: "Move-Item 'D:\\x\\src' 'D:\\x\\dst'" } });
assert.equal(hit, null, "authorized op skips mechanical backup check");

// v3.74：程序路径误判修复——gh.exe 命令不再被 13A 当写目标（P0-1）
const stateGh = makeState();
stateGh.configs = [rule13];
hit = guardDecision(stateGh, { name: "pwsh", arguments: { command: "& 'D:\\GitHubCLI\\gh.exe' pr create --repo a/b" } });
assert.equal(hit, null, "gh.exe invocation not treated as file target");

console.log("guard.test.js PASS");
