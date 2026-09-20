// label-fingerprint.js - 打标命令指纹记忆（F2，0.5.12）
// 目标：`/guard label ERR-xxx incorrect` 后，同指纹命令直接放行并记 label-hits
// 审计；持久化到 ~/.dsh/rule-engine-labels.json。
// 安全规格（重证报告 §3.2 补充）：
//  - 开关/写参数（-Recurse/-Force 等）**必须保留**在指纹中——只归一化无害部分；
//  - 破坏类命令（rm/move/Remove-Item/irm/iwr 等）**永不进指纹放行**；
//  - 持久化带 TTL（默认 7 天）+ 可撤销（/guard label clear <fingerprint>）。
// 纯函数，可独立测试；不依赖 Cordis。
import { readFileSync, writeFileSync } from "node:fs";
import { normalizePath } from "./authorization.js";

/**
 * 命令指纹归一化规则。
 * 保留：命令名（首个 token 的小写规范形式）、开关类参数（-x/--xx）、位置参数中的"参数名前缀"（= 左侧）。
 * 归一化（无害化）：路径前缀（盘符/工作区路径）、时间戳、随机串、引号、大小写、空格压缩。
 */
export function fingerprintCommand(command) {
  const s = String(command || "").trim();
  if (!s) return "";
  // 只取主命令链的第一段（; | & 换行之后的副作用不在本命令指纹范围内——由守卫整体判定）
  const head = s.split(/[;|&\r\n]/)[0].trim();
  // 去除路径前缀（盘符路径/引号包裹路径 → 只保留最后一段 basename 与扩展名；目录变化不影响指纹）
  const depathed = head
    .replace(/(?:\\?['"]?[A-Za-z]:[\\/][^'"\s]*|['"][^'"]+|\\\/?) /g, " ")
    .replace(/\b(path|pathprefix|workdir)\s*[=:]\s*(?:['"]?[^'"\s]+['"]?)/gi, "")
    .replace(/[\\/](?:node_modules|projects|workspace)[\\/][^'"\s]*/gi, " ")
    .replace(/[\\/]+/g, "/");
  // 去除时间戳/随机串（8-16 位十六进制/数字串）
  const denormalized = depathed.replace(/\b[0-9a-f]{8,16}\b/gi, "<TS>").replace(/\b\d{6,}\b/g, "<N>");
  // 规范形式：小写 + 空白压缩
  const canonical = denormalized
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s*([=&])\s*/g, "$1")
    .trim();
  return canonical || "";
}

/** 是否破坏类命令（永不进指纹放行）——写/删除/移动/网络下载类 */
export function isDangerousCommand(command) {
  const s = String(command || "").toLowerCase();
  return /(?:remove-item|rm(?:dir)?\b|del(?:ete)?\b|move-item|move\b|copy-item|cp\b|mv\b|irm|iwr|\bcurl\b|\bwget\b|invoke-exp(?:ression)?|iex\b|new-item|set-content|add-content|out-file|rename-item|clear-content|git\s+(?:push|commit|reset|checkout|clean))/i.test(s);
}

/** 从命令文本提取可保留的"写/开关参数"（保留在指纹里，防止 -Recurse 被归一化放行） */
export function extractSignificantParams(command) {
  const s = String(command || "");
  // 开关：-x / --xx / -Force / -Recurse 等（含 = 值）
  const flags = [];
  const flagRe = /(?:^|\s)(--?[A-Za-z][\w-]*)(?:(?:=([^\s]+))|(\s+[^\s-][^\s]*\s*))?/g;
  let m;
  while ((m = flagRe.exec(s))) {
    if (m[1]) flags.push(m[1].toLowerCase());
  }
  return flags;
}

/**
 * 计算放行指纹 = 命令骨架 + 保留参数（开关原样 + 位置参数的"名称=值"对）。
 * @returns {string} 指纹字符串（稳定、可比较）；空串表示不可指纹化
 */
export function labelFingerprint(command) {
  const cmd = String(command || "").trim();
  if (!cmd) return "";
  if (isDangerousCommand(cmd)) return ""; // 危险命令永不进指纹（返回空 = 不可放行）
  const canonical = fingerprintCommand(cmd);
  if (!canonical) return "";
  const params = extractSignificantParams(cmd).sort();
  return `${canonical}|flags=${params.join(",")}`;
}

/** 打标台账记录结构 */
export function labelEntry(fingerprint, label, sid, now = Date.now(), ttlMs = 7 * 24 * 60 * 60 * 1000) {
  return { fingerprint, label, session: sid || "global", at: now, expiresAt: now + ttlMs };
}

/** 从原始 JSON 解析台账（容错：损坏返回空数组 + 旧格式兼容） */
export function parseLabels(raw) {
  try {
    const arr = JSON.parse(raw || "[]");
    if (!Array.isArray(arr)) return [];
    return arr
      .map((it) => {
        if (typeof it === "string") return { fingerprint: it, label: "incorrect", session: null, at: null, expiresAt: null };
        if (it && typeof it.fingerprint === "string") {
          return {
            fingerprint: it.fingerprint,
            label: typeof it.label === "string" ? it.label : "incorrect",
            session: typeof it.session === "string" ? it.session : null,
            at: typeof it.at === "number" ? it.at : null,
            expiresAt: typeof it.expiresAt === "number" ? it.expiresAt : null
          };
        }
        return null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** 持枪裁判：一份台账中某指纹是否命中"incorrect 放行"（且未过期） */
export function labelsAllowFingerprint(rows, fingerprint, now = Date.now()) {
  if (!fingerprint) return false;
  return rows.some((r) => r && r.fingerprint === fingerprint && r.label === "incorrect" && (!r.expiresAt || r.expiresAt > now));
}

/** 写台账（保留未过期 + 去重：同指纹同标签更新 at/expiresAt） */
export function serializeLabels(rows, now = Date.now()) {
  const keep = rows.filter((r) => r && r.fingerprint && (!r.expiresAt || r.expiresAt > now));
  // 同指纹同 label 只保留最新（去重）
  const map = new Map();
  for (const r of keep) map.set(`${r.fingerprint}|${r.label}`, r);
  return JSON.stringify([...map.values()], null, 2);
}

/** 持久化路径（与 toolsWhitelistFilePath 同模式） */
export function labelsFilePath(dshHome) {
  return `${dshHome}/rule-engine-labels.json`;
}

/** 从磁盘加载台账（纯函数输入输出：读取失败 → 空数组） */
export function loadLabelsFromDisk(filePath) {
  try {
    return parseLabels(readFileSync(filePath, "utf8"));
  } catch {
    return [];
  }
}

/** 写磁盘（失败静默——审计链路不因台账读写失败而阻断） */
export function saveLabelsToDisk(filePath, rows) {
  try {
    writeFileSync(filePath, serializeLabels(rows), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** 去重复存：同指纹同 label 记录只留最新一条（新增/更新均用） */
export function upsertLabel(rows, entry) {
  const others = rows.filter((r) => !(r.fingerprint === entry.fingerprint && r.label === entry.label));
  return [...others, entry];
}
