// whitelist.js - 工具白名单持久化 v2（0.5.9）：纯函数，可独立测试。
// 存储格式：v2 = [{"name","time","session"}]（带元数据，可视化"谁/何时/哪个会话放行"）；
// v1 = ["name"]（字符串数组，兼容读取）。v1 升级=v2 时旧条目 time/session 为 null（"未知"）。
export function parseWhitelist(raw) {
  try {
    const arr = JSON.parse(raw || "[]");
    if (!Array.isArray(arr)) return [];
    return arr
      .map((it) => {
        if (typeof it === "string") return { name: it, time: null, session: null };
        if (it && typeof it.name === "string") {
          return {
            name: it.name,
            time: typeof it.time === "number" ? it.time : null,
            session: typeof it.session === "string" ? it.session : null
          };
        }
        return null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** 合并既有元数据与新增名称（新增带当前时间和会话来源），保持既有条目历史不变 */
export function mergeWhitelist(prevRows, names, sid, now = Date.now()) {
  const map = new Map(prevRows.map((r) => [r.name, r]));
  return names.map((n) => map.get(n) || { name: n, time: now, session: sid || null });
}

export function serializeWhitelist(rows) {
  return JSON.stringify(rows);
}
