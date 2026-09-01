// sync-manual.test.mjs — 手册批量同步 staging（2026-08-31 沉淀落盘）
// 读 SKILL.md → 应用全部变更（104 换行修复 + 105-107 + 协作约定 9/10 + 升级规划 + v4.113）→ 输出完整新稿
// 输出后由统一入口 rewrite --confirmed 写入（用户已授权"继续写手册"）
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SRC = join(homedir(), ".dsh", "skills", "example-usage-manual", "SKILL.md");
const OUT = join(process.cwd(), "logs", ".analysis-tmp", "manual-new.md");

let text = readFileSync(SRC, "utf8");
let applied = 0;

function replaceOnce(oldStr, newStr, label) {
  const n = text.split(oldStr).length - 1;
  if (n !== 1) throw new Error(`${label}: 匹配 ${n} 次（期望 1）——锚点不唯一，中止`);
  text = text.replace(oldStr, newStr);
  applied++;
  console.log(`OK ${label} (${oldStr.length}→${newStr.length})`);
}

// ── 1. 104 换行修复（字面 \n → 真实换行）──
const BROKEN = '）。`n104. **分点级判定缺陷与柱子修复（2026-08-31）**：三点消息（1问/2执行/3条件句）被回合级聚合裁决——3号"推送完成后"被当动作并入 git 授权池、1号问句被误执行。根因=聚合授权池/scope 无对象/条件句无识别。修复=三柱：A分点隔离（clauseId）B显式命名对象锚定 C条件句类型（conditional，零授权）；测试 clause-point-regression 锁定；边界=仅显式命名对象锚定。';
const FIXED = '）。\n104. **分点级判定缺陷与柱子修复（2026-08-31，用户三点消息实证）**：① 现象——用户一条消息三点（1 问句 / 2 执行 / 3 条件句"推送完成后发地址"），引擎把 3 号"推送"并入 git 授权池 → 1 号问句的"push 吗"被（错误）执行；② 根因——裁决信号=回合级聚合（授权池=全部 execute 分点并集）、scope 无对象锚定、条件句/状语无识别（"完成后"被词面当动作词）；③ 修复（三柱）——A 分点隔离（授权带 clauseId；问句/条件分点零贡献）、B 显式命名对象锚定（extractActionObjects+authMatches 命令文本命中）、C 条件句类型（CONDITIONAL_RE→conditional，零授权）；④ 测试锁定 test/clause-point-regression.test.mjs；⑤ 边界如实：对象锚定仅覆盖显式命名实体形态 token；"skill 仓库"类概念词不锚定。';
replaceOnce(BROKEN, FIXED, "104-换行修复");

// ── 2. 105 ──
replaceOnce(
  '104. **分点级判定缺陷与柱子修复（2026-08-31，用户三点消息实证）**：① 现象——用户一条消息三点（1 问句 / 2 执行 / 3 条件句"推送完成后发地址"），引擎把 3 号"推送"并入 git 授权池 → 1 号问句的"push 吗"被（错误）执行；② 根因——裁决信号=回合级聚合（授权池=全部 execute 分点并集）、scope 无对象锚定、条件句/状语无识别（"完成后"被词面当动作词）；③ 修复（三柱）——A 分点隔离（授权带 clauseId；问句/条件分点零贡献）、B 显式命名对象锚定（extractActionObjects+authMatches 命令文本命中）、C 条件句类型（CONDITIONAL_RE→conditional，零授权）；④ 测试锁定 test/clause-point-regression.test.mjs；⑤ 边界如实：对象锚定仅覆盖显式命名实体形态 token；"skill 仓库"类概念词不锚定。',
  FIXED + '\n105. **12B 禁用后词表残留（2026-08-31）**：12B 已禁用占位——但 TYPE_HINTS 的 skill 词独立于规则状态：文本含"skill"→授权类型推导为 skill→范围不匹配→拦（VCI2RX 实证）。禁用=规则不参与，但"为规则服务的词表"未联动退场。候选修法（待批）：skill 词收紧 / 词表随规则状态联动。',
  "105"
);

// ── 3. 106 ──
replaceOnce(
  '\n105. **12B 禁用后词表残留（2026-08-31）**：12B 已禁用占位——但 TYPE_HINTS 的 skill 词独立于规则状态：文本含"skill"→授权类型推导为 skill→范围不匹配→拦（VCI2RX 实证）。禁用=规则不参与，但"为规则服务的词表"未联动退场。候选修法（待批）：skill 词收紧 / 词表随规则状态联动。',
  '\n105. **12B 禁用后词表残留（2026-08-31）**：12B 已禁用占位——但 TYPE_HINTS 的 skill 词独立于规则状态：文本含"skill"→授权类型推导为 skill→范围不匹配→拦（VCI2RX 实证）。禁用=规则不参与，但"为规则服务的词表"未联动退场。候选修法（待批）：skill 词收紧 / 词表随规则状态联动。\n106. **工具选型（2026-08-31）**：只读查证应用 read/grep/glob（任何回合放行）；pwsh 只读命令在问句回合按规则 22 拦——用 pwsh 做只读=自我收窄放行面（ERR-QE16SI 实证）；临时调研脚本建议 *.test.mjs 命名（命中验证通道）；write 有临时区豁免而 edit 无（机制缺口，候选修法：edit 对齐 write）。',
  "106"
);

// ── 4. 107（接 105 尾→106 尾）──
replaceOnce(
  '\n106. **工具选型（2026-08-31）**：只读查证应用 read/grep/glob（任何回合放行）；pwsh 只读命令在问句回合按规则 22 拦——用 pwsh 做只读=自我收窄放行面（ERR-QE16SI 实证）；临时调研脚本建议 *.test.mjs 命名（命中验证通道）；write 有临时区豁免而 edit 无（机制缺口，候选修法：edit 对齐 write）。',
  '\n106. **工具选型（2026-08-31）**：只读查证应用 read/grep/glob（任何回合放行）；pwsh 只读命令在问句回合按规则 22 拦——用 pwsh 做只读=自我收窄放行面（ERR-QE16SI 实证）；临时调研脚本建议 *.test.mjs 命名（命中验证通道）；write 有临时区豁免而 edit 无（机制缺口，候选修法：edit 对齐 write）。\n107. **词表+LLM 兜底循环史（2026-08-31 用户定论）**：v4.39-102 批次=每批"盲区→补词"；L449 自认"人工枚举永远补不完"——词表+LLM 兜底=循环死路；正解=词表只做候选/可配置（用户可增补+文档教"怎么建词表"），语言理解主位交给模型——状态：方向已定，方案第 1-3 步待实施。',
  "107"
);

// ── 5. 协作约定 9/10（锚点=第 8 条尾）──
replaceOnce(
  '**执行类**（发布/注入/卸载/install/commit/push/Remove-Item 等）仍按授权语义严格版独立授权。',
  '**执行类**（发布/注入/卸载/install/commit/push/Remove-Item 等）仍按授权语义严格版独立授权。\n9. **修改双轨制（2026-08-31 用户定稿）**：任何修改先贴【通用】/【本机】标签——通用（机制/平台语义/公开接口）→ 代码 lib/ + 对外文档；本机（规则集/偏好/专属词/记录）→ 配置 ~/.dsh（不入包）+ 本机手册（不入包）+ 本机回归测试；铁律=代码层零本机内容（发布门禁扫描红）；本机能力走配置层；通用≠不做本机问题；机器校验（dualtrack-check）为验收兜底（用户不需要肉眼判断分类）。\n10. **目标 vs 清单（2026-08-31 定稿）**：验收以用户口头目标为准（不是任务清单完成——测试绿≠达标）；"通用/对外"结论须过陌生人视角（无本机格式/语言/规则体系的人会怎样）；被指出问题→只答/讲边界，不得越权补救；解释不得归因用户情绪（踩坑 47）。',
  "协作约定-9/10"
);

// ── 6. 升级规划缺口（锚点=规划节行尾）──
replaceOnce(
  '详见第 8 章踩坑 81-84 与版本 v4.44）',
  '详见第 8 章踩坑 81-84 与版本 v4.44）。**2026-08-31 后通用化缺口 v2**（用户三条定稿）：①理解器不拆四要素（只认正则格式——应任意格式→四要素）②等级不从动作推导（没写"（执行等级：X）"=静默纯自证——应从动作推导）③词表内置不可配+缺"怎么建词表"文档（应可配置+教学）；方向已定，方案第 1-3 步待实施（详见 v4.113）。',
  "升级规划-缺口"
);

// ── 7. v4.113 版本记录（锚点=v4.112 行尾）──
replaceOnce(
  '手册第 1 章新增协作约定第 8 条（验证与调研通道）** |',
  '手册第 1 章新增协作约定第 8 条（验证与调研通道）** |\n| v4.113 | 2026-08-31 | **通用性讨论定稿沉淀（本会话教训全记录，底档 reports/2026-08-31-rule-engine-session-lessons.md）**：修改双轨制（通用/本机标签+分装铁律+机器校验，用户定稿）+ 目标 vs 清单（验收=用户目标非清单完成）+ 分点级判定缺陷与柱子修复（A/B/C，测试锁定）+ 12B 禁用词表残留（禁用≠机制退场）+ 工具选型（只读=read/grep/glob；pwsh 只留执行）+ 词表+LLM 兜底循环史结论（正解=词表可配置+模型主位，待实施）+ 越权错误链 6 例与归因（归因全在自身）；新踩坑 104/105/106/107；协作约定第 9/10 条 |',
  "v4.113"
);

writeFileSync(OUT, text, "utf8");
console.log(`\nSTAGING 完成：${applied} 处应用，输出 ${OUT}`);
