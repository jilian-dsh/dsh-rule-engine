// silent-error.js - 命令输出“静默错误”检测（P2）
// 纯函数，可独立测试。
const SUSPICIOUS_LINE_RE = /^(false|0|null|undefined|)$/i;

/** 从工具结果中提取纯文本输出（兼容 tool/result 的 message.content[0].content 结构） */
export function extractToolOutput(result) {
  if (!result) return "";
  const msg = result?.message ?? result;
  const content = Array.isArray(msg?.content)
    ? msg.content
    : Array.isArray(result?.content)
      ? result.content
      : null;
  if (!content) return "";
  const block = content.find((b) => b && b.type === "tool-result");
  if (!block) return "";
  const inner = Array.isArray(block.content) ? block.content : [];
  return inner
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

/**
 * 检测可疑静默错误。
 * @param {string} output 本次命令输出
 * @param {string} previousOutput 上一条命令输出
 * @returns {{suspicious: boolean, reason?: string}}
 */
export function detectSilentError(output, previousOutput = "") {
  const text = String(output || "").trim();
  if (!text) return { suspicious: false, reason: undefined };

  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length <= 3 && lines.every((l) => SUSPICIOUS_LINE_RE.test(l))) {
    return { suspicious: true, reason: "命令输出全为 false/0/null/undefined 等可疑值" };
  }

  if (previousOutput && text === String(previousOutput).trim()) {
    return { suspicious: true, reason: "命令输出与上一条完全一致，疑似静默错误" };
  }

  return { suspicious: false, reason: undefined };
}
