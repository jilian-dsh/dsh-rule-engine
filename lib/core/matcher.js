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

export function activateForUserMessage(configs, userText) {
  const text = userText || "";
  return configs.filter((cfg) => {
    if (cfg.handler === "rule18-manual-first" && dshKeywordsRe().test(text)) return true;
    if (cfg.handler === "rule12b-skill" && activateSkillRe().test(text)) return true;
    if (cfg.handler === "rule12a-approval" && activateApprovalRe().test(text)) return true;
    if (cfg.handler === "rule12c-network" && activateNetworkRe().test(text)) return true;
    if (cfg.handler === "rule13a-backup" && activateBackupRe().test(text)) return true;
    if (cfg.handler === "rule2-time" && activateTimeRe().test(text)) return true;
    if (cfg.handler === "rule7-promise" && activatePromiseRe().test(text)) return true;
    if (cfg.handler === "rule5-source" && activateSourceRe().test(text)) return true;
    if (cfg.handler === "rule11-language" && CJK_PRESENT.test(text)) return true;
    return false;
  });
}

const CJK_PRESENT = /[\u4e00-\u9fff]/;

export function activateForToolCall(configs, toolName, args) {
  const name = String(toolName || "");
  const argText = JSON.stringify(args || {});
  return configs.filter((cfg) => {
    if (cfg.handler === "rule9-inline-bom" && (name === "pwsh" || name === "bash")) return true;
    if (cfg.handler === "rule1-retry") return true;
    if (cfg.handler === "rule18-manual-first") return true;
    if (cfg.handler === "rule13a-backup" && (name === "pwsh" || name === "bash" || name === "edit" || name === "write")) return true;
    if (cfg.handler === "rule12b-skill" && name === "skill") return true;
    if (cfg.handler === "rule12a-approval" || cfg.handler === "rule12d-sensitive") {
      if (name === "pwsh" || name === "bash" || name === "edit" || name === "write" || name === "ask_user_question") return true;
    }
    if (cfg.handler === "rule21-meta" && (name === "edit" || name === "write")) return true;
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
