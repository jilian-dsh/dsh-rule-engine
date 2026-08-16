// mount-signature.js - 规则 27 装配状态哈希
// 用“装配内容”而不是单调 revision 判断是否需要重跑全量审计。
// 覆盖：profile bundles、本地 dependencies（link/file/github/http）、用户 patch、根 patch、bundle 内部 patch、运行时注入 registry。
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dshHome } from "./paths.js";

function tryRead(p) {
  try {
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  } catch {
    return "";
  }
}

function resolveBundlePkg(b, profileDir, home) {
  const candidates = [
    join(profileDir, "node_modules", b, "package.json"),
    join(home, "profiles", "node_modules", b, "package.json")
  ];
  if (b.startsWith("@")) {
    const [scope, name] = b.split("/");
    candidates.push(join(home, "profiles", "node_modules", scope, name, "package.json"));
  }
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

/** 从工具参数/命令中提取目标 profile 名（缺省 web） */
export function profileNameFromArgs(args = {}) {
  const p = String(args.file_path || args.path || "");
  const pm = p.match(/profiles[\\/]([^\\/]+)[\\/]/i);
  if (pm) return pm[1];
  if (args.profile) return String(args.profile);
  const cmd = String(args.command || args.code || "");
  let idx = cmd.indexOf("--profile");
  if (idx >= 0) {
    const rest = cmd.slice(idx + "--profile".length).trim();
    const val = rest.replace(/^=/, "").split(/\s+/)[0];
    if (val) return val;
  }
  return "web";
}

/** 计算装配状态哈希；profile 缺失时返回固定 missing 标记，避免误伤 */
export function computeMountSignature(profileName = "web") {
  const home = dshHome();
  const profileDir = join(home, "profiles", profileName);
  const pkgPath = join(profileDir, "package.json");
  if (!existsSync(pkgPath)) return `missing-profile:${profileName}`;
  const hash = createHash("sha256");
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch (e) {
    return `profile-parse-error:${profileName}:${e instanceof Error ? e.message : String(e)}`;
  }
  const bundles = pkg?.dsh?.profile?.bundles || [];
  const deps = pkg?.dependencies || {};
  hash.update("bundles:" + JSON.stringify(bundles));
  // 只把会影响装配类型判断的本地依赖纳入哈希；普通 registry 版本变化不触发重审计
  const localDeps = {};
  for (const [name, spec] of Object.entries(deps)) {
    if (typeof spec === "string" && /^(link:|file:|github:|http)/i.test(spec)) localDeps[name] = spec;
  }
  hash.update("localDeps:" + JSON.stringify(localDeps));
  hash.update("profilePatch:" + tryRead(join(profileDir, "cordis.patch.yml")));
  hash.update("rootPatch:" + tryRead(join(home, "cordis.patch.yml")));
  hash.update("injectRegistry:" + tryRead(join(home, "super-injector", "registry.json")));
  for (const b of bundles) {
    const bp = resolveBundlePkg(b, profileDir, home);
    if (!bp) {
      hash.update("bundleMissing:" + b);
      continue;
    }
    try {
      const pkgB = JSON.parse(readFileSync(bp, "utf8"));
      hash.update("bundlePkg:" + b + ":" + JSON.stringify({ version: pkgB.version, dsh: pkgB.dsh }));
      const patchRel = pkgB?.dsh?.bundle?.patch;
      if (patchRel) hash.update("bundlePatch:" + b + ":" + tryRead(join(dirname(bp), patchRel)));
    } catch (e) {
      hash.update("bundlePkgError:" + b + ":" + (e instanceof Error ? e.message : String(e)));
    }
  }
  return hash.digest("hex");
}
