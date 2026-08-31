// config.js - 插件配置加载。
// 配置缺失时使用默认值；损坏时也回退默认并记录错误，避免裸奔。
import { readFileSync, writeFileSync } from "node:fs";
import { configFilePath } from "./paths.js";

export const DEFAULT_CONFIG = {
  enabled: true,
  correctInject: true,
  selfProtect: true,
  injectLimitPerRulePerSession: 3,
  taskContractEnabled: false,
  askEnabled: false,
  taskContractMode: "observe",
  taskContractDefaults: {
    agentBudget: 0,
    hashPolicy: "deny",
    dependencyPolicy: "ask",
    allowedPaths: null
  },
  llmIntent: {
    enabled: true,
    dailyLimitPerSession: 50,
    thresholdHigh: 0.8,
    thresholdLow: 0.5,
    cacheSize: 500
  },
  // T3 通用化（2026-08-31）：声明式 handler 绑定覆盖表 { ruleId: handlerName }
  // 可选键，缺省 {}——不写即走默认偏好表（HANDLER_BY_RULE），行为零变化；
  // 通用化通道：陌生用户可在规则正文声明 <!-- handler: xxx --> 或在此配置集中覆盖。
  handlerOverrides: {},
  // 残余1 剥离（2026-08-31）：本机默认偏好表下沉配置——{ ruleId: handlerName }
  // 通用发布=空（代码零本机编号）；本机在此写入 17 条偏好，引擎升级不丢。
  handlerDefaultMap: {}
};

export function loadPluginConfig() {
  try {
    const raw = readFileSync(configFilePath(), "utf8");
    const data = JSON.parse(raw);
    return {
      ok: true,
      error: null,
      ...DEFAULT_CONFIG,
      ...(data && typeof data === "object" ? data : {})
    };
  } catch (error) {
    return {
      ok: false,
      error: `配置读取失败，已用默认配置：${error instanceof Error ? error.message : String(error)}`,
      ...DEFAULT_CONFIG
    };
  }
}

/** 合并并保存插件配置（设置页调用；UTF-8 无 BOM） */
export function savePluginConfig(partial) {
  const current = loadPluginConfig();
  const next = {
    ...current,
    ...(partial || {}),
    taskContractDefaults: {
      ...DEFAULT_CONFIG.taskContractDefaults,
      ...((current.taskContractDefaults || {})),
      ...((partial?.taskContractDefaults) || {})
    }
  };
  // 规范化
  next.taskContractEnabled = next.taskContractEnabled === true;
  next.askEnabled = next.askEnabled === true;
  next.taskContractMode = next.taskContractMode === "armed" ? "armed" : "observe";
  writeFileSync(configFilePath(), JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}
