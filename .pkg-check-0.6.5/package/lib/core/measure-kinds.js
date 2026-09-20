// measure-kinds.js - 措施类型注册表（架构 v3 §三 L1：通用层，零规则号）
//
// 依据：reports/2026-09-10-引擎分层架构-通用层零规则内容-v1.md
//   §三 L1「措施类型注册表（measure kinds）：每型一个通用解释器，命名去规则号」；
//   §八 P1「措施类型注册表 + 解释器骨架；guard-core/matcher 改 kind → interpreter；内部名去规则号」。
//
// 三层分工（P1）：
//   ① MEASURE_KINDS —— 通用层的 kind 清单（**零规则号**，随包发布）；
//   ② LEGACY_HANDLER_ALIASES —— 历史内部名（带规则号）→ kind 的**兼容映射**
//      （P4 清淤时迁个人层配置；保留在此是为了不破坏既有配置与规则正文声明）；
//   ③ kindOf() —— 唯一归一入口，接受 旧名 / kind 名 / 未知名 三种输入。
//
// 兼容面（P1 行为等价的前提）：本机 rule-engine.json 的 handlerDefaultMap/handlerOverrides、
//   规则正文 `<!-- handler: … -->`、以及测试夹具，**仍可写旧内部名**——经 kindOf 归一后
//   与 kind 名完全等价。新用户/新规则写 kind 名即可，无需知道任何规则号。
export const MEASURE_KINDS = {
  retry: "连续失败重试闸（第 3 次拒绝）",
  time: "时间表述取证",
  source: "引用出处标注",
  promise: "承诺保守",
  "inline-command": "禁止内联命令",
  language: "语言与表达",
  approval: "敏感操作授权确认",
  "skill-auth": "技能调用授权",
  network: "下载与网络",
  backup: "写入前备份",
  "manual-first": "先查手册再动手",
  meta: "元规则管理",
  "intent-direct": "无执行分点直拦",
  "runtime-verify": "交付验证证据",
  assembly: "插件装配类型守卫",
  "release-asset": "发布资产规范",
  "mount-audit": "挂载唯一性审计",
  sensitive: "敏感操作（注入面）"
};

/** 历史内部名 → kind（兼容层；键含规则号，P4 迁个人层配置） */
export const LEGACY_HANDLER_ALIASES = {
  "rule1-retry": "retry",
  "rule2-time": "time",
  "rule5-source": "source",
  "rule7-promise": "promise",
  "rule9-inline-bom": "inline-command",
  "rule11-language": "language",
  "rule12a-approval": "approval",
  "rule12b-skill": "skill-auth",
  "rule12c-network": "network",
  "rule12d-sensitive": "sensitive",
  "rule13a-backup": "backup",
  "rule18-manual-first": "manual-first",
  "rule21-meta": "meta",
  "rule22-7-direct": "intent-direct",
  "rule23-runtime-verify": "runtime-verify",
  "rule24-assembly-type": "assembly",
  "rule26-release-asset": "release-asset",
  "rule27-mount-audit": "mount-audit"
};

/**
 * 归一为 kind 名。
 *   旧内部名 → kind；kind 名 → 原样（幂等）；未知名 → 原样（由覆盖自省提示未覆盖）。
 * @param {string} name
 * @returns {string}
 */
export function kindOf(name) {
  const s = String(name || "").trim();
  if (!s) return "";
  return LEGACY_HANDLER_ALIASES[s] || s;
}

/** 兼容旧调用名（understander 对外导出同义函数） */
export function normalizeHandlerName(name) {
  return kindOf(name);
}

// ── P2（2026-09-10）：个人层「措施声明」解析 + 校验（架构正本 §三 L2/L3）──

/** 规则正文内联声明：`<!-- handler: <kind> -->` 或 `<!-- handler: <kind> {json} -->`
 *  设计（方案 A，用户 2026-09-10 拍板）：**扩展既有 handler 声明**而非新增独立块——
 *  向后兼容（旧声明零影响）、单点解析入口。正则捕获 `-->` 之前的**全部内容**，之后再拆分，
 *  避免用嵌套正则直接匹配 JSON（`}` 截断风险）。 */
const HANDLER_DECL_RE = /<!--\s*handler\s*:\s*([\s\S]*?)-->/i;

/**
 * 解析个人层措施声明。
 * @param {string} body 规则正文
 * @returns {null | {kind: string, params: object} | {error: string}}
 *   null = 无声明；{kind, params} = 解析成功；{error} = 声明非法（调用方须 fail-closed）
 */
export function parseHandlerDecl(body) {
  const m = String(body || "").match(HANDLER_DECL_RE);
  if (!m) return null;
  const raw = String(m[1] || "").trim();
  if (!raw) return { error: "声明为空（`<!-- handler: -->`）" };
  const km = /^([A-Za-z0-9][A-Za-z0-9-]*)\s*([\s\S]*)$/.exec(raw);
  if (!km) return { error: `声明格式非法：${raw.slice(0, 60)}` };
  const kind = kindOf(km[1]);
  const rest = String(km[2] || "").trim();
  let params = {};
  if (rest) {
    let parsed;
    try {
      parsed = JSON.parse(rest);
    } catch {
      return { error: `参数不是合法 JSON：${rest.slice(0, 60)}` };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: `参数必须是 JSON 对象：${rest.slice(0, 60)}` };
    }
    params = parsed;
  }
  return { kind, params };
}

/**
 * 校验措施声明（架构正本 §三 L3：**kind 未注册即拒绝并明确报错，fail-closed**）。
 * @param {null | {kind: string} | {error: string}} decl parseHandlerDecl 的输出
 * @returns {null | string} null = 通过（或无声明）；字符串 = 明确错误原因
 */
export function validateMeasure(decl) {
  if (!decl) return null;
  if (decl.error) return decl.error;
  if (!Object.prototype.hasOwnProperty.call(MEASURE_KINDS, decl.kind)) {
    return `kind 未注册：${decl.kind}（已注册：${Object.keys(MEASURE_KINDS).join(" / ")}）`;
  }
  return null;
}
