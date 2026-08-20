// service.js —— 规则引擎 host 端 Remote 服务
// 供设置面板（dsh-rules-manager-client 的“规则引擎”页签）通过 ctx.remote.ruleEngine.* 调用。
// 与 rules-manager/service.js 同构：TypertRemoteService + 手动 @Remote 标记。
import { readFileSync } from "node:fs";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { state } from "./core/runtime.js";
import { readAuditLog } from "./core/audit.js";
import { loadPluginConfig, savePluginConfig } from "./core/config.js";
import { applyTaskContractConfig } from "./core/state.js";
import { agentsFilePath, auditFilePath } from "./core/paths.js";

const REMOTE_METHODS = [
  "getStatus",
  "getVersion",
  "checkUpdate",
  "getAuditLog",
  "getUnderstanding",
  "getTaskContractConfig",
  "setTaskContractConfig"
];

function currentVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
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
    for (const name of REMOTE_METHODS) {
      Remote(null, {
        kind: "method",
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
      const headers = { "User-Agent": "dsh-rule-engine", Accept: "application/vnd.github+json" };
      // P2-8：网络异常/慢速时避免面板挂起
      const releaseRes = await fetch("https://api.github.com/repos/jilian-dsh/dsh-rule-engine/releases/latest", { headers, signal: AbortSignal.timeout(8000) });
      if (!releaseRes.ok) {
        return { ok: false, error: `GitHub Release 检查失败：HTTP ${releaseRes.status}` };
      }
      const release = await releaseRes.json();
      const latestTag = String(release.tag_name || "").replace(/^v/i, "");
      const hasUpdate = isNewerVersion(current, latestTag);

      let impacts = [];
      try {
        const impactRes = await fetch("https://raw.githubusercontent.com/jilian-dsh/dsh-rule-engine/main/upgrade-impact.json", { headers: { "User-Agent": "dsh-rule-engine" }, signal: AbortSignal.timeout(8000) });
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
          taskContractDefaults: conf.taskContractDefaults || {}
        }
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 保存任务契约配置（设置页；写入 rule-engine.json 并热同步 state） */
  async setTaskContractConfig(partial) {
    try {
      const conf = savePluginConfig(partial || {});
      applyTaskContractConfig(state, conf);
      return {
        ok: true,
        config: {
          taskContractEnabled: conf.taskContractEnabled === true,
          askEnabled: conf.askEnabled === true,
          taskContractMode: conf.taskContractMode === "armed" ? "armed" : "observe",
          taskContractDefaults: conf.taskContractDefaults || {}
        }
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

export { RuleEngineService, RuleEngineService as default };
