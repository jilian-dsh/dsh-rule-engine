// runtime.js - 规则引擎运行时单例状态。
// index.js（守卫/事件）与 service.js（设置面板/远程服务）共享同一份 state。
import { createState } from "./state.js";

export const state = createState();
