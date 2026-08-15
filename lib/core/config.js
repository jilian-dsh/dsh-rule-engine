// config.js - 插件配置加载。
// 配置缺失时使用默认值；损坏时也回退默认并记录错误，避免裸奔。
import { readFileSync } from "node:fs";
import { configFilePath } from "./paths.js";

export const DEFAULT_CONFIG = {
  enabled: true,
  correctInject: true,
  selfProtect: true,
  injectLimitPerRulePerSession: 3
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
