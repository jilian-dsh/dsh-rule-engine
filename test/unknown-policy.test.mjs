// unknown-policy.test.mjs — P3a 口径「先红」夹具（未归类工具首调策略的取值矩阵）
//
// 用途：把拍板口径钉成可执行断言——
//   缺键与 "off" 放行并审计；"deny" 拒绝；"ask" 询问；认不出的显式取值按拒绝并写明「无法识别」。
//   字符串先去首尾空格、转小写再匹配；显式取值每次调用前写进临时 DSH_HOME 的 rule-engine.json；
//   审计一律从该临时目录的 rule-engine.log.jsonl 读回。
//
// 先红声明：本夹具先于引擎改动落地。现盘那一支在模块加载时只读一次配置、且只认字面量 "ask"，
//   其余一切落拒绝 → 第 ① 条（缺键应放行）必然红，红因＝钩子返回了拒绝而没有放行。
//
// 夹具形态仿 contract-card-hits：临时 DSH_HOME → 预置一份不含 unknownPolicy 的 rule-engine.json
//   → 动态 import 插件入口 → 调 apply（mock Cordis ctx）→ 用 ctx.on 收集 tools/pre-execute 钩子。
//   每种取值使用独立的工具名（mystery_ 前缀）与独立会话号，互不串味。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionState } from "../lib/core/state.js";

const dir = mkdtempSync(join(tmpdir(), "dsh-rule-engine-unknown-policy-"));
process.env.DSH_HOME = dir;
process.env.DSH_WORKSPACE = process.cwd();

const CONFIG_FILE = join(dir, "rule-engine.json");
const AUDIT_FILE = join(dir, "rule-engine.log.jsonl");

/** 写配置：undefined = 配置文件在但不含该键；"RAW:<text>" = 原样写入（用于坏 JSON 场景） */
function writeConfig(value) {
  if (value === undefined) {
    writeFileSync(CONFIG_FILE, JSON.stringify({ enabled: true }, null, 2) + "\n", "utf8");
    return;
  }
  if (typeof value === "string" && value.startsWith("RAW:")) {
    writeFileSync(CONFIG_FILE, value.slice(4), "utf8");
    return;
  }
  writeFileSync(CONFIG_FILE, JSON.stringify({ enabled: true, unknownPolicy: value }, null, 2) + "\n", "utf8");
}

// 预置：配置文件存在、但不含 unknownPolicy 键——必须在 import 插件入口之前落盘
writeConfig(undefined);

const disposers = [];
const preExecuteHooks = [];
const ctx = {
  effect(fn) {
    const it = fn();
    const first = it.next();
    if (!first.done && typeof first.value === "function") disposers.push(first.value);
  },
  on(event, fn) {
    if (event === "tools/pre-execute") preExecuteHooks.push(fn);
  },
  tools: { guard() { return () => {}; } },
  commands: { register() { return () => {}; } },
  agents: { get() { return null; } },
  workspaceRegistry: { list() { return []; } },
  skills: { list() { return []; } },
  llm: {},
  logger: { info() {}, warn() {} }
};

const mod = await import("../lib/index.js");
mod.apply(ctx);
assert.ok(preExecuteHooks.length > 0, "tools/pre-execute 钩子应已注册");

const state = (await import("../lib/core/runtime.js")).state;
state.enabled = true;
const { DEFAULT_CONFIG } = await import("../lib/core/config.js");

const next = async () => undefined;
const keyOf = (name, args) => `${name}:${JSON.stringify(args || {})}`;

function readAudit() {
  try {
    return readFileSync(AUDIT_FILE, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
const rowsFor = (kind, tool) => readAudit().filter((r) => r && r.kind === kind && r.tool === tool);

/** 调一次未归类工具钩子：独立工具名 + 独立会话号 */
async function callUnknown(hook, name, sid, args = { probe: name }) {
  const exec = { name, arguments: args, agent: { session: { id: sid } } };
  const res = await hook(exec, next);
  return { res, exec, key: keyOf(name, args) };
}

/** 在 "deny" 配置下定位「未归类工具」那一支钩子（拒绝 reason 含「尚未归类」） */
async function findUnknownHook() {
  writeConfig("deny");
  for (const hook of preExecuteHooks) {
    try {
      const probe = await callUnknown(hook, "mystery_probe_locate", "policy-probe-sid");
      if (probe.res && probe.res.kind === "deny" && typeof probe.res.reason === "string" && probe.res.reason.includes("尚未归类")) {
        return hook;
      }
    } catch {
      // 无关钩子抛错不影响定位
    }
  }
  return null;
}

const hook = await findUnknownHook();
assert.ok(hook, "应能定位未归类工具那一支 pre-execute 钩子（拒绝 reason 含「尚未归类」）");

/** 放行面公共断言：返回 next 的结果 + 审计 unknown-tool-allow + 无卡片 + 不记 deniedKeys */
async function assertAllowed(tag, value, name, sid) {
  writeConfig(value);
  getSessionState(state, sid);
  const { res, key } = await callUnknown(hook, name, sid);
  assert.equal(
    res,
    undefined,
    `${tag}：应放行（钩子返回 next 的结果），实际返回 ${JSON.stringify(res)}（现盘红因：钩子返回了拒绝、没有放行）`
  );
  assert.ok(rowsFor("unknown-tool-allow", name).length >= 1, `${tag}：审计应有 kind=unknown-tool-allow 且 tool=${name} 的记录`);
  const hits = getSessionState(state, sid).turn.cardHits || [];
  assert.equal(hits.length, 0, `${tag}：放行不应写回合卡片（实际 ${JSON.stringify(hits)}）`);
  assert.ok(!(state.deniedKeys instanceof Set) || !state.deniedKeys.has(key), `${tag}：放行不应记 deniedKeys（键「${key}」）`);
}

try {
  // ── 断言 ①（先红）：配置文件在、但不含该键 → 放行 ──
  console.log("[case 1] 缺键");
  await assertAllowed("① 缺键", undefined, "mystery_absent_key", "policy-sid-01-absent");

  // ── 断言 ②："off" 与 " OFF " 同 ① ──
  console.log("[case 2] off");
  await assertAllowed("② off", "off", "mystery_off_lower", "policy-sid-02-off-lower");
  await assertAllowed("② OFF 带空格", " OFF ", "mystery_off_padded", "policy-sid-02-off-padded");

  // ── 断言 ③："deny" 与 " Deny " → 拒绝，reason 含「尚未归类」 ──
  console.log("[case 3] deny");
  for (const [value, name, sid, tag] of [
    ["deny", "mystery_deny_lower", "policy-sid-03-deny-lower", "③ deny"],
    [" Deny ", "mystery_deny_padded", "policy-sid-03-deny-padded", "③ Deny 带空格"]
  ]) {
    writeConfig(value);
    const { res } = await callUnknown(hook, name, sid);
    assert.equal(res?.kind, "deny", `${tag}：应拒绝（实际 ${JSON.stringify(res)}）`);
    assert.ok(String(res?.reason).includes("尚未归类"), `${tag}：拒绝 reason 应含「尚未归类」（实际 ${JSON.stringify(res?.reason)}）`);
  }

  // ── 断言 ④："ask" 与 "ASK" → kind 为 ask ──
  console.log("[case 4] ask");
  for (const [value, name, sid, tag] of [
    ["ask", "mystery_ask_lower", "policy-sid-04-ask-lower", "④ ask"],
    ["ASK", "mystery_ask_upper", "policy-sid-04-ask-upper", "④ ASK"]
  ]) {
    writeConfig(value);
    const { res } = await callUnknown(hook, name, sid);
    assert.equal(res?.kind, "ask", `${tag}：应返回 kind=ask（实际 ${JSON.stringify(res)}）`);
  }

  // ── 断言 ⑤：认不出的显式取值 → 拒绝，且该工具审计 reason 含「无法识别」 ──
  console.log("[case 5] 认不出的取值");
  for (const [value, name, sid, tag] of [
    ["denyy", "mystery_typo_value", "policy-sid-05-typo", "⑤ 拼错 denyy"],
    ["", "mystery_empty_value", "policy-sid-05-empty", "⑤ 空串"],
    [null, "mystery_null_value", "policy-sid-05-null", "⑤ null"],
    [true, "mystery_true_value", "policy-sid-05-true", "⑤ true"],
    [["off"], "mystery_array_value", "policy-sid-05-array", "⑤ 数组 [\"off\"]（非字符串，String() 会把它变成 off，但口径只认字符串）"]
  ]) {
    writeConfig(value);
    const { res } = await callUnknown(hook, name, sid);
    assert.equal(res?.kind, "deny", `${tag}：认不出应按拒绝处理（实际 ${JSON.stringify(res)}）`);
    const rows = readAudit().filter((r) => r && r.tool === name);
    assert.ok(
      rows.some((r) => String(r.reason || "").includes("无法识别")),
      `${tag}：该工具审计 reason 应含「无法识别」（实际 ${JSON.stringify(rows.map((r) => r.reason))}）`
    );
  }

  // ── 断言 ⑥：读失败沿用上一次读成功的值 ──
  console.log("[case 6] 读失败沿用上次值");
  {
    const name = "mystery_carry_off";
    const sid = "policy-sid-06-carry-off";
    writeConfig("off");
    const first = await callUnknown(hook, name, sid);
    assert.equal(first.res, undefined, `⑥ off 首次应放行（实际 ${JSON.stringify(first.res)}）`);
    writeConfig("RAW:{ this is not json");
    const second = await callUnknown(hook, name, sid);
    assert.equal(second.res, undefined, `⑥ 坏 JSON 后应沿用上次读成功的 off → 仍放行（实际 ${JSON.stringify(second.res)}）`);
    const allowRows = rowsFor("unknown-tool-allow", name);
    assert.equal(
      allowRows.length,
      2,
      `⑥ 两次调用都应放行，unknown-tool-allow 审计应累计 2 条（实际 ${allowRows.length} 条）——出错时 catch 也返回 next，只看返回值会假绿`
    );
  }
  {
    const name = "mystery_carry_deny";
    const sid = "policy-sid-06-carry-deny";
    writeConfig("deny");
    const first = await callUnknown(hook, name, sid);
    assert.equal(first.res?.kind, "deny", `⑥ deny 首次应拒绝（实际 ${JSON.stringify(first.res)}）`);
    writeConfig("RAW:{ this is not json");
    const second = await callUnknown(hook, name, sid);
    assert.equal(second.res?.kind, "deny", `⑥ 坏 JSON 后应沿用上次读成功的 deny → 仍拒绝（实际 ${JSON.stringify(second.res)}）`);
  }

  // ── 断言 ⑦：内置默认值为 "off" ──
  console.log("[case 7] DEFAULT_CONFIG");
  assert.equal(DEFAULT_CONFIG.unknownPolicy, "off", `⑦ 内置默认值应为 off（实际 ${JSON.stringify(DEFAULT_CONFIG.unknownPolicy)}）`);

  // ── 断言 ⑧：白名单内工具在 "deny" 配置下仍放行 ──
  console.log("[case 8] 白名单");
  {
    const name = "mystery_whitelisted_tool";
    const sid = "policy-sid-08-whitelist";
    writeConfig("deny");
    if (!(state.unknownToolApproved instanceof Set)) state.unknownToolApproved = new Set();
    state.unknownToolApproved.add(name);
    const { res } = await callUnknown(hook, name, sid);
    assert.equal(res, undefined, `⑧ 白名单内工具在 deny 配置下仍应放行（实际 ${JSON.stringify(res)}）`);
  }

  console.log("unknown-policy.test.mjs ALL ASSERTIONS PASS");
} finally {
  // 清理：白名单工具名 → 资源 disposer → 临时 DSH_HOME 目录 → 环境变量
  try {
    state.unknownToolApproved?.delete?.("mystery_whitelisted_tool");
  } catch {
    // 清理失败不掩盖断言结果
  }
  for (const d of disposers) if (typeof d === "function") d();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.DSH_HOME;
  delete process.env.DSH_WORKSPACE;
}
