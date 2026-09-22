// formats.js - 规则容器「格式描述对象」的配置层（(c) 方案）。
//
// 与 patterns.js / lexicon.js 同构的双层模型，但**顶层键独立**（rule-engine.json 的 formats 键，
// 不并入 patterns）：
//   ① 通用层（本文件 DEFAULT_FORMATS）——语言无关；发布面默认值对中文规则文件仍必要（见下注）。
//   ② 个人层（rule-engine.json.formats）——undefined/null = 不干预（保持当前）；
//      对象 = 配置即真相，**按键完全替换**；`{}` = 回退内置默认。
//
// 与既有配置层的**关键差别**：这里描述的不是「一份词表」，而是**格式契约**——
// 一个键就是一个格式描述对象，含 source / flags / 具名捕获组（capture.*）/（elements 专有）labels.*。
// `capture` 的值是**捕获组名**：写代码的哪个组是什么，由配置说了算（不再由代码位置约定）。
//
// 同 Override 语义（一致于 setPatterns）：非法键/非法形状被拒绝并返回明细（不静默半套生效）。
//
// 注（默认值的性质）：五处默认 source **逐字取自 0.6.5 现盘 parser.js L7／L8／L9-10／L81／L102**，
// 保证「不注入 formats」与「注入旧行为」严格等价（回归由 test/formats-config.test.mjs 用 LEGACY 快照锁定）。
// 其中 rule_header / level / elements 三处默认**含中文**——它们是规则容器自身的入口格式契约；
// 按用户 2026-09-15 裁定，这批「格式词」的迁移归属域 1（`lib/` 剩余中文正则按域迁配置层）。

/** 格式键清单（顶层；一个键 = 一个格式描述对象） */
export const FORMAT_KEYS = ["rule_header", "section", "free_zone", "level", "elements"];

/**
 * 每个键**期望**具备的捕获组（供消费方与测试自证；不做强制校验——
 * 缺组时消费方按「空值不炸」处理，见 parser.js 头注）。
 *
 * capture 的值可以是**具名组名**（如 "id"）或**编号字符串**（如 "1"）：
 *   · 具名：消费方按 `m.groups[name]` 取值 → 写具名组（`(?<id>…)`）时用这种。
 *   · 编号：消费方按 `m[Number(value)]` 取值 → **自定义 source 时不必依赖组名**（契约写 source、capture 指位置）。
 * 注：free_zone 无捕获组（起止注只需识别、不需取值），故不在此表内；
 *     elements 的标签由 `labels.*` 代入 source 的 `__LABEL__` 占位符（见该键默认值）。
 */
export const FORMAT_CAPTURES = {
  rule_header: ["id", "title"],
  section: ["title"],
  level: ["level"],
  elements: ["body"]
};

/** 合法的 capture 值：JavaScript 具名组名 或 编号字符串 */
const CAPTURE_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const CAPTURE_INDEX_RE = /^[1-9][0-9]?$/;

/** 编译用 flags 白名单（**不含 g**：格式正则按行逐次使用，带 g 会因共享对象的 lastIndex 抖动而漏判） */
const FLAG_WHITELIST = ["d", "i", "m", "s", "u", "v", "y"];

/** 内置默认（通用层）：五处格式预设的现盘快照（flags 一律空——现盘原正则均无 flags，故不写 g） */
export const DEFAULT_FORMATS = Object.freeze({
  rule_header: {
    source: "^###\\s*\\[规则\\s*(?<id>[0-9A-Za-z]+)\\]\\s*(?<title>.+?)\\s*(?:（来源[^）]*）)?\\s*$",
    flags: "",
    capture: { id: "id", title: "title" }
  },
  section: {
    source: "^##\\s+(?<title>.+?)\\s*$",
    flags: "",
    capture: { title: "title" }
  },
  free_zone: {
    start: { source: "^\\s*<!--\\s*free-zone:start\\s*-->\\s*$" },
    end: { source: "^\\s*<!--\\s*free-zone:end\\s*-->\\s*$" },
    flags: ""
  },
  level: {
    source: "执行等级[：:]\\s*(?<level>[A-DM+](?:\\s*[强弱])?(?:\\s*[+＋、]\\s*[A-DM+](?:\\s*[强弱])?)*)",
    flags: "",
    capture: { level: "level" }
  },
  elements: {
    // 旧 grab 那条正则：标签处抽成占位符 __LABEL__（编译时逐标签代入），正文用具名组
    // （现盘旧实现无 flags；需要大小写与换行差异时由配置给 flags）
    source: "\\*\\*__LABEL__(?:（[^）]*）)?\\*\\*[：:]\\s*(?<body>[^\\n]*(?:\\n(?!\\s*\\*\\*)[^\\n]*)*)",
    flags: "",
    capture: { body: "body" },
    labels: { trigger: "触发", check: "检查", action: "动作", exemption: "豁免" }
  }
});

export const DEFAULT_FORMAT_KEY_COUNT = FORMAT_KEYS.length;

/** 模块态：个人层覆盖（null = 内置默认）；reCache 键 = `${key}\0${flagKey}\0${source}` */
let formatsOverride = null;
let reCache = new Map();

/** 规范化 flags：白名单过滤 + 去重 + 排序（顺序固定，保证缓存键稳定） */
function normFlags(flags) {
  if (typeof flags !== "string" || flags.length === 0) return "";
  const set = new Set();
  for (const ch of flags) if (FLAG_WHITELIST.includes(ch)) set.add(ch);
  return FLAG_WHITELIST.filter((f) => set.has(f)).join("");
}

function compileRe(source, flags) {
  if (typeof source !== "string" || source.length === 0) return null;
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** 取生效格式对象（个人层优先 → 内置默认）；副本语义：返回结构引用，调用方勿改写 */
function resolveFormat(key) {
  const ov = formatsOverride?.[key];
  if (isPlainObject(ov)) return ov;
  return DEFAULT_FORMATS[key] ?? null;
}

/**
 * 取编译好的格式正则。
 * @param {string} key 格式键（FORMAT_KEYS 之一）
 * @param {string} part 子部分：""（整体）| "start" | "end"（仅 free_zone 用）
 * @returns {RegExp|null} 非法/缺键 → null（消费方负责降级，不抛）
 */
export function getFormatRe(key, part = "") {
  const fmt = resolveFormat(key);
  if (!fmt) return null;
  const spec = part ? fmt?.[part] : fmt;
  if (!isPlainObject(spec)) return null;
  const source = spec.source;
  const flags = normFlags(fmt.flags);
  const cacheKey = `${key}\0${part}\0${flags}\0${source}`;
  if (reCache.has(cacheKey)) return reCache.get(cacheKey);
  const re = compileRe(source, flags);
  reCache.set(cacheKey, re);
  return re;
}

/** 取生效格式描述对象（原始形状，供测试/自证/诊断用） */
export function getFormat(key) {
  return resolveFormat(key);
}

/** 取生效的具名捕获组映射（capture.*）；缺省 = 空对象 */
export function getFormatCapture(key) {
  const c = resolveFormat(key)?.capture;
  return isPlainObject(c) ? c : {};
}

/** elements 专有：取标签表（labels.trigger / check / action / exemption）；缺省 = 空对象 */
export function getFormatLabels(key = "elements") {
  const l = resolveFormat(key)?.labels;
  return isPlainObject(l) ? l : {};
}

/** 校验单个格式描述对象；返回 null = 合法，否则返回拒绝原因 */
function reasonFor(key, spec) {
  if (!isPlainObject(spec)) return "not-object";
  if (key === "free_zone") {
    for (const part of ["start", "end"]) {
      const p = spec[part];
      if (!isPlainObject(p)) return `missing-${part}`;
      if (compileRe(p.source, normFlags(spec.flags)) === null) return `invalid-regex:${part}`;
    }
    return null;
  }
  if (compileRe(spec.source, normFlags(spec.flags)) === null) return "invalid-regex-source";
  if (spec.capture !== undefined && !isPlainObject(spec.capture)) return "invalid-capture";
  if (spec.capture) {
    for (const [slot, groupRef] of Object.entries(spec.capture)) {
      if (typeof groupRef !== "string" || !(CAPTURE_NAME_RE.test(groupRef) || CAPTURE_INDEX_RE.test(groupRef))) {
        return `invalid-capture:${slot}`;
      }
    }
  }
  if (key === "elements" && spec.labels !== undefined) {
    if (!isPlainObject(spec.labels)) return "invalid-labels";
    for (const [slot, label] of Object.entries(spec.labels)) {
      if (typeof label !== "string" || label.length === 0) return `invalid-labels:${slot}`;
    }
  }
  return null;
}

/**
 * 注入个人层格式描述（rule-engine.json 的 formats 键）。
 *
 * 语义边界（同 setPatterns）：
 *   · cfg 为 undefined/null（配置里没这个键）→ **不改变当前状态**（不干预）。
 *   · cfg 为对象 → 配置即真相：**按键完全替换**（Override）；`{}` = 无有效键 = 回退内置默认。
 *   · 非对象（数组/字符串/数字）→ 清空覆盖、回退内置默认，并记 1 条 `not-object`。
 * 非法/未知键被拒绝并返回明细（不静默半套生效）。
 * @returns {{applied: string[], rejected: Array<{key: string, reason: string}>, noop?: boolean}}
 */
export function setFormats(cfg) {
  const applied = [];
  const rejected = [];
  if (cfg === undefined || cfg === null) {
    return { applied, rejected, noop: true }; // 配置缺省：不干预
  }
  if (!isPlainObject(cfg)) {
    formatsOverride = null;
    reCache = new Map();
    rejected.push({ key: "(root)", reason: "not-object" });
    return { applied, rejected };
  }
  const next = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (!FORMAT_KEYS.includes(k)) {
      rejected.push({ key: k, reason: "unknown-key" });
      continue;
    }
    const reason = reasonFor(k, v);
    if (reason) {
      rejected.push({ key: k, reason });
      continue;
    }
    next[k] = v;
    applied.push(k);
  }
  formatsOverride = Object.keys(next).length > 0 ? next : null;
  reCache = new Map();
  return { applied, rejected };
}

/** 清空个人层覆盖，回退内置默认 */
export function resetFormats() {
  formatsOverride = null;
  reCache = new Map();
}

/** 是否处于个人层覆盖态（诊断/测试用） */
export function hasFormatOverride() {
  return formatsOverride !== null;
}
