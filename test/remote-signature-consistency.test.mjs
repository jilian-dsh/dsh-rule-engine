// remote-signature-consistency.test.mjs - client/host Remote 签名一致性（2026-09-02）
// 背景：rateTurnCard 加 blockIndex 时 client TYPERT_REMOTE 描述符与 host 方法签名
// 漏改一处 → "expected 3 argument(s), got 4" / [object Object]。
// 本测试锁定：client 描述符参数数 == host 方法签名参数数（改任一端漏同步 → 直接红）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientJs = readFileSync(join(__dirname, "..", "..", "dsh-rule-engine-client", "client.js"), "utf8");
const serviceJs = readFileSync(join(__dirname, "..", "lib", "service.js"), "utf8");

/** 从 client.js 提取某 Remote 方法的参数名列表（TYPERT_REMOTE 描述符） */
function clientParams(method) {
  // 定位 method: "xxx" 之后的 parameters 块
  const mIndex = clientJs.indexOf(`method: "${method}"`);
  assert.ok(mIndex >= 0, `client.js 未找到 method: "${method}"`);
  const paramsStart = clientJs.indexOf("parameters: [", mIndex);
  assert.ok(paramsStart >= 0, `client.js ${method} 未找到 parameters`);
  const paramsEnd = clientJs.indexOf("]", paramsStart);
  const block = clientJs.slice(paramsStart, paramsEnd);
  const names = [...block.matchAll(/\{\s*name:\s*"([^"]+)"/g)].map((x) => x[1]);
  return names;
}

/** 从 service.js 提取 host 方法签名参数名列表 */
function hostParams(method) {
  const re = new RegExp(`async\\s+${method}\\s*\\(([^)]*)\\)`);
  const m = serviceJs.match(re);
  assert.ok(m, `service.js 未找到 async ${method}(`);
  return m[1].split(",").map((s) => s.trim()).filter(Boolean).map((s) => s.split("=")[0].trim());
}

for (const method of ["getTurnCard", "rateTurnCard"]) {
  const client = clientParams(method);
  const host = hostParams(method);
  console.log(`[${method}] client=${client.join(",")} | host=${host.join(",")}`);
  assert.deepEqual(client, host, `【${method}】client 描述符参数（${client.join(",")}）≠ host 签名参数（${host.join(",")}）——改任一端必须同步两端！`);
}

console.log("remote-signature-consistency.test.mjs PASS");
