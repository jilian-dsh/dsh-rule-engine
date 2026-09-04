import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, getSessionState } from "../lib/core/state.js";
import { understandRule } from "../lib/core/understander.js";
import { guardDecision, markAskSeen, markBackupSeen, markManualRead } from "../lib/core/guard-core.js";
import { parseUserIntents } from "../lib/core/intent.js";
import { scopesFromIntents } from "../lib/core/authorization.js";

// 防止 maybeReloadIfChanged 读到真实 AGENTS.md 覆盖手工测试配置
process.env.DSH_HOME = join(tmpdir(), "dsh-rule-engine-guard-test-no-agents");
process.env.DSH_WORKSPACE = process.cwd();

// 本机回归测试（残余1 剥离后，2026-08-31）：夹具经 defaultMap 注入绑定执行器——
// 模拟本机配置 handlerDefaultMap（代码层默认表已下沉配置；本测试=本机语义回归）
const TEST_DEFAULT_MAP = {
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
const testRule = (r) => understandRule(r, { defaultMap: TEST_DEFAULT_MAP });

const rule9 = testRule({
  index: "9",
  title: "PS 编码与命令执行（执行等级：A+D）",
  level: "A+D",
  body: "- **触发**：任何含中文的脚本/命令。\n- **检查**：拦内联命令（node -e / pwsh -c / node -p）；拦 Set-Content -Encoding UTF8 写 .json。\n- **动作**：硬拦项拒绝。\n- **豁免**：无。"
});
const rule18 = testRule({
  index: "18",
  title: "先查手册再动手（执行等级：A 弱）",
  level: "A弱",
  body: "- **触发**：任务涉及 DSH 插件。\n- **检查**：首次工具调用前未读手册。\n- **动作**：拒绝。\n- **豁免**：读取手册本身。"
});
const rule13 = testRule({
  index: "13A",
  title: "备份与验证闭环（执行等级：A+D）",
  level: "A+D",
  body: "- **触发**：删除/覆盖/迁移。\n- **检查**：删除/覆盖且无备份→拒绝。\n- **动作**：拒绝。\n- **豁免**：低风险新建。"
});
const rule12b = testRule({
  index: "12B",
  title: "技能调用流程（执行等级：C）",
  level: "C",
  body: "- **触发**：技能调用。\n- **检查**：四步时序：关键词→授权→调用。\n- **动作**：跳过授权直接调用→拒绝。\n- **豁免**：example-usage-manual、example-planner。"
});
const rule21 = testRule({
  index: "21",
  title: "规则管理（执行等级：M）",
  level: "M",
  body: "- **触发**：规则变更。\n- **检查**：双通道变更。\n- **动作**：未经确认不落盘。\n- **豁免**：无。"
});
const rule1 = testRule({
  index: "1",
  title: "异常处理（执行等级：A）",
  level: "A",
  body: "- **触发**：工具调用失败或卡住。\n- **检查**：同工具同参数连续失败≥2次。\n- **动作**：拒绝第3次重试。\n- **豁免**：用户明确要求重试。"
});
const rule12a = testRule({
  index: "12A",
  title: "执行前确认（执行等级：C+D）",
  level: "C+D",
  body: "- **触发**：创建/删除/覆盖/移动/执行命令/下载/提交等。\n- **检查**：敏感操作需授权证据。\n- **动作**：无授权→拒绝。\n- **豁免**：只读、工作区低风险新建。"
});
const rule24 = testRule({
  index: "24",
  title: "插件变更统一守卫（执行等级：A 硬拦）",
  level: "A",
  body: "- **触发**：新增/修改 DSH 插件装配；给 DSH 增加新的文件变更工具。\n- **检查**：只有 dsh.bundle 才能加入 bundles；所有变更类工具纳入统一守卫。\n- **动作**：拒绝未覆盖变更工具与类型不匹配装配。\n- **豁免**：官方 bundle；只读工具。"
});
const rule27 = testRule({
  index: "27",
  title: "插件挂载唯一性与重启前全量审计（执行等级：C+D）",
  level: "C+D",
  body: "- **触发**：新增/修改/移除/升级 DSH 插件装配；或准备重启。\n- **检查**：装配变更后先跑全量审计；重启前有审计通过记录。\n- **动作**：缺审计通过记录先跑审计；审计发现重复停止装配/重启。\n- **豁免**：官方 bundle 自身装配；只读查看装配。"
});

function makeState() {
  const state = createState();
  state.configs = [rule9, rule18, rule13, rule12b, rule21, rule1, rule12a];
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

// 规则 9：BOM 写（PS7 语义：仅拦显式 utf8BOM；utf8 无 BOM 合规放行——
// 放行断言放在规则 18「首工具」时序通过之后，避免被 rule18 抢先拦截）
hit = guardDecision(state, { name: "pwsh", arguments: { command: "Set-Content -Path x.json -Value '{}' -Encoding utf8BOM" } });
assert.ok(hit && hit.ruleId === "9", "deny explicit utf8BOM write");

// 规则 18：首次工具非手册（只读必须放行，变更类才拦）
hit = guardDecision(state, { name: "read", arguments: { file_path: "D:/project/a.txt" } });
assert.equal(hit, null, "read-only first tool allowed");
hit = guardDecision(state, { name: "read", arguments: { file_path: "D:/example workspace/.dsh/AGENTS.md" } });
assert.equal(hit, null, "read AGENTS.md allowed");
hit = guardDecision(state, { name: "write", arguments: { file_path: "D:/project/a.txt", content: "x" } });
assert.ok(hit && hit.ruleId === "18", "deny first mutating tool without manual");

// 手册读取放行
hit = guardDecision(state, { name: "read", arguments: { file_path: "C:/Users/x/.dsh/skills/example-usage-manual/SKILL.md" } });
assert.equal(hit, null, "manual read allowed");
markManualRead(state, "global");
getSessionState(state, "global").turn.toolCount = 1;

// 规则 9（PS7 语义）：-Encoding utf8 / utf8NoBOM 均无 BOM，合规放行
hit = guardDecision(state, { name: "pwsh", arguments: { command: "Set-Content -Path x.json -Value '{}' -Encoding UTF8" } });
assert.equal(hit, null, "PS7 -Encoding utf8 (no BOM) allowed");
hit = guardDecision(state, { name: "pwsh", arguments: { command: "Set-Content -Path x.yaml -Value '{}' -Encoding utf8NoBOM" } });
assert.equal(hit, null, "utf8NoBOM allowed");

// 规则 9（PS7 语义）：含中文 .ps1 无需 BOM——写文件与命令均放行（2026-08-19 移除 PS5.1 残留硬拦）
hit = guardDecision(state, { name: "write", arguments: { file_path: join(process.cwd(), "test", "中文.ps1"), content: "Write-Output '中文'" } });
assert.equal(hit, null, "allow Chinese ps1 write under PS7");
hit = guardDecision(state, { name: "pwsh", arguments: { command: "Set-Content -Path x.ps1 -Value '中文'" } });
assert.equal(hit, null, "allow Chinese ps1 command without BOM under PS7");

// 统一入口命令豁免 13A（入口内部自带写前备份，属静态扫描已知盲区 → 显式信任）
const stateEntry = createState();
stateEntry.configs = [rule13];
hit = guardDecision(stateEntry, { name: "pwsh", arguments: { command: 'node scripts/example-manual-write.mjs local "D:/example workspace/.dsh/AGENTS.md" a b' } });
assert.equal(hit, null, "entry channel exempt from 13A backup check");
hit = guardDecision(stateEntry, { name: "pwsh", arguments: { command: 'node scripts/example-manual-write.mjs local "D:/example workspace/.dsh/AGENTS.md" "D:\\example\\global-npm\\x" y' } });
assert.equal(hit, null, "entry channel with multiple abs paths exempt from 13A");
hit = guardDecision(stateEntry, { name: "pwsh", arguments: { command: "Set-Content -Path 'C:/outside/x.txt' -Value 'x'" } });
assert.ok(hit && hit.ruleId === "13A", "plain direct write outside still hits 13A");
// P2 N1/G1（2026-09-04）：入口通道洞修复回归
// N1：入口 + 向文件重定向（>）→ 不再豁免（原 `入口 status x > AGENTS.md` 是写文件绕过；
// 实际拦截点=阶段 C self-protect：isEntryChannelCommand 修复使其不再被误判为纯入口）
hit = guardDecision(stateEntry, { name: "pwsh", arguments: { command: 'node scripts/example-manual-write.mjs status x > D:/example workspace/.dsh/AGENTS.md' } });
assert.ok(hit && hit.ruleId === "__self-protect", "N1: entry channel with file redirect blocked by self-protect");
// G1：引号内换行 = 合法参数（多行 batch 参数不应误拦）
hit = guardDecision(stateEntry, { name: "pwsh", arguments: { command: 'node scripts/example-manual-write.mjs local "a\nb" c' } });
assert.equal(hit, null, "G1: quoted newline allowed");
// fd 复制（2>&1）不构成写（无文件目标）→ 放行；& 链式语义下不再判纯入口，但无写即无拦
hit = guardDecision(stateEntry, { name: "pwsh", arguments: { command: 'node scripts/example-manual-write.mjs status x 2>&1' } });
assert.equal(hit, null, "N1: fd copy 2>&1 no write target, allowed");

// 规则 22⑦ 机器化：疑问句 → 变更类工具被拦；同形词（"执行"在"执行方案"中）不豁免；
// 只读/ask_user_question 放行；非疑问句+指令词（"执行吧"）放行
const rule22 = testRule({
  index: "22",
  title: "沟通直接性（执行等级：C+D）",
  level: "C+D",
  body: "- **触发**：所有交流场景。\n- **检查**：疑问句禁止变更类工具调用。\n- **动作**：拒绝。\n- **豁免**：非疑问句+动作词；授权答复；只读/展示类。"
});
const state22 = createState();
state22.configs = [rule22];
const g22 = getSessionState(state22, "global");
g22.turn.questionOnly = true;
g22.turn.userText = "你的执行方案难道没问题吗？";
hit = guardDecision(state22, { name: "edit", arguments: { file_path: "D:/f.txt", old_string: "a", new_string: "b" } });
assert.ok(hit && hit.ruleId === "22", "question sentence blocks mutation (同形词不豁免)");
hit = guardDecision(state22, { name: "pwsh", arguments: { command: "Set-Content -Path C:/f.txt -Value x" } });
assert.ok(hit && hit.ruleId === "22", "question sentence blocks pwsh write");
hit = guardDecision(state22, { name: "read", arguments: { file_path: "C:/x" } });
assert.equal(hit, null, "read-only allowed under question");
hit = guardDecision(state22, { name: "ask_user_question", arguments: { questions: [] } });
assert.equal(hit, null, "ask_user_question allowed under question");
const state22b = createState();
state22b.configs = [rule22];
const g22b = getSessionState(state22b, "global");
g22b.turn.questionOnly = false;
g22b.turn.userText = "执行吧";
hit = guardDecision(state22b, { name: "edit", arguments: { file_path: "D:/f.txt", old_string: "a", new_string: "b" } });
assert.equal(hit, null, "directive sentence allowed");

// 规则 22 新语义：数字列表混合消息含执行分点 → 允许变更
const state22c = createState();
state22c.configs = [rule22];
const g22c = getSessionState(state22c, "global");
g22c.turn.intents = parseUserIntents("1. 开始蒸馏\n2. 给方案，确认后再做\n3. 为什么目标会循环？");
hit = guardDecision(state22c, { name: "edit", arguments: { file_path: "D:/f.txt", old_string: "a", new_string: "b" } });
assert.equal(hit, null, "mixed numbered message with execute clause allows mutation");

// 纯方案列表：没有执行分点 → 仍禁止变更
const state22d = createState();
state22d.configs = [rule22];
const g22d = getSessionState(state22d, "global");
g22d.turn.intents = parseUserIntents("1. 给方案\n2. 确认后再做");
hit = guardDecision(state22d, { name: "edit", arguments: { file_path: "D:/f.txt", old_string: "a", new_string: "b" } });
assert.ok(hit && hit.ruleId === "22", "plan-only numbered message still blocks mutation");

// 标签混合：明确【执行】分点 → 允许变更
const state22e = createState();
state22e.configs = [rule22];
const g22e = getSessionState(state22e, "global");
g22e.turn.intents = parseUserIntents("【执行】开始蒸馏\n【问询】为什么目标会循环？");
hit = guardDecision(state22e, { name: "edit", arguments: { file_path: "D:/f.txt", old_string: "a", new_string: "b" } });
assert.equal(hit, null, "tagged execute clause allows mutation");

// “可以执行吗？”：仍是问询，不构成执行授权
const state22f = createState();
state22f.configs = [rule22];
const g22f = getSessionState(state22f, "global");
g22f.turn.intents = parseUserIntents("可以执行吗？");
hit = guardDecision(state22f, { name: "edit", arguments: { file_path: "D:/f.txt", old_string: "a", new_string: "b" } });
assert.ok(hit && hit.ruleId === "22", "can-execute-question still blocks mutation");

// ── 规则 22 粒度升级（2026-08-24）：特定执行子句只放行覆盖范围内的变更 ──
const state22g = createState();
state22g.configs = [rule22];
const g22g = getSessionState(state22g, "global");
g22g.turn.intents = parseUserIntents("1. 删除 D:/tmp/a.txt\n2. 给方案");
g22g.turn.scopes = scopesFromIntents(g22g.turn.intents);
hit = guardDecision(state22g, { name: "edit", arguments: { file_path: "D:/f.txt", old_string: "a", new_string: "b" } });
assert.ok(hit && hit.ruleId === "22", "specific delete clause denies unrelated write");
hit = guardDecision(state22g, { name: "pwsh", arguments: { command: "Remove-Item -Path 'D:/tmp/a.txt' -Force" } });
assert.equal(hit, null, "specific delete clause allows matching delete");

const state22h = createState();
state22h.configs = [rule22];
const g22h = getSessionState(state22h, "global");
g22h.turn.intents = parseUserIntents("修改 D:/a.txt");
g22h.turn.scopes = scopesFromIntents(g22h.turn.intents);
hit = guardDecision(state22h, { name: "edit", arguments: { file_path: "D:/a.txt", old_string: "a", new_string: "b" } });
assert.equal(hit, null, "specific write scope allows matching write");
hit = guardDecision(state22h, { name: "edit", arguments: { file_path: "D:/b.txt", old_string: "a", new_string: "b" } });
assert.ok(hit && hit.ruleId === "22", "specific write scope denies different path");

// 保护性备份豁免（2026-08-26，backup 口径修复）：write scope 回合 backup 类型操作放行；普通写仍受粒度限制
const state22l = createState();
state22l.configs = [rule22];
const g22l = getSessionState(state22l, "global");
g22l.turn.intents = parseUserIntents("修改 D:/a.txt");
g22l.turn.scopes = scopesFromIntents(g22l.turn.intents);
hit = guardDecision(state22l, { name: "pwsh", arguments: { command: "Copy-Item 'D:/a.txt' 'D:/example workspace/dsh-project/.backups/a.txt.bak'" } });
assert.equal(hit, null, "protective backup exempt from rule22 granular scope");
hit = guardDecision(state22l, { name: "edit", arguments: { file_path: "D:/b.txt", old_string: "a", new_string: "b" } });
assert.ok(hit && hit.ruleId === "22", "non-backup write still granular-denied");

// 计划消息 + askSeen：规则 22 不做粒度限制（由 12A/13A 把关）
const state22i = createState();
state22i.configs = [rule22];
const g22i = getSessionState(state22i, "global");
g22i.turn.intents = parseUserIntents("1. 给方案\n2. 确认后再做");
g22i.turn.askSeen = true;
hit = guardDecision(state22i, { name: "edit", arguments: { file_path: "D:/f.txt", old_string: "a", new_string: "b" } });
assert.equal(hit, null, "plan-only + askSeen does not trigger rule22 granular check");

// 计划消息 + askSeen + askRejected：被拒的 ask 不能当授权，仍应拦
const state22j = createState();
state22j.configs = [rule22];
const g22j = getSessionState(state22j, "global");
g22j.turn.intents = parseUserIntents("1. 给方案\n2. 确认后再做");
g22j.turn.askSeen = true;
g22j.turn.askRejected = true;
hit = guardDecision(state22j, { name: "edit", arguments: { file_path: "D:/f.txt", old_string: "a", new_string: "b" } });
assert.ok(hit && hit.ruleId === "22", "plan-only + askRejected still denies mutation");

// 执行分点 + askSeen：粒度仍生效，不能因 askSeen 跳过授权范围
const state22k = createState();
state22k.configs = [rule22];
const g22k = getSessionState(state22k, "global");
g22k.turn.intents = parseUserIntents("删除 D:/tmp/a.txt");
g22k.turn.scopes = scopesFromIntents(g22k.turn.intents);
g22k.turn.askSeen = true;
// 即使会话授权池里有历史全局 ask 授权，也不得放宽本轮粒度范围
g22k.authorizations.push({ type: "any", pathPrefix: "", source: "ask", at: Date.now() });
hit = guardDecision(state22k, { name: "edit", arguments: { file_path: "D:/f.txt", old_string: "a", new_string: "b" } });
assert.ok(hit && hit.ruleId === "22", "execute + askSeen still granular-denies unrelated write despite stale global ask auth");

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

// P0-1d：Copy-Item 源路径长于目标路径 + -Force + 目标不存在 → 应放行（创建新文件，不要求备份）
// 注：带 -Force 的 copy 属敏感操作（12D 需授权），先授权再断言 13A 行为；目标路径放在测试工作区（cwd）内
const longSrcCmd = `Copy-Item 'D:/example/apps/comfy-desktop/ComfyUI-Installs/ComfyUI/ComfyUI/.venv/Lib/site-packages/comfyui_workflow_templates_json/templates/video_minimax_h3_t2v.json' '${join(process.cwd(), "video_minimax_h3_t2v_local_new.json")}' -Force`;
const stateCopyNew = makeState();
markAskSeen(stateCopyNew, "global");
hit = guardDecision(stateCopyNew, { name: "pwsh", arguments: { command: longSrcCmd } });
assert.equal(hit, null, "copy to non-existing short target allowed even with long source");

// P0-1d：目标为高风险运行入口文件（授权也不豁免 13A 备份检查）且无备份 → 拦，
// 且提示目标应为 Destination（不是源路径）
// 注：高风险入口判定不依赖文件存在，但"覆盖已存在文件"语义需要目标真实存在——
// 动态构造 tmpdir 下的 dsh-desktop/main.js（isHighRiskEntryFile 正则命中），避免示例路径
// 因 existsSync=false 被当作"创建新文件"短路放行（2026-09-04 P1a 修复）
const highRiskDir = mkdtempSync(join(tmpdir(), "dsh-rule-engine-highrisk-"));
mkdirSync(join(highRiskDir, "dsh-desktop"), { recursive: true });
const highRiskTarget = join(highRiskDir, "dsh-desktop", "main.js");
writeFileSync(highRiskTarget, "// placeholder", "utf8");
const stateCopyExist = makeState();
markAskSeen(stateCopyExist, "global");
hit = guardDecision(stateCopyExist, { name: "pwsh", arguments: { command: `Copy-Item 'D:/example/apps/comfy-desktop/ComfyUI-Installs/ComfyUI/ComfyUI/.venv/Lib/site-packages/comfyui_workflow_templates_json/templates/video_minimax_h3_t2v.json' '${highRiskTarget}' -Force` } });
assert.ok(hit && hit.ruleId === "13A", "copy over existing high-risk entry without backup denied");
assert.ok(hit.reason.toLowerCase().includes(highRiskTarget.toLowerCase().replace(/\\/g, "/")), "deny reason targets Destination, not source");
assert.ok(!hit.reason.includes("comfyui_workflow_templates_json"), "source path NOT shown as target");

// P0-1d 回归：Copy-Item 不带 -Force 到不存在目标 → 放行（不进 13A；目标在测试工作区内，路径名不含 -force 子串）
const stateCopyNoForce = makeState();
hit = guardDecision(stateCopyNoForce, { name: "pwsh", arguments: { command: `Copy-Item 'D:/a.txt' '${join(process.cwd(), "new-file-copy.json")}'` } });
assert.equal(hit, null, "copy without -Force to non-existing target allowed");

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
markBackupSeen(stateQuoted, "global", "D:/example workspace/dsh-project/research/_session-repair/session-a.jsonl.zstd");
markAskSeen(stateQuoted, "global");
hit = guardDecision(stateQuoted, {
  name: "pwsh",
  arguments: { command: "Remove-Item -LiteralPath 'D:\\example workspace\\dsh-project\\research\\_session-repair\\session-a.jsonl.zstd'" }
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
hit = guardDecision(stateSkill, { name: "skill", arguments: { name: "example-usage-manual" } });
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
const exec = { name: "edit", arguments: { file_path: join(process.cwd(), "test", "x.txt"), old_string: "a", new_string: "b" } };
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
assert.ok(hit && hit.ruleId === "12A", "scope mismatch denied");

// 询问型用户消息（2026-08-24 新语义：裁决基底 = 本回合 userText；无消息回合不做 22 判定）：
// 本回合为纯询问 → 22 拦（即使有历史授权也只由 12A 放行，此处预期 22 优先拦）
const stateQuestion = makeState();
const sQ = getSessionState(stateQuestion, "global");
{
  const { parseUserIntents: pui } = await import("../lib/core/intent.js");
  sQ.turn.userText = "这样可以吗？";
  sQ.turn.intents = pui(sQ.turn.userText);
}
sQ.authorizations.push({ type: "any", pathPrefix: "", at: Date.now(), source: "test" });
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

// 规则 24④（0.5.9 单真源修订）：已分类工具（run_code=官方保留传输，标注为变更类）= 已纳入统一守卫，
// 24④ 放行（由 22/12A/13A 授权把关）；未分类 + 疑似变更 = 运行时拒绝（兜底不变）
const state25 = createState();
state25.configs = [rule24];
hit = guardDecision(state25, { name: "run_code", arguments: { code: "writeFileSync('x','y')" } });
assert.equal(hit, null, "run_code classified as mutating -> covered by unified guard (rule24 passes)");
hit = guardDecision(state25, { name: "future_unknown_tool", arguments: { code: "writeFileSync('x','y')" } });
assert.ok(hit && hit.ruleId === "24", "truly unknown tool with code param still denied by rule24 fallback");
hit = guardDecision(state25, { name: "ask_user_question", arguments: { questions: [] } });
assert.equal(hit, null, "safe tool allowed");
hit = guardDecision(state25, { name: "read", arguments: { file_path: "C:/x" } });
assert.equal(hit, null, "read-only allowed");
hit = guardDecision(state25, { name: "future_unknown_tool", arguments: { label: "x" } });
assert.equal(hit, null, "truly unknown tool without mutation-looking args not denied by rule24");

// 规则 24 扩展：通用执行器已纳入覆盖集合；敏感授权由 12A 负责
const state25Exec = createState();
state25Exec.configs = [rule24];
hit = guardDecision(state25Exec, { name: "dev_stage_add", arguments: { name: "x", execute: "writeFileSync('x','y')" } });
assert.equal(hit, null, "covered generic executor not denied by rule24");
const state25ExecAuth = createState();
state25ExecAuth.configs = [rule12a];
hit = guardDecision(state25ExecAuth, { name: "dev_stage_call", arguments: { name: "x", args: {} } });
assert.ok(hit && hit.ruleId === "12A", "generic executor without auth denied by sensitive auth");

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

// 规则 19：example-usage-manual/SKILL.md 正文更新免逐次确认
const stateManual = makeState();
getSessionState(stateManual, "global").manualReadSeen = true;
getSessionState(stateManual, "global").turn.toolCount = 1;
// 用合法的 old/new（new 包含 old，通过写前版本校验）测试 12A 豁免
hit = guardDecision(stateManual, { name: "edit", arguments: { file_path: "D:/example workspace/.dsh/skills/example-usage-manual/SKILL.md", old_string: "原文行", new_string: "原文行\n新增行" } });
assert.equal(hit, null, "manual SKILL.md edit exempt from 12A");
hit = guardDecision(stateManual, { name: "edit", arguments: { file_path: "D:/example workspace/.dsh/other.txt", old_string: "a", new_string: "b" } });
assert.ok(hit && hit.ruleId === "12A", "non-manual outside workspace still denied");

// 写前版本校验：SKILL.md 无包含关系的编辑 → __version-guard 拦截（写前而非写后回滚）
// 注：版本守卫先 readFileSync 原文件做模拟校验，目标必须是"真实存在的版本化文件"——
// tmpdir 动态构造 example-usage-manual/SKILL.md（isVersionedFile 按 basename 判定，不依赖路径前缀；
// 清理替换把同形示例路径换成不存在路径会静默吞掉 ENOENT 导致守卫失效，2026-09-04 P1a 修复）
const vgDir = mkdtempSync(join(tmpdir(), "dsh-rule-engine-vg-"));
mkdirSync(join(vgDir, "example-usage-manual"), { recursive: true });
const vgPath = join(vgDir, "example-usage-manual", "SKILL.md");
writeFileSync(vgPath, "lineA\nlineB", "utf8");
const stateVG = makeState();
getSessionState(stateVG, "global").manualReadSeen = true;
getSessionState(stateVG, "global").turn.toolCount = 1;
hit = guardDecision(stateVG, { name: "edit", arguments: { file_path: vgPath, old_string: "lineA\nlineB", new_string: "lineX\nlineY" } });
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

// 规则 19⑧/21⑨：统一入口防伪造（2026-08-23 修复：注释文本含 example-manual-write.mjs 不得放行直写）
// 注释伪造：写类命令 + 受保护文件名 + 注释声称走入口 → 仍拦
const stateProtect = createState();
stateProtect.configs = [];
hit = guardDecision(stateProtect, { name: "pwsh", arguments: { command: "Set-Content -Path 'D:/example workspace/.dsh/AGENTS.md' -Value 'x'; # example-manual-write.mjs" } });
assert.ok(hit && hit.ruleId === "__self-protect", "comment-forged entry channel denied");
// 合法通道：整条命令仅调用 example-manual-write.mjs（无链式分隔）→ 放行
hit = guardDecision(stateProtect, { name: "pwsh", arguments: { command: "node scripts/example-manual-write.mjs rewrite 'D:/example workspace/.dsh/AGENTS.md' out.md --confirmed" } });
assert.equal(hit, null, "entry channel call allowed");
// 链式拼接：写命令 + 入口调用串联 → 仍拦
hit = guardDecision(stateProtect, { name: "pwsh", arguments: { command: "node scripts/example-manual-write.mjs local a b c; Set-Content -Path 'D:/example workspace/.dsh/AGENTS.md' -Value 'x'" } });
assert.ok(hit && hit.ruleId === "__self-protect", "chained entry + write denied");

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
hit = guardDecision(stateGh, { name: "pwsh", arguments: { command: "& 'D:\\example\\bin\\gh.exe' pr create --repo a/b" } });
assert.equal(hit, null, "gh.exe invocation not treated as file target");

// E3 修订（2026-08-24）：已有授权不再吞 ask 弹窗——ask 必须真正送达用户；无授权时自然放行
const stateE3 = makeState();
getSessionState(stateE3, "global").authorizations.push({ type: "write", pathPrefix: "d:/target", at: Date.now(), source: "test" });
hit = guardDecision(stateE3, { name: "ask_user_question", arguments: { questions: [{ question: "是否允许写入 D:/target/file.txt？" }] } });
assert.equal(hit, null, "ask allowed even when auth exists (popup must reach user)");
const stateE3b = makeState();
hit = guardDecision(stateE3b, { name: "ask_user_question", arguments: { questions: [{ question: "是否允许写入 D:/target/file.txt？" }] } });
assert.equal(hit, null, "ask allowed when no matching auth");

// D3 真值驱动锁定（2026-08-29 B2：README 曾写"随 D1+C1 自然对齐"——空话，需真锁用例）：
// 拦截文案"已有授权范围 [...]"描述 = describeAuth 真实授权池，非硬编码记录
const stateD3 = createState();
stateD3.configs = [rule12a];
getSessionState(stateD3, "global").authorizations.push({ type: "write", pathPrefix: "d:/allowed", at: Date.now(), source: "test" });
hit = guardDecision(stateD3, { name: "edit", arguments: { file_path: "d:/other.txt", old_string: "a", new_string: "b" } });
assert.ok(hit && hit.ruleId === "12A", "D3: 超出授权范围仍被拦");
assert.match(hit.reason, /已有授权范围 \[/, "D3: 文案含真实池锚词");
assert.match(hit.reason, /write｜路径 d:\/allowed/, "D3: 描述来自真实授权池（describeAuth 输出）");
const stateD3b = createState();
stateD3b.configs = [rule12a];
getSessionState(stateD3b, "global").authorizations = [];
hit = guardDecision(stateD3b, { name: "edit", arguments: { file_path: "d:/other.txt", old_string: "a", new_string: "b" } });
assert.ok(hit && hit.ruleId === "12A", "D3: 无授权被拦");
assert.match(hit.reason, /已有授权范围 \[无\]/, "D3: 无授权描述=无（真值，非硬编码残留）");

console.log("guard.test.js PASS");
