// pnpm-exempt.mjs — pnpm-workspace minimumReleaseAgeExclude 豁免判定（verify-all ⑬ 与 release-plugin 预插共享单源）
// 约定（exempt 语义）：行含包名（`pkg@`）且版本段任一匹配——yaml 支持 `- pkg@1.5.3 || 1.5.4` 形态（段可带/不带包名前缀）
import { readFileSync, writeFileSync } from "node:fs";

export function exemptPkg(wsYaml, pkg, ver) {
  if (typeof wsYaml !== "string" || wsYaml.length === 0) return false;
  return wsYaml.split(/\r?\n/).some((l) => l.includes(`${pkg}@`) && l.split(/\s*\|\|\s*/).some((tok) => {
    const t = tok.trim().replace(/^-\s*/, "");
    return t === ver || t === `${pkg}@${ver}`;
  }));
}

/** 追加豁免行（已存在=幂等跳过；返回 {yaml, added}） */
export function addExemptLine(wsYaml, pkg, ver) {
  if (exemptPkg(wsYaml, pkg, ver)) return { yaml: wsYaml, added: false };
  const sep = wsYaml.endsWith("\n") ? "" : "\n";
  return { yaml: `${wsYaml}${sep}  - ${pkg}@${ver}\n`, added: true };
}

/** 读 yaml（fail-closed：读取失败抛错，调用方中止发布） */
export function readYamlOrThrow(path) {
  try {
    const text = readFileSync(path, "utf8");
    if (!text.includes("minimumReleaseAgeExclude")) throw new Error(`yaml 缺 minimumReleaseAgeExclude 块：${path}`);
    return text;
  } catch (e) {
    if (e.code === "ENOENT") throw new Error(`yaml 不存在（fail-closed）：${path}`);
    throw e;
  }
}

/**
 * 预插核心（release-plugin bump 后 publish 前调用；单测可注入 dryRun/write/log）：
 * 已存在=幂等跳过；yaml 缺失/坏=抛错（fail-closed）；dryRun=只打印不写。
 */
export function ensureExempt(yamlPath, pkgName, ver, opts = {}) {
  const { dryRun = false, write = (p, c) => writeFileSync(p, c, "utf8"), log = console.log } = opts;
  let yaml;
  try {
    yaml = readYamlOrThrow(yamlPath);
  } catch (e) {
    throw new Error(`豁免预插失败（fail-closed 中止）：${e.message}`);
  }
  const { yaml: nextYaml, added } = addExemptLine(yaml, pkgName, ver);
  if (dryRun) {
    log(`[DRY-RUN] 豁免预插：${added ? `将追加 ${pkgName}@${ver}` : `已存在（幂等跳过）`}`);
    return { added, dryRun: true };
  }
  if (added) {
    write(yamlPath, nextYaml);
    log(`豁免预插：+ ${pkgName}@${ver}`);
  } else {
    log(`豁免预插：${pkgName}@${ver} 已存在（幂等跳过）`);
  }
  return { added };
}
