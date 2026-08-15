// matcher.js - 情境匹配机。
// 每轮只激活相关规则子集，供 /guard active 展示，也用于控制执行成本。
import { DSH_KEYWORDS_RE } from "./patterns.js";

export function activateForUserMessage(configs, userText) {
  const text = userText || "";
  return configs.filter((cfg) => {
    if (cfg.handler === "rule18-manual-first" && DSH_KEYWORDS_RE.test(text)) return true;
    if (cfg.handler === "rule12b-skill" && /技能|skill/i.test(text)) return true;
    if (cfg.handler === "rule12a-approval" && /执行|创建|删除|覆盖|移动|下载|提交|配置/i.test(text)) return true;
    if (cfg.handler === "rule12c-network" && /下载|网络|curl|境外|clash/i.test(text)) return true;
    if (cfg.handler === "rule13a-backup" && /删除|覆盖|迁移|备份/i.test(text)) return true;
    if (cfg.handler === "rule2-time" && /时间|今天|昨天|日期/i.test(text)) return true;
    if (cfg.handler === "rule7-promise" && /保证|肯定|承诺/i.test(text)) return true;
    if (cfg.handler === "rule5-source" && /引用|来源|URL|链接/i.test(text)) return true;
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
