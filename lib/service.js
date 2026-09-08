// service.js —— 规则引擎 host 端 Remote 服务
// 供设置面板（dsh-rules-manager-client 的“规则引擎”页签）通过 ctx.remote.ruleEngine.* 调用。
// 与 rules-manager/service.js 同构：TypertRemoteService + 手动 @Remote 标记。
import { readFileSync } from "node:fs";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { state } from "./core/runtime.js";
import { readAuditLog, audit } from "./core/audit.js";
import { loadPluginConfig, savePluginConfig } from "./core/config.js";
import { applyTaskContractConfig, saveTurnCardsToDisk } from "./core/state.js";
import { agentsFilePath, auditFilePath, dshHome } from "./core/paths.js";
import { labelFingerprint, labelEntry, labelsFilePath, saveLabelsToDisk, upsertLabel } from "./core/label-fingerprint.js";

const REMOTE_METHODS = [
  "getStatus",
  "getVersion",
  "checkUpdate",
  "getAuditLog",
  "getUnderstanding",
  "getTaskContractConfig",
  "setTaskContractConfig",
  "getRuleStats",
  "getTurnCard",
  "rateTurnCard"
];

function currentVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** 仓库 slug（owner/repo）：从 package.json repository 解析——通用化后不硬编码作者仓库；
 *  空 = 无法解析（发布包必带 repository，正常路径；异常时检查功能不可用，fail-closed 无害）。 */
function repoSlug() {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const url = String(pkg.repository?.url || pkg.repository || "");
    const m = url.match(/github\.com[/:]([^/]+\/[^/.]+)/);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

function parseVersion(v) {
  const s = String(v || "").replace(/^v/i, "");
  const parts = s.split(".").map((n) => parseInt(n, 10) || 0);
  return { major: parts[0] || 0, minor: parts[1] || 0, patch: parts[2] || 0 };
}

function isNewerVersion(a, b) {
  const A = parseVersion(a);
  const B = parseVersion(b);
  if (B.major !== A.major) return B.major > A.major;
  if (B.minor !== A.minor) return B.minor > A.minor;
  return B.patch > A.patch;
}

class RuleEngineService extends TypertRemoteService {
  static inject = [];

  constructor(ctx) {
    super(ctx, "ruleEngine");
    // 0.1.2 适配（2026-09-07，实markers 验证）：typert-protocol 0.1.2 Remote() 三分支——
    // ① 一参字符串=exportName 工厂；② typeof 一参==='object'（含 null！）=流选项校验
    //   （仅容 {mode:'stream'}，其余 TypeError——Remote(null,…) 在 0.1.2 因 typeof null===
    //   'object' 落此分支崩溃，即本次升级事故 engine 侧根因；0.1.1 的 null 直落③分支）；
    // ③ 一参 undefined + 二参 context=addMarkerInitializer(context,{kind:'direct'})。
    // 手动标记形态=Remote(undefined, fakeContext)，context 含 {name,private,static,addInitializer}。
    for (const name of REMOTE_METHODS) {
      Remote(undefined, {
        name,
        private: false,
        static: false,
        addInitializer: (fn) => {
          fn.call(this);
        }
      });
    }
  }

  /** 引擎当前状态（版本/开关/规则数/审计路径/最近激活等） */
  async getStatus() {
    try {
      const conf = loadPluginConfig();
      return {
        ok: true,
        status: {
          version: currentVersion(),
          enabled: state.enabled,
          configOk: state.configOk,
          configError: state.configError || "",
          rulesCount: state.configs.length,
          mountRevision: state.mountRevision,
          auditFile: auditFilePath(),
          agentsFile: agentsFilePath(),
          reloadCount: state.reloadCount,
          lastActive: (state.lastActive || []).slice(0, 10)
        }
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 当前版本号 */
  async getVersion() {
    return { ok: true, version: currentVersion() };
  }

  /**
   * 检查 GitHub 最新 Release 与 upgrade-impact.json。
   * 只读检查，不下载、不替换、不修改任何用户规则。
   */
  async checkUpdate() {
    try {
      const current = currentVersion();
      const slug = repoSlug();
      if (!slug) return { ok: false, error: "仓库信息缺失，无法检查更新" };
      const headers = { "User-Agent": "dsh-rule-engine", Accept: "application/vnd.github+json" };
      // P2-8：网络异常/慢速时避免面板挂起
      const releaseRes = await fetch(`https://api.github.com/repos/${slug}/releases/latest`, { headers, signal: AbortSignal.timeout(8000) });
      if (!releaseRes.ok) {
        return { ok: false, error: `GitHub Release 检查失败：HTTP ${releaseRes.status}` };
      }
      const release = await releaseRes.json();
      const latestTag = String(release.tag_name || "").replace(/^v/i, "");
      const hasUpdate = isNewerVersion(current, latestTag);

      let impacts = [];
      try {
        const impactRes = await fetch(`https://raw.githubusercontent.com/${slug}/main/upgrade-impact.json`, { headers: { "User-Agent": "dsh-rule-engine" }, signal: AbortSignal.timeout(8000) });
        if (impactRes.ok) {
          const data = await impactRes.json();
          if (Array.isArray(data?.versions)) {
            impacts = data.versions
              .filter((v) => v && isNewerVersion(current, String(v.version || "").replace(/^v/i, "")))
              .sort((a, b) => isNewerVersion(String(a.version || ""), String(b.version || "")) ? 1 : -1);
          }
        }
      } catch {
        // impact 文件拉取失败不影响 Release 检查结果
      }

      return {
        ok: true,
        current,
        latest: {
          tag_name: release.tag_name || "",
          name: release.name || "",
          published_at: release.published_at || "",
          html_url: release.html_url || "",
          body: release.body || "",
          assets: Array.isArray(release.assets) ? release.assets.map((a) => ({
            name: a.name,
            browser_download_url: a.browser_download_url,
            size: a.size
          })) : []
        },
        hasUpdate,
        impacts
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 最近审计日志（默认 10 条） */
  async getAuditLog(n) {
    try {
      const count = Math.min(Math.max(1, Number(n) || 10), 200);
      return { ok: true, entries: readAuditLog(count) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 规则理解摘要（ruleId/title/level/handler/confidence/actions） */
  async getUnderstanding() {
    try {
      return {
        ok: true,
        rules: (state.configs || []).map((c) => ({
          ruleId: c.ruleId,
          title: c.title,
          level: c.level || "",
          handler: c.handler || "",
          confidence: c.confidence || "",
          actions: c.actions || [],
          disabled: c.disabled === true
        }))
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 读取任务契约配置（设置页） */
  async getTaskContractConfig() {
    try {
      const conf = loadPluginConfig();
      return {
        ok: true,
        config: {
          taskContractEnabled: conf.taskContractEnabled === true,
          askEnabled: conf.askEnabled === true,
          taskContractMode: conf.taskContractMode === "armed" ? "armed" : "observe",
          taskContractDefaults: conf.taskContractDefaults || {},
          turnCard: { enabled: conf.turnCard?.enabled === true },
          approveEnabled: conf.approveEnabled === true
        }
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 保存任务契约配置（设置页；写入 rule-engine.json 并热同步 state） */
  async setTaskContractConfig(partial) {
    try {
      audit({ kind: "guard-command", rule: "__settings-save", name: "设置页保存", event: "command", reason: `setTaskContractConfig keys=${JSON.stringify(Object.keys(partial || {}))}`, session: "global" });
      const conf = savePluginConfig(partial || {});
      applyTaskContractConfig(state, conf);
      return {
        ok: true,
        config: {
          taskContractEnabled: conf.taskContractEnabled === true,
          askEnabled: conf.askEnabled === true,
          taskContractMode: conf.taskContractMode === "armed" ? "armed" : "observe",
          taskContractDefaults: conf.taskContractDefaults || {},
          turnCard: { enabled: conf.turnCard?.enabled === true },
          approveEnabled: conf.approveEnabled === true
        }
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** C2 轻量版：规则统计（detected/suppressed/injected，会话聚合；只读） */
  async getRuleStats() {
    try {
      const rows = aggregateRuleStats(state.sessions.values());
      return {
        ok: true,
        stats: rows,
        totals: rows.reduce((t, r) => ({
          detected: t.detected + r.detected,
          suppressed: t.suppressed + r.suppressed,
          injected: t.injected + r.injected
        }), { detected: 0, suppressed: 0, injected: 0 }),
        sessions: state.sessions.size
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * 0.5.15：按 assistant messageId 取回合末裁决卡片。
   * client 端 assistant-actions 挂载时传当前消息 id；host 用
   * state.cardByMessage 倒查（index.js 在 turn/end 时登记 closing 消息 → 卡片）。
   * 开关 turnCard.enabled=false 时恒返回 null（默认关——面向大众）。
   */
  async getTurnCard(messageId) {
    try {
      const conf = loadPluginConfig();
      if (conf.turnCard?.enabled !== true) return { ok: true, card: null };
      const card = state.cardByMessage?.get?.(String(messageId || ""));
      if (!card) return { ok: true, card: null };
      return { ok: true, card };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * 0.5.15：判例登记（✅=correct 留档 / ❌=incorrect 学习+指纹放行）。
   * 与 /guard label incorrect 同链路：写 state.labels + 命令指纹台账（持久化）。
   * expectedVerdict：卡片上已显示的打标状态（防重复点击/防旧卡回放误登记）。
   * blockIndex：要登记的是卡片中第几条裁决（一回合多次裁决 → 每条独立判定）。
   */
  async rateTurnCard(messageId, verdict, expectedVerdict, blockIndex) {
    try {
      return rateTurnCardHost(String(messageId || ""), verdict, expectedVerdict, blockIndex);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

/** 纯函数：聚合各会话 ruleStats（C2，可独立测试） */
export function aggregateRuleStats(sessions) {
  const merged = {};
  for (const s of sessions) {
    for (const [ruleId, st] of Object.entries(s.ruleStats || {})) {
      const m = (merged[ruleId] ||= { ruleId, detected: 0, suppressed: 0, injected: 0 });
      m.detected += st.detected || 0;
      m.suppressed += st.suppressed || 0;
      m.injected += st.injected || 0;
    }
  }
  return Object.values(merged).sort((a, b) => b.detected - a.detected);
}

/**
 * 0.5.15：回合末卡片判例登记（纯函数，可独立测试）。
 * verdict: "correct"（拦对了，留档）/ "incorrect"（拦错了，学习+命令指纹放行）。
 * blockIndex：要登记的是卡片中第几条裁决（一回合多次裁决 → 每条独立判定）。
 * 与 /guard label incorrect 同链路：incorrect 时写命令指纹台账（持久化）；
 * correct 只记审计留档（不产生指纹放行）。
 * 一次性语义（2026-09-02 用户拍板）：每条裁决独立一次性锁定（per-block，
 * 已登记且非同状态重复 → 拒绝改判；改判走 /guard label 命令行）。
 */
export function rateTurnCardHost(messageId, verdict, expectedVerdict, blockIndex) {
  const idx = Number.isInteger(blockIndex) ? blockIndex : -1;
  // blockIndex 为 -1 = 兼容旧调用（整卡打标），新 client 必传具体索引
  const card = state.cardByMessage?.get?.(String(messageId || ""));
  if (!card) return { ok: false, error: "未找到该消息对应的裁决卡片" };
  if (!card.key) return { ok: false, error: "卡片不可打标（缺少稳定键）" };
  const isLegacy = idx < 0;
  const blocks = Array.isArray(card.blocks) ? card.blocks : [];
  const block = isLegacy ? null : blocks[idx];
  if (!isLegacy && !block) return { ok: false, error: `裁决块 #${idx} 不存在` };
  if (typeof verdict !== "string" || (verdict !== "correct" && verdict !== "incorrect")) {
    return { ok: false, error: "verdict 只能是 correct 或 incorrect" };
  }
  const label = verdict === "correct" ? "correct" : "incorrect";
  // 当前块的已登记状态（legacy = 卡片级 card.label；block 级 = block.label）
  const currentLabel = isLegacy ? (card.label || null) : (block?.label ?? null);
  // 幂等确认（防重复点击）：提交与当前显示相同 → 直接成功，不重复审计/写台账
  if (expectedVerdict && expectedVerdict !== "none" && expectedVerdict === verdict) {
    return { ok: true, verdict: label, messageId, already: true };
  }
  // 一次性语义：已登记且非同状态重复 → 拒绝改判；改判应走 /guard label 命令行
  if (currentLabel === "correct" || currentLabel === "incorrect") {
    return { ok: false, error: `该${isLegacy ? "卡片" : "裁决块"}已登记为 ${currentLabel}（判例一次性，不再更改；如需改判请 /guard label ${currentLabel} 相关事件）` };
  }
  let fingerprintNote = "";
  if (label === "incorrect") {
    // 只对目标 block 的命令做指纹（一回合多次裁决：只学习被判错的那条）
    const target = isLegacy ? blocks : [block];
    for (const b of target || []) {
      if ((b.tool === "pwsh" || b.tool === "bash") && b.args) {
        try {
          const cmd = (b.args.match(/\"command\":\s*\"([^\"]*)\"/) || [])[1] || b.args;
          const fp = labelFingerprint(cmd);
          if (fp) {
            state.labelRows = upsertLabel(state.labelRows || [], labelEntry(fp, "incorrect", card.sessionId || ""));
            fingerprintNote = `；命令指纹已记录：${fp.slice(0, 80)}`;
          }
        } catch {
          // 指纹解析失败不阻断打标
        }
      }
    }
  }
  if (fingerprintNote) {
    saveLabelsToDisk(labelsFilePath(dshHome()), state.labelRows || []);
  }
  // 审计留档（correct/incorrect 均记录，供 /guard log 对质）
  audit({
    kind: "turn-card-verdict",
    rule: "__turn-card",
    name: "回合末卡片判例登记",
    event: "remote",
    reason: `${card.key}${isLegacy ? "" : `#${idx}`} = ${label}（messageId=${messageId}${fingerprintNote}）`,
    session: card.sessionId || ""
  });
  if (isLegacy) {
    card.label = label;
  } else {
    block.label = label;
  }
  card.verdictAt = Date.now();
  // 2026-09-02：判例登记即落盘（判例=教学数据，重启不丢）
  saveTurnCardsToDisk(state);
  return {
    ok: true,
    verdict: label,
    messageId,
    blockIndex: isLegacy ? -1 : idx,
    fingerprintNote
  };
}

export { RuleEngineService, RuleEngineService as default };
