// matcher.js - 情境匹配机。
// 每轮只激活相关规则子集，供 /guard active 展示，也用于控制执行成本。
import {
  activateApprovalRe,
  activateBackupRe,
  activateNetworkRe,
  activatePromiseRe,
  activateSkillRe,
  activateSourceRe,
  activateTimeRe,
  dshKeywordsRe
} from "./patterns.js";
import { kindOf } from "./measure-kinds.js";

export function activateForUserMessage(configs, userText) {
  const text = userText || "";
  return configs.filter((cfg) => {
    const kind = kindOf(cfg.handler);
    if (kind === "manual-first" && dshKeywordsRe().test(text)) return true;
    if (kind === "skill-auth" && activateSkillRe().test(text)) return true;
    if (kind === "approval" && activateApprovalRe().test(text)) return true;
    if (kind === "network" && activateNetworkRe().test(text)) return true;
    if (kind === "backup" && activateBackupRe().test(text)) return true;
    if (kind === "time" && activateTimeRe().test(text)) return true;
    if (kind === "promise" && activatePromiseRe().test(text)) return true;
    if (kind === "source" && activateSourceRe().test(text)) return true;
    if (kind === "language" && CJK_PRESENT.test(text)) return true;
    return false;
  });
}

const CJK_PRESENT = /[\u4e00-\u9fff]/;

export function activateForToolCall(configs, toolName, args) {
  const name = String(toolName || "");
  const argText = JSON.stringify(args || {});
  return configs.filter((cfg) => {
    const kind = kindOf(cfg.handler);
    if (kind === "inline-command" && (name === "pwsh" || name === "bash")) return true;
    if (kind === "retry") return true;
    if (kind === "manual-first") return true;
    if (kind === "backup" && (name === "pwsh" || name === "bash" || name === "edit" || name === "write")) return true;
    if (kind === "skill-auth" && name === "skill") return true;
    if (kind === "approval" || kind === "sensitive") {
      if (name === "pwsh" || name === "bash" || name === "edit" || name === "write" || name === "ask_user_question") return true;
    }
    if (kind === "meta" && (name === "edit" || name === "write")) return true;
    if (argText) {
      const low = argText.toLowerCase();
      if (cfg.triggerKeywords.some((k) => low.includes(k.toLowerCase()))) return true;
    }
    return false;
  });
}

export function activateForAssistant(configs, text) {
  return configs.filter((cfg) => {
    const actions = cfg.actions || [];
    if (actions.includes("correct") || actions.includes("self-certify")) return true;
    return false;
  });
}
