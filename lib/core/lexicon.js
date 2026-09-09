// lexicon.js - 规则引擎行为词表的唯一源（0.5.11 起"唯一词表源"；P8 小批 A 起双层化）。
//
// 双层模型（P8 小批 A，2026-09-08）：
//   ① 通用层（内置默认 BUILTIN_LEXICONS）——语言无关最小集，随包发布，不含任何中文/本机行为词；
//   ② 个人层（rule-engine.json 的 lexicons 键）——null/缺省 = 用内置默认；非空 = 按键完全替换。
//      机制同 setTypeHints（Override 模式）：不做合并，配置即真相，删键即回退。
//
// 为什么取词必须走函数（lexRe / xxxRe()）而不能缓存正则对象：
//   配置注入发生在模块求值之后（index.js 启动时 setLexicons）。若调用方在模块顶层
//   `const X = SOME_RE` 缓存引用，注入后旧引用永不更新——这正是本批要根除的形态。
//
// 词表键（LEXICON_KEYS，11 张）与语义见 README「词表配置」章节。

/** 词表键名（顺序即文档顺序；approval_exec 为派生键，可显式覆盖） */
export const LEXICON_KEYS = [
  "approval",          // ① 执行许可词（"确认/同意/可以…"）
  "exec_follow",       // ① 执行语（许可词 + 执行语 = 执行许可）
  "approval_exec",     // ① 派生：approval + 0..16 字符 + exec_follow（可显式覆盖）
  "plan_only",         // ① 纯方案/理解确认（不构成执行授权）
  "action_words",      // ② 执行动作词（意图判定与授权判定共用）
  "strong_exec",       // ② 强执行语（直接执行指令，不等授权确认）
  "directive",         // ② 指令式动作词（命令式指令 = 视为授权执行）
  "rejection",         // ② 拒绝词
  "question",          // ③ 疑问词（问询分点判定）
  "status_signal",     // ④ 状态信号词（就绪确认，不判"无执行分点"）
  "dangerous_action"   // ④ 危险动作词（命中则不当作状态信号）
];

// ── 通用层：内置默认（语言无关最小集）────────────────────────────────────────
// 约束：本表随 npm 包发布 → 不得含中文或任何本机专属行为词；
// 中文词表由本机 rule-engine.json.lexicons 注入（缺省时引擎按此最小集工作）。
const BUILTIN_LEXICONS = {
  approval: "(?:ok|yes|y|approve|approved|agree|agreed|allow|allowed|permission granted)",
  exec_follow: "(?:now|go ahead|proceed|continue|start|execute|run|apply|do it|write|save|delete|modify|create|install|publish|download|commit|push|fix|replace|rebuild|restart|stop|uninstall|update|deploy)",
  plan_only: "confirm (?:the )?plan|understood|got it|acknowledged|noted|received",
  action_words: "(?:execute|run|apply|write|save|delete|modify|edit|create|install|publish|download|commit|push|fix|replace|rebuild|start|restart|stop|uninstall|improve|optimize|enhance|upgrade|migrate|tidy|adjust|implement|add|append|rewrite|refactor|debug|investigate|resolve|continue|advance|update|deploy|verify|comb|diagnose|align|follow up|design and implement|survey|kick off|proceed|complete|choose|adopt|select|produce|author|write up|generate|review|read|inspect|check|audit|recheck|consult|validate|compare|research|study|convert|transform|fetch|read out|display|open|extract|restore|import|export|clean|remove|purge|merge|integrate|draft|carry out|build|make compatible|validate|re-verify)",
  strong_exec: "(?:execute now|start now|do it|go ahead|proceed now|apply now|start writing|start editing|carry it out|adopt|selected)",
  directive: "(?:please\\s+)?(?:delete|remove|modify|edit|replace|write|save|create|copy|move|execute|run|download|commit|push|backup|install|uninstall|clean|start|stop|rebuild|fix|implement|advance|continue|handle|resolve)",
  rejection: "(?:do not|don'?t|reject|rejected|cancel|no(?!tes?|thing|pe)\\b|\\bno\\b)",
  question: "[?]|why|whether|can (?:you|i)|could (?:you|i)|should (?:you|i)|how|what about|is it|are there",
  status_signal: "(?:^|\\s)(?:done|restarted|finished|entered|completed|ready|input done)(?:\\s|$)",
  dangerous_action: "(?:remove-item|rm\\s+-r|del\\s+|overwrite|drop\\s+table)"
};

let lexiconsOverride = null; // null = 内置默认；非 null = 按键完全替换（Override）
let reCache = new Map();     // "key\0source" -> RegExp（setLexicons 时清空）

function compileRe(source, flags) {
  if (typeof source !== "string" || source.length === 0) return null;
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

/** 解析单个键的生效 source（个人层优先 → 派生键 → 内置默认） */
function resolveSource(key) {
  const ov = lexiconsOverride?.[key];
  if (typeof ov === "string" && ov.length > 0) return ov;
  if (key === "approval_exec") {
    // 派生：许可词 [0,16 字符内] 执行语（与 0.5.11 内置组合语义一致）
    return `${resolveSource("approval")}[^\\n]{0,16}${resolveSource("exec_follow")}`;
  }
  return BUILTIN_LEXICONS[key] ?? "";
}

/**
 * 注入个人层词表（rule-engine.json 的 lexicons 键）。
 *
 * 语义边界（P8 小批 A）：
 *   · cfg 为 undefined/null（配置里没这个键）→ **不改变当前状态**（不干预词表层）。
 *     进程首次启动时模块态本就是内置默认，故"不干预" == "用内置默认"；而这一条同时让
 *     测试夹具（先注入、后加载 index.js）不被插件启动流程清掉。
 *   · cfg 为对象 → 配置即真相：按键完全替换（Override）；`{}` = 无有效键 = 回退内置默认。
 * 非法/未知键被拒绝并返回明细（不静默半套生效）。
 * @returns {{applied: string[], rejected: Array<{key: string, reason: string}>, noop?: boolean}}
 */
export function setLexicons(cfg) {
  const applied = [];
  const rejected = [];
  if (cfg === undefined || cfg === null) {
    return { applied, rejected, noop: true }; // 配置缺省：不干预
  }
  if (typeof cfg !== "object" || Array.isArray(cfg)) {
    lexiconsOverride = null;
    reCache = new Map();
    return { applied, rejected };
  }
  const next = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (!LEXICON_KEYS.includes(k)) {
      rejected.push({ key: k, reason: "unknown-key" });
      continue;
    }
    if (typeof v !== "string" || v.length === 0) {
      rejected.push({ key: k, reason: "empty-or-not-string" });
      continue;
    }
    if (!compileRe(v, "i")) {
      rejected.push({ key: k, reason: "invalid-regex" });
      continue;
    }
    next[k] = v;
    applied.push(k);
  }
  lexiconsOverride = Object.keys(next).length > 0 ? next : null;
  reCache = new Map();
  return { applied, rejected };
}

/** 显式回退内置默认（测试用；生产环境改配置后由插件重载生效） */
export function resetLexicons() {
  lexiconsOverride = null;
  reCache = new Map();
}

/** 当前生效的词表快照（键 → source；供 /guard 展示与测试断言，只读） */
export function effectiveLexicons() {
  const out = {};
  for (const k of LEXICON_KEYS) out[k] = resolveSource(k);
  return out;
}

/** 当前是否处于个人层覆盖状态（true = 至少一个键来自配置） */
export function hasLexiconOverride() {
  return lexiconsOverride !== null;
}

/**
 * 取当前生效正则（唯一取词入口；调用方禁止缓存返回对象）。
 * 非法/空 source → 返回永不命中的占位正则（守卫无对象，自然静默）。
 */
export function lexRe(key) {
  const source = resolveSource(key);
  const ck = `${key}\u0000${source}`;
  let hit = reCache.get(ck);
  if (!hit) {
    hit = compileRe(source, "i") || /(?!)/;
    reCache.set(ck, hit);
  }
  return hit;
}

// ── 语义命名访问器（调用方优先用这些，避免手写键名字符串）──
export const approvalWordsRe = () => lexRe("approval");
export const execFollowRe = () => lexRe("exec_follow");
export const approvalExecRe = () => lexRe("approval_exec");
export const planOnlyRe = () => lexRe("plan_only");
export const actionWordsRe = () => lexRe("action_words");
export const strongExecRe = () => lexRe("strong_exec");
export const directiveWordsRe = () => lexRe("directive");
export const rejectionWordsRe = () => lexRe("rejection");
export const questionWordsRe = () => lexRe("question");
export const statusSignalRe = () => lexRe("status_signal");
export const dangerousActionRe = () => lexRe("dangerous_action");

// ── ⑤ 豁免工具清单（规则 22 ③ "只读/展示/ask/todo_write 等豁免"明细）──
// 注：工具名清单不是行为词表（语言无关），不进 lexicons 配置层。
// 只读/展示/询问/产物类工具在"无执行分点"回合也可调用（引擎 tool-catalog 的 analysis/artifact 分类
// 为总开关；本清单 = 规则正文"等豁免"所指的可枚举集，与 tool-catalog 一致，此处集中注释成对）。
export const EXEMPT_TOOL_NAMES = new Set([
  // 只读/查询
  "read", "grep", "glob", "read_image",
  // 视觉分析
  "vision_describe", "vision_detect", "vision_ground", "vision_colors", "vision_ocr", "vision_bootstrap",
  // 状态查询
  "job_list", "job_output", "list_agents", "get_goal", "schedule_list",
  "engram_recall", "engram_detail", "engram_model",
  "esr_status", "esr_ready", "esr_model",
  // 网络只读
  "web_fetch", "web_search",
  // 询问/展示/产物
  "ask_user_question", "todo_write", "visualize", "report",
  // inspect 只读
  "cordis_inspect_list", "cordis_inspect_query", "cordis_inspect_self"
]);
