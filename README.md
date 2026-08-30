# dsh-rule-engine

![npm](https://img.shields.io/npm/v/dsh-rule-engine)
![version](https://img.shields.io/badge/version-0.5.12-blue)

DSH 规则执行引擎 v3 的插件实现。它把 `~/.dsh/AGENTS.md` 当作唯一真相源，自动解析规则四要素与执行等级，再通过「工具守卫 + 文本检测 + 时序检查 + 审计台账」执行用户规则，而不是内置一套与用户无关的安全清单。

> 当前版本 **0.5.11**（2026-08-29 已发布三通道：npm=0.5.11 / git 1de7eaf / Release v0.5.11（tgz）；上一版 0.5.10 = git 23a3c0f）。本次发布含 0.5.10 git 提交欠账 7 文件补齐。本插件面向"规则机器化执行"：规则写在 AGENTS.md 里，引擎负责让它们真的被遵守；所有规则动态解析，规则增删改后无需重写插件。

## 项目背景

这个项目来自一个非常具体的个人需求：

- 作者是**零编程基础**用户，但极其重视规则的制定、执行、遵守与复盘。
- 作者发现：规则如果只写在文本里、靠模型“自觉”执行，会反复失效（例如时间词写错、内联命令违规、交付前漏验证等）。
- 因此核心思路是：**规则的执行不能只靠自觉，要尽量靠插件在机制层强制**。
- 本插件所有规则均从 `AGENTS.md` 动态解析，规则增删改后无需重写插件。

当前实现基于已有的 `AGENTS.md` 规则体系拓展，社区暂无类似插件供参考（大概率为该等约束可能限制开发自由性，不适用于专业编程人员），**可能存在大量不完备、误判或边界问题**。欢迎任何使用者提出调整建议、提交 issue 或 PR。项目仍处于“可运行但需要持续打磨”的阶段。

## 功能分层

- 阶段 1 容器：解析 AGENTS.md 全部规则 → 理解产物（`rule-understanding.json` 可生成）
- 阶段 2 匹配机 + 工具守卫 + 文本检测
- 阶段 3 时序检查 + 授权询问集成
- 阶段 4 D 级自证调度 + `/guard` 命令完善

当前实现以「模式库兜底」为主，LLM 理解器预留扩展点；所有规则均从 AGENTS.md 实时解析。

## 注入噪音治理（0.5.6 / 0.5.7）

只提醒真正值得提醒的事——这条原则贯穿 0.5.6 与 0.5.7：

- **0.5.6**：同一回复中多条违规 → 聚合为一条注入（明细全在 `/guard log`）；回复含「规则 X 已自证/已核对…」标记 → 该规则当轮不再重复触发；C2 规则统计（detected/suppressed/injected，`getRuleStats` 面板接口）。
- **0.5.7（错误才值得被提醒）**：
  1. **词表只产嫌疑**：语义型命中不再直接定罪，标记 `awaitingJudge` 送裁决；
  2. **LLM 裁决**：给「规则正文 + 完整回复」判定是否真违规——合规声明/引述/非违规 → 不投递（`judge-false`）；仅裁决为违规才投递（`judge-pass`）；裁决不可用 → 不投递（**fail-closed**，`judge-unavailable`）。模型**追随会话模型**，`sha256` 缓存 + 每日 50 次/会话预算；
  3. **注入轮不检测**：没有真实用户消息的回合（引擎注入触发的轮次）不做检测与投递——这是"引擎自己打乒乓"循环的根治（燃料=它对自身回声的检测）；
  4. **投递资格闸**：同规则同会话仅提醒一次（记住已处理）；会话每小时至多 3 条弹窗；
  5. **审计完整性**：嫌疑/裁决/拦截/投递全部写入 `/guard log`——"看了不冤枉"的凭据。

## 质量与验证（2026-08-26，对齐官方 docs/testing.zh.md）

- `npm run test`（全量单测；`test/run-all.mjs` 统一入口，注意 ESM 缓存顺序约定）；
- `node scripts/verify-all.mjs` —— 交付前**七层**体检：语法（lib 全文件 `node --check`）→ 单元（run-all）→ **组合冒烟**（`test/loader-smoke.e2e.mjs`：真实引擎代码 + 真实审计文件，仅 mock LLM 边界，断言**外部世界**——审计文件里真的出现 judge-false/judge-pass 记录，而非自我报告）→ **工具箱覆盖**（`scripts/check-tool-coverage.mjs`：官方 tool-catalog 全集 vs 分类表，出现 unknown 即红）→ **变更工具守卫链覆盖**（`test/guardchain-coverage.test.mjs`：写/删/移工具问句回合不静默逃逸，规则 24④ 机器执行）→ **关联一致性**（测试全部收录 run-all / 版本成对 / 核心能力有落点——0.5.11 新增，防改完不看关联产物）→ **真实判例**（近 24h 台账 judge-pass/false 记录数，0 条 = WARN 提示需实弹）；
- `node scripts/health-audit.mjs` —— 找茬清单：近 24h 失败/降级类统计（intent-llm 失败、judge-unavailable、verify-gap、inject-skip…）+ 关键导出接线交叉（疑似未接线 = 告警）——"失败可见化"，不再有静默躺 20 小时的降级；
- 执行协议（本仓库自身交付纪律）：方案冻结单（范围/影响面/测试计划/失败预测）→ todo 化 → 小步闭环（每改动立即 `node --check`）→ 对账交付（计划×实际逐项 ✅/❌/跳过原因）。**验收五查（0.5.11 用户定稿：验收 = 改动关联产物全做一遍，不是只跑测试）**：① 本次改动的**全部**测试/用例在 run-all 或对应门禁中收录；② README/手册/版本记录与引擎语义成对（新增行为必写文档）；③ 调用点 grep：改公共函数签名/导出 → 全部调用点逐一核对；④ 相关测试断言同步（本例：consistency 死映射 17→16）；⑤ 误删/错改产物清理（错误版测试/脚本删除后无残留引用）。**⑥ 实弹验证（0.5.11 用户定稿）**：改动在运行态真实生效 = 重启 DSH 加载（profile 为 link: 时重启即生效）→ 运行态验证（行为/守卫/日志实拍）→ 通过后**才**允许进入发布——**发布必须以"重启生效+验证通过"为前提，未生效验证不得发布**（顺序：改 → 测试 → 重启生效 → 实弹验证 → 发布）。任一未做 = 交付不算完成。**⑦ 发布前置（2026-08-28 用户定稿）**：发布前必须先本地跑测试——本项目测试（test-service/npm test）+ 验证脚本 + 运行态实测（截图/输出证据），未全过不得发布；发布后核对三处成对——README 徽章=package.json 版本（release 脚本自动 bump，需验证）、三通道（npm/git/Release）逐个确认成功（含 Release 带正式 tgz asset）；发布后遗留（徽章/README 成对缺口）必须当场修。**发布流程三阶段（2026-08-29 用户定稿）**：阶段 A **内容验证（发布前，只读/本地）**——A1 测试全过（run-all+verify-all+loader+运行态实测）、A2 dry-run 推导正确（`release-plugin.mjs <pkg> --dry-run`：oldVer→nextVer+徽章变化）、A3 版本三处一致（徽章=package.json=发布目标号）、A4 Asset/tag 预检（tgz 已 pack；目标 tag 预检不存在——防 ㉙ 同 tag 占位）；阶段 A0 **授权**——展示改动清单+版本号 → ask_user_question 明确授权（规则 26⑤：先授权→运行脚本）；阶段 B **一键三通道**——`release-plugin.mjs`（publish→push→Release 带 tgz）；阶段 C **事后核对**——三通道确认（npm view/git tag/gh api asset）+ 徽章/README 成对复核 + 本机 link 不重装 + 沉淀（版本记录/engram）。**顺序铁律：A→A0→B→C，验证在发布前（A），不是发布后补（C）——发布内容经确认无误才允许三通道。**

> **版本状态说明（2026-08-29 更新）**：下方 0.5.11-0.5.14 章节为**发布前的工作区迭代记录**——对外统一发布为 **0.5.11**（2026-08-29 三通道：npm=0.5.11 / git 1de7eaf / Release v0.5.11 带 tgz）。0.5.11→0.5.14 是工作区内部迭代号，发布时统一以对外号为准；发布同时补齐 0.5.10 git 提交欠账 7 文件（baseline/intent/judge/llm-intent/semantic/tool-catalog/whitelist.js——npm 包本已包含，git 通道缺失）。

## 0.5.14（2026-08-28 追加，阶段三收尾：D1-D3 注入 / F1-F2 时序收紧 / 回归集第 8 层）

> 背景：阶段二之后剩余全部任务（用户"请按顺序执行剩下的任务"）——注入语义、时序竞态、交付闸门收紧，+真实场景回归常驻化。

- **D1 注入文案去命令化 + 静态检查**（index.js）：`[规则引擎]` 注入若含"请直接执行/请立即/不要再"类命令式短语会驱动模型越过用户直接行动（实弹：节流注入后模型跳过用户回复执行）；修法 = maybeInject 入口命令词守卫（INJECT_COMMAND_RE 命中即拒绝投递+审计 `inject-command-gated`），历史文案全量改写陈述式（__ask-rejected/__ask-throttle/__engram-gap 三处漏网被守卫抓出修复）；
- **D2 注入投递降噪**（index.js）：不可投递 agent（子代理/已销毁）审计 reason 标注"（D2 预期降噪）"，与真实失败区分；
- **D3 注入授权断言真值驱动**（2026-08-29 测试锁定，B2）：注入不再断言"已有授权"（描述权交给裁决器 describeAuth 真实池）；锁定 = guard.test.mjs「D3 真值驱动锁定」段（有授权 → 文案含真实池描述 write｜路径 d:/allowed；无授权 → 显式"无"）；
- **F1 规则 2 时序竞态**（text-detect.js/index.js）：assistant/message 检出时间词违规不再立即投递——Get-Date 工具常在本回合后续步骤才执行（实弹：correct 早于 Get-Date 放行）；改为 turn/end 复核（getDateSeen 定案 → 已调用即撤销不投递，审计 `rule2-resolved`）；detectViolations 保留判定、新增 detectTimeRule 独立函数；
- **F2 verify-gap 词面收紧**（index.js）：`/完成/` 裸词太宽（"完成社区检索/尚未完成"误触）→ 强完成声明模式 + 否定/进行态排除（LLM 裁决层兜底不变）；
- **回归集第 8 层**：`test/realcase-regression.test.mjs`——真实场景常驻（顿号路径+doc 读取 COM / ask 未响应≠拒绝 / 子代理委派 / 注入文案命令词静态检查 / 规则 2 时序 / 意图事故原文），收录 run-all；**下次任何改动必过这层**；
- **质保**：verify-all 七层 VERIFY ALL OK + loader-smoke PASS。

## 0.5.11-pre 交接执行（2026-08-29 追加：A1 审计误报 / B2 D3 锁定 / B3 引述转述）

- **A1 审计命令被拦 ≠ 审计失败**（index.js tool/result 分支拆分）：旧逻辑 `isError || auditOutputFailed` 合并两者——审计命令被规则 22 拦截/执行失败（无输出）也记 mount-audit-fail 并注入"先移除多余挂载"（误导：审计根本没执行，曾引导模型误移除正确挂载）；修复 = auditOutputFailed（真 DUPLICATES）→ mount-audit-fail + 注入不变；isError（无审计输出）→ mount-audit-error 留痕、不注入；通过 → revision 同步不变；测试锁定 session-events 场景 A/B/C；
- **B3 引述/转述语境通用豁免**（patterns.js `isQuoteOrParaphraseContext` + text-detect.js）：原规则 7 仅认引号 + 白名单标记词，"用户之前说万无一失"（无引号转述）误报；规则 2 无任何引述豁免（引述"你昨天说…"也报未核对）；修复 = 通用判定（引号包裹 8 字符 / 第三人称对象+说/表示/提到… before 14 字符 / 引述转述原文改成类标记），**第一人称"我说保证/我昨天完成"不豁免**（承诺转述不了自己）；规则 2 两处（detectViolations + detectTimeRule）接入；
- **B1 词表热词学习（方案甲，2026-08-29 用户拍板）**：终结"每次手动补词"（v4.74/82 连补 4 轮仍漏）；机制 = LLM 意图兜底 prompt 新增 `actionWord` 字段，裁决 hasExecute=true 且词表未命中 → 学动作词入 `~/.dsh/rule-engine-hotwords.json`（`lib/core/hotwords.js`：上限 500/原子写/损坏容错/审计 `hotword-learn`）→ 下次 `intent.js` hasAction 直接命中（`ACTION_RE ∪ 热词`）；**热词只服务意图判定，绝不 bypass deny/授权**；手动补词（lexicon.js）保留且优先；测试 `test/hotwords.test.mjs`（容错/去重/拒收/命中/接入）已收录 run-all；
- 质保：run-all ALL TESTS PASSED（含 A1 段 4 断言 + D3 锁定 4 断言 + B3 检测层 4 断言 + hotwords 10 断言）+ 冷加载探针 PASS；**运行态生效 = 重启 DSH 后实弹**（bundle 装配，热重载不生效）；

## 0.5.13（2026-08-28 追加，阶段二：B2/B2 委派豁免 / C2 中文路径 / C3 ask 节流）

> 背景：2026-08-28 事故链三处遗留（用户逐项拍板"先做 B2+C2+C3"）——子代理读文件被 ERR-L8QAXS 拦、
> `D:\1、示例\...` 授权时被劈成 `d:/1`（ERR-LU50QQ）、**未回复 ask 被当"拒绝"节流**（用户"你也没给我时间回复啊"）。

- **B2 委派/子代理回合豁免"无执行分点"**（guard-core `isDelegatedSession`）：官方子代理把任务 prompt 以 `source.kind="user"` 注入子会话（dsh-subagent-in-process-driver L204-207 实证），引擎按用户消息处理 → 任务书被判"无执行分点"→ 读文件被拦；修复 = 规则 22④"委派回合不做判定"的识别层落地（会话 meta.delegationDepth>0 / origin=subagent / parentSession 存在 → 跳过，审计 `delegated-skip` 留痕；**12A/13A 独立把关安全不降级**）；
- **C2 中文顿号路径提取**（authorization.js PATH_TOKEN_RE）：`、`（中文顿号）从"非路径字符"黑名单移除——Windows 中文目录名常见（`D:\1、示例\...`），原正则在此截断 → 授权记录成 `d:/1`，真实操作匹配失败；稳妥边界：顿号后跟空格+新词可能合并（fail-closed 方向：提取过长 → 匹配失败 → 拦而非放，不放大授权）；
- **C3 ask 节流区分"明确拒绝"与"未响应"**：新导出 `askResultRejected`（结果文本含拒绝词才算拒绝）+ REJECTION_WORDS_RE 修正（`否`不再误命中"是否"）；旧逻辑把**任何未批准**记入 askRejections 池 → 5 分钟内再 ask 被 __ask-throttle 拦——用户没回 ≠ 用户拒绝；现在未响应/超时仅审计 `auth-noanswer`，明确拒绝才入池（12A 授权证据把关不降级）；
- **测试**：phase1-fix 扩展 B2/C2/C3 用例（子代理 meta 放行/顿号路径提取+授权闭环/拒绝词 vs 空结果）；makeState 防 mtime 重解析注入全套规则（测试洁净性）；
- **质保**：verify-all 七层 VERIFY ALL OK + loader-smoke PASS。

## 0.5.12（2026-08-28 追加，阶段一：事故驱动修复 / 用户逐项拍板）

> 背景：2026-08-28 real-legal 会话事故——用户"请将建议书内容转化到业务通告"被规则 22 连拦 7 次（无执行分点）；
> 授权后读取仍被拦（ERR-L8QAXS/LU50QQ）；注入提示被节流后模型越过用户回复直接执行。全部根因如下，逐条修复。

- **A1 意图优先级修正**（intent.js）：动作词优先于方案词——"将建议书内容转化到业务通告中"含"建议"（PLAN_RE）却被判 plan → 无执行分点 → 拦；修正：`hasAction` 分支前置（含 `SPECIFIC_ACTION_RE` 区分宽泛动作词——"给出执行方案"仍是方案请求）；词表补 `转化/转换/读取/读(完|出|一下…)/展示/打开/提取/还原/导入/导出`（VERB_RE/TYPE_HINTS 同步）；
- **A2 LLM 意图兜底同步等待**（index.js）：预取异步 vs 守卫同步的竞态——词表未命中时 LLM 兜底结果未到即按词表拦截；修正：turn 记录 `llmIntentPromise`，`tools/pre-execute` 首钩子对 `llm-pending` 回合等待（上限 300ms，超时降级词表）；
- **A3 @文件引用信号**（intent.js）：用户消息含 DSH 官方 @file 引用语法（`@path`/`@"path with spaces"`/`@file.docx`）+ 处理动词 → 判执行分点；邮箱（a@b.com）不误伤（@ 前需非词字符边界）；
- **B1 只读判定补强**（patterns.js）：读取 .doc 的 COM 命令（`$kwps.Documents.Open($dst,0,$true)` / `$doc.Content.Text`）与变量赋值段被"每段必须命中白名单 cmdlet"误判为写 → 只读豁免失效；修正：三档判定（写特征拒 / 白名单+分明无害段过 / 不认识的段保守拒），新增 MUTATING_METHOD_RE（.NET 写方法/SaveAs 等）与 COM_CONTENT_ASSIGN_RE（`$doc.Text=...` 写文档不被豁免）；只读优先于一切失拦链；
- **C1 规则 22 粒度并入会话授权**（guard-core）：12D 已记录的 TTL 授权在下一回合被 22 粒度忽略（"只认本回合 scopes"）——授权分裂；修正：粒度检查并入 `session.authorizations` 中**带 TTL 且未过期**的授权；安全边界：无 expiresAt 的长期授权不放宽本轮（08-24 语义保留）；
- **E1 打标链路修复**（guard-core/index.js/audit.js）：ERR 码随机生成但**不进日志**、/guard label 只认 UUID——打标断链（用户实测无法操作）；修正：makeHit 返回 errId → deny 审计条目落 `errId` 字段 → `/guard log` 显示 `ERR-xxxxxx` → `/guard label ERR-xxxxxx incorrect` 直接定位（新拦截文案引导到 ERR 码，不再让用户找事件号）；
- **测试**：`test/phase1-fix.test.mjs`（事故原文回放：转化消息 execute / COM 只读放行 / 写命令仍拦 / 授权覆盖 / ERR 码链路），收录 run-all；
- **质保**：run-all 全绿 + loader-smoke PASS + 热重载生效 + 运行时实弹（日志 errId 落盘实证）。

## 0.5.11（2026-08-28 追加）

> 0.5.11 = 判定内核第一轮（用户定稿"主从翻转"第一步）：安全洞两处修复 + 12A/22-7 判据同源。
> 行为变化目标：问句回合不再能覆盖已存在文件；执行类脚本不再借"分析"通道放行。

- **新建豁免补"新建"语义**（isLowRiskWorkspaceNew）：豁免原文 = 工作区内低风险**新建**——目标存在即不算新建，edit/write 已存在文件走正常授权（此前问句回合可覆盖既有文件，审计曾见 `edit service.js` 被判"低风险新建豁免"）；相对路径无法判定存在性 → 保守不豁免；
- **分析通道移除脚本区语义豁免**（isAnalysisOp）：删除"repo `scripts/*.mjs` = 分析"分支——脚本名判不了脚本干什么（release-plugin.mjs 等执行脚本曾借道放行）；通道保留物理判据（严格只读/临时区写/下载到临时区），脚本语义判给模型；
- **12A 与 22-7 判据同源**（guard-core rule12a-approval）：12A 分支接入 isAnalysisOp + isLowRiskWorkspaceNew 同一组豁免（此前 22-7 放行、12A 仍要求授权的不一致）；红线不变（工作区外不豁免）；
- **后台判定模型 = 当前会话模型**（resolveRoute）：judge 裁决 / llm-intent 意图兜底 / 规则理解三处统一走 resolveRoute——此前取"模型列表第一个"（=dsf 基础模型，与主会话 dsfve 能力不一致，裁决结果与主会话判断脱节）；改为优先 `agentDefaultModel.currentSelection()`（官方当前模型选择，provider+model）→ 环境变量 → 列表兜底；
- **测试**：patterns 新增存在性 4 断言；analysis-channel 改为新行为（脚本区不放行/执行脚本不放行/临时区写仍放行）；llm-understander 新增 resolveRoute 当前模型优先 2 断言（dsfve 优先、无当前选择回退列表兜底）；
- **质保**：verify-all 七层全绿 + 冷加载探针 PASS。

## 0.5.11 续批（2026-08-28，AGENTS.md 成对，用户逐项拍板）

- **规则 13A 触发/检查行**：触发改为"删除/覆盖/迁移/批量删除**文件**等操作。修改**受保护**配置文件等操作"；硬拦检查同步为"删除/覆盖/迁移/批量删除文件、修改受保护配置文件类操作且无备份 → 拒绝"——引擎当初收窄到受保护配置是有意（普通配置修改海量，全纳入会过度打扰）；正解 = 正文向引擎对齐；
- **规则 22 正文三处**：豁免明细由引擎清单维护；执行许可 = 执行许可词 + 执行语（词表引擎唯一维护，正文不枚举）；自证③括号去重指向时序⑤；
- **词表唯一源（`lib/core/lexicon.js`）**：五表（执行许可/执行动作/疑问/状态信号/豁免工具清单）集中唯一；intent.js/authorization.js 删除各自重复定义改 import——消灭"正文 1 套 + 引擎 9 张"同语义多处定义的漂移根因（用户定稿：可用词表但不能有两套）；
- **rule14 handler 删除**：纯 D 级自证、无执行分支 = 空转映射（consistency 断言 17→16 同步）；
- **规则 19 保持 D 级**：实测升 C 会让 19 整条变 deny（C 级默认给硬动作）——⑧ 统一入口机器执行已由 __self-protect 独立承担（guard-core L241/248）；
- **规则 24 机器执行修正**（用户两次纠偏）：24 目的 = 控制插件和工具装配、避免改坏（v3.37/踩坑 36 背景）——工具面正解 = 原文④"纳入同一套敏感/授权/备份/版本守卫"（跨工具一致性测试），**不是"归类必须 mutating"**（错误版曾枚举 35 工具名断言=mutating、且把 dev_stage_promote/demote 移出 artifact——查分类名不查守卫链，违反手册 v3.39"dev_stage 四件套纳入敏感授权检查、不改分类"）。修正：`test/guardchain-coverage.test.mjs`（33 个写/删/移工具 × 问句回合+无授权真实场景 → guardDecision，断言被拦或属豁免面，静默逃逸=红）；dev_stage 四件套恢复 artifact（授权检查由 12A/13A/24 链上覆盖）；verify-all 第 ⑥ 层接入。

## 0.5.10（2026-08-27 追加）

> 收编：用户审查后的 real-legal 会话建议（建议 2/3/4/5，依据本手册知识条目 K-01~K-06 批判性审查）+ 分析通道（用户多次提出的"只读分析需要写临时脚本/输出"痛点）+ 统一入口加固（2026-08-27 手册损伤事故复盘）。

- **分析通道（单真源 `isAnalysisOp`）**：严格只读 ∪ 分析临时区写（`logs/` `.analysis-tmp/` `.backups/`）→ 任何回合放行 + 审计 `analysis-scratch`；**红线**（红线层在 guard-core）：受保护文件名/工作区外（isOutsideWorkspace）/删除移动/覆盖正式文件一律不豁免；**0.5.11（用户定稿）**：移除"分析脚本区 repo `scripts/*.mjs` 一律=分析"的语义豁免——脚本名判不了脚本干什么，执行类脚本（release/inject/uninject 等）曾借道放行（执行口径漏洞）；脚本语义判给模型，通道只保留物理判据（只读/临时区写/下载到临时区）；
- **写类判定单真源**：self-protect / 22 / 13A 统一走 `isMutationCommand`——修复 `Write-Output` 被 `write` 子串误杀（WGO654/ES3VCD 案例：纯读命令查受保护文件名被误拦）；
- **只读词表补全**：ForEach-Object / Get-ItemProperty / Get-Variable / Get-FileHash（多行"读+筛选+循环"组合判只读）；
- **统一入口加固**（example-manual-write.mjs）：① 转义事故特征检测——表格行内字面 `\n` / `\$`（PowerShell 单引号转义事故模式，2026-08-27 手册坏行事故）→ 拒绝；② 写后结构校验——表格块列宽一致（±2 容忍）+ 手册版本记录行存在，不通过自动回滚；
- **误判打标闭环（建议 4）**：所有硬拦文案尾部附「误判可打标：/guard label <事件号> incorrect」指引；health-audit 新增 deny 总数 vs incorrect/correct 打标占比统计（词表迭代量化依据）；
- **已知坑召回（建议 5）**：工具错误文本命中特征表（SEC_E_NO_CREDENTIALS / ECONNREFUSED:7890 / EPERM 管道 / ERR_MODULE_NOT_FOUND）→ 审计 `error-hint` + 注入指向知识库提示（本轮去重、走投递资格链，不违反注入噪音治理）；
- **质保**：新增强力测试（写类判定/分析通道/临时区红线/转义检测 REFUSED 实测/召回特征）+ verify-all 七层全绿 + 工具箱覆盖门禁回归。

## 0.5.9（2026-08-27 追加）

> 修复方向（用户"整体审查"要求，依据手册知识条目 K-01~K-06）：静态工具清单漏分类官方工具
> （`run_code` 事故——code 模式会话一切被拦）→ 单一真源 + 前缀规则 + 覆盖门禁 + 白名单可视化。

- **工具分类单真源**：规则 24④ 守卫与 unknown 处置统一读 `lib/core/tool-catalog.js` 唯一分类表（废弃双表——run_code 正是双表都漏的受害者）；
- **官方工具全集补全**：59 个官方 tool-catalog 工具名全覆盖（`cordis_*`/`terminal_*`/`session_*`/goal/jobs/子代理/团队/plan-mode/官方保留传输 `run_code` 等）——Code Mode 会话（模型只能直呼 `run_code`）不再被"未知工具"拦死；
- **前缀规则**：`mcp__`（变更类走授权，照 Claude Code `mcp__*` 范式）、`esr_`/`dev_` 等生态命名空间自动归类——**将来新增插件工具遵循惯例即被覆盖**（不再依赖静态枚举）；
- **unknown 首调处置 `unknownPolicy`**：默认 `deny`（保守：`ask` 弹窗模式需真实场景实弹验证后才可作默认；配置 `"ask"` 可切换官方弹窗——approval 弹窗 allowed-once，无审批通道自动拒绝，官方 fail-closed 语义）；
- **白名单 v2 带元数据**：`~/.dsh/rule-engine-tools.json` 升级为 `[{name,time,session}]`（**谁、何时、在哪个会话被放行**——可视化基础）；旧 `["name"]` 格式兼容加载；历史条目显示"时间/来源未知"；
- **`/guard tools` 命令**：查看白名单（永久 + 本会话新增，含时间/来源会话）+ `/guard tools revoke <工具名>` 撤销（持久化+会话集同步）；
- **工具箱覆盖门禁**：`scripts/check-tool-coverage.mjs`（官方 tool-catalog vs 分类表，任一 unknown 即红——`run_code` 事故同类的机器防线）已挂入 `verify-all` 第五层；
- **测试**：全量单测（新增 whitelist 格式 5 用例）+ loader-smoke 新增 E 场景（白名单 v2 真实落盘断言：对象数组/时间/来源会话/审计留痕）+ verify-all **七层**全绿。

## 0.5.8（2026-08-26 追加）

- **白名单持久化**："允许使用 X"（未归类工具批准）落盘 `~/.dsh/rule-engine-tools.json`——此前为内存态，热重载/重启即清（用户需反复重发，实测 esr_task/esr_close 各被清一次）；
- **只读命令词表补全**：`Select-Object / Out-String / Format-Table / Measure-Object / Sort-Object / Where-Object / Group-Object / Out-Null / ConvertTo-Json` 等常见只读 cmdlet 纳入只读判定（此前 `Get-Item | Select-Object` 被误判为变更拦截）——含"管道内含写操作仍判变更"的安全回归；
- **`npm run verify`** 注册（= `scripts/verify-all.mjs` 七层体检别名）；
- 工作区内低风险变更豁免（12A 正文对齐：只读诊断脚本不再被拦——0.5.7 的延续项）。

## 任务契约与反过度工程（可选）

- 默认**关闭**；可在规则引擎设置页开启「任务边界与反过度工程」总开关。
- 开启后默认**观察模式**，只审计提醒；切到 `armed` 才真正拦截。
- 弹窗询问默认**关闭**；`askEnabled` 开启后，对依赖/hash 等动作走官方 approval 询问。
- 支持 `/guard mode|budget|contract|label` 命令。

## 命令

| 命令 | 作用 |
|---|---|
| `/guard status` | 引擎状态（规则数/置信度/放行/解锁） |
| `/guard rules` | 规则清单 + 理解产物 |
| `/guard active` | 最近激活了哪些规则、为什么 |
| `/guard log [N]` | 最近 N 条审计 |
| `/guard unlock [N]` | 解锁配置写保护 N 分钟（仅用户） |
| `/guard bypass [N]` | 临时整体放行 N 分钟（仅用户） |
| `/guard lock` | 立即恢复全部守卫（取消解锁/放行） |
| `/guard revoke` | 撤销全部授权记录 |
| `/guard reload` | 强制重解析 AGENTS.md |
| `/guard mode <模式>` | 设置任务契约模式（review/answer/change/monitor/watch/off） |
| `/guard budget ...` | 设置预算（agents=N files=... deps=allow hash=allow） |
| `/guard contract` | 查看当前任务契约 |
| `/guard label <id> <label>` | 给审计记录打标（correct/incorrect/inconclusive） |
| `/guard tools` | 查看工具放行白名单（永久+本会话，含时间/来源会话） |
| `/guard tools revoke <名>` | 撤销白名单条目（持久化+会话集同步移除） |

## 装配方式

本插件已按官方 **bundle** 规范打包，包内自带 `cordis.patch.yml`。

推荐安装方式：

```bash
dsh plugin --profile web add dsh-rule-engine
```

或手动将 `dsh-rule-engine` 加入 profile 的 `dsh.profile.bundles` 数组。包内的 `cordis.patch.yml` 会自动挂载插件行：

```yaml
- insert:
    - id: dsh-rule-engine
      name: 'dsh-rule-engine'
```

如果你是从源码手动调试，也可以沿用 insert 方式挂载，但正式安装建议走 bundle。

## 安全设计

- 只读操作（read/grep/glob/read_image/str_replace_editor view）无条件放行，拦截只针对变更类操作
- 插件自身配置/理解产物对模型只读：直接 `edit/write` 会被守卫拒绝，需 `/guard unlock`
- AGENTS.md mtime 变化后自动重解析（`fs.watch` + stat 兜底），规则增删改无需重启
- **修改插件 lib 代码后必须重启 DSH 生效**：bundle 装配下 `dev_reload_package` 热重载不可靠（报成功但行为仍旧代码，踩坑 65）；重启后以行为实测（如“请继续”放行）验证
- LLM 意图兜底：对词表低置信/歧义的用户消息异步调用 `ctx.llm` 判定意图（sha256 缓存 + 会话每日限额），词表判拦且 LLM 高置信判执行时放行；失败自动降级词表（`rule-engine.json` 的 `llmIntent` 配置段可开关/调阈值）
- 状态信号：用户“我已重启/已输入/完成”等就绪确认与无消息回合不做规则 22 拦截，敏感操作仍由 12A/13A 把关（规则 22⑩）
- 低置信规则不参与硬拦，避免误伤；在 `/guard rules` 中标记人工复核
- 授权证据按“操作类型 + 目标路径前缀”结构化匹配，区分“询问”与“授权”
- 备份证据按“目标路径 → 备份路径”记录，删除/覆盖前必须存在对应路径且备份文件真实存在
- 版本/手册类文件写后自检：版本号连续、append 不覆盖上一行，失败自动回滚并审计
- 跨工具一致性：同一敏感操作经 `edit` / `write` / `str_replace_editor` / `pwsh` 必须得到相同拦截/放行结论
- 命令输出静默错误检测：全 false/0/null 或与上一条完全一致时审计 + 注入提醒，不阻断
- **注入提醒通道实测限制（2026-08-24，O1 实测——已修复，批次 6）：** 根因：`agent.inject` 在 `session/event` 观察回调内同步调用，命中 dsh-session 的 append 重入保护（`session append cannot reenter`，日志 `kind:inject` 可见）；2026-08-24 批次 6 已修复：投递延迟到 append 发布边界之后（宏任务），语义不变（inject 官方语义即“为下一 pre-step 排队、不唤醒”）；审计从 `注入异常` 变为 `注入已投递` 可对账（详见局限 6）
- **消息注入判别（机制 A，2026-08-24）**：`user/message` 先判 `source.kind`（`user` 以外的官方/插件注入一律跳过：不覆盖回合状态、不产生授权），并用已知注入模板兜底（Current runtime context 快照 / Background subagent 通知 / vision-router 挂载提醒 / `[规则引擎]` 前缀），全部留 `source-skip` 审计——系统注入与插件挂载通知不再污染授权池
- **工具分类制（机制 B，2026-08-24）**：工具按 analysis / artifact / mutating / unknown 四类判定；未归类工具（新装插件的工具）首次调用走 ask 确认（防“参数名猜不出就放行”的绕过），已归类只读命令（`npm test` / `git -C` / `node --check` / `gh auth status` 等，按命令链分段判定）无条件放行
- **授权双轨 + revoke 全清（机制 C，2026-08-24）**：自动来源授权（执行分点/ask/指令）绝不写入全局池（全局仅显式白名单）；`/guard revoke` 全清 session + turn.scopes + global + askRejections；授权路径匹配带边界（`d:/a.txt` 不再误匹配 `d:/a.txt.bak`）
- 技能目录实时联动：`ctx.skills` 目录变化后自动刷新，已禁用/不存在的技能不触发 12B
- LLM 增量理解：对非 high 置信规则调用 `ctx.llm` 补全结构化理解，失败自动回退模式库；AGENTS.md 变化触发重载后会自动补一次增量理解（按规则+版本去重，不重复烧 token）
- D 级自证泛化：按规则特征触发自证提示，每规则每会话限 3 次
- D 级自证泛化（0.5.7 起取代上行语义）：词表只产嫌疑，LLM 裁决确认错误才提醒；同规则同会话仅提醒一次 + 会话每小时 3 条弹窗预算；无真实用户消息的回合不检测不投递（乒乓根治）
- 授权记录默认 10 分钟 TTL，无路径的全局授权 TTL 缩短为 2 分钟；可用 `/guard revoke` 撤销
- 用户直接命令式指令（如“删除这个文件”）也视为授权
- 规则 1 支持“用户明确要求重试”豁免
- 会话状态有容量上限并自动清理，防止长跑内存膨胀
- LLM 理解按“规则 + AGENTS.md mtime”去重，避免重复烧 token
- 审计日志：`~/.dsh/rule-engine.log.jsonl`
- 守卫使用 `ctx.tools.guard()` 单调拒绝，模型无法自行绕过
- **自由区域（Free Zone）**：AGENTS.md 中 `<!-- free-zone:start -->` / `<!-- free-zone:end -->` 标记框住的区段**整区跳过**（不解析、不产生规则、不硬拦、不审计）——适合放“想生效但不想被机器强制”的软约束（如法律守则）。区内的 `### [规则 F<n>]` 条目由配套插件 dsh-rules-manager 在设置页/`/rules` 中可见可管理。新增自由规则请手动在标记内编写（`/rules add` 只会插入到 free-zone 之前），详见 dsh-rules-manager 的 README「📝 新增一条自由规则（零基础三步）」
- **禁用规则联动**：dsh-rules-manager 的「禁用规则」存储（`~/.dsh/disabled-rules.json`）会被引擎读取，被禁用的规则标记为 disabled，不参与硬拦/纠察；恢复启用后自动重新生效

## 当前局限与后续优化路线

当前版本已经具备完整四层骨架，但距离“成熟”仍有距离。以下是一些**难度较高、尚未完全实现**的优化方向，欢迎社区共同推进：

1. **LLM 理解器深化**
   当前只对非 high 置信规则做一次 LLM 增量理解；未来应支持“规则变更窗口期”、增量重理解、低置信人工复核队列。

2. **授权语义精确化**
   当前 ask 授权记录为宽泛 `any` + 路径前缀；未来可要求 ask 面板显式声明操作类型，或支持“一次授权仅针对单个 callId”。

3. **备份证据完整化**
   当前校验备份文件存在；未来可增加哈希/大小一致性校验、备份链管理与自动清理。

4. **规则 12C / 13B / 10 / 15 / 19 等流程类规则深度执行**
   这些规则需要更多业务语义（下载校验、会话三层验证、版本判断、知识沉淀），目前偏“自证提示”，尚未做到机器可判定。

5. **跨会话持久化**
   授权/备份目前为内存态，重启失效。持久化涉及写入保护、并发与恢复，风险较高，暂未实现。
    注（0.5.7）：验证通过记录 verifyPass 已持久化（`~/.dsh/rule-engine-verify.json`，热重载/重启不丢）——规则 23④ 证据链；授权/备份仍为内存态。

6. **输出文本实时拦截**
   受 DSH 官方架构限制，`assistant/message` 无法“拦下不发”，只能事后审计 + 纠正注入；这是平台边界，不是插件能单独突破的。
   另外（2026-08-24 实测 O1 → 批次 6 已修复）：纠正注入通道根因是引擎在 `session/event` 观察回调内同步调用 `agent.inject`，触发 dsh-session 的 append 同步重入保护（`session append cannot reenter while another append is being published`，`kind:inject` 审计全程可见——注入消息从未到达模型/界面）；修复为延迟到 append 发布边界后投递（宏任务 `setTimeout 0`），inject 官方语义本就是“为下一 pre-step 排队、不唤醒”，语义不变；审计 reason 从 `注入异常：session append cannot reenter...` 变为 `注入已投递（agent=...）`，可对账（测试 `test/phase1f-inject.test.mjs` 锁定）。

## 致谢

感谢以下项目与作者的无私开源付出，本项目在开发过程中直接受益：

- **DeepSeek Harness 官方团队（@deepseek-ai）**：提供了 DSH 平台、插件机制与官方文档。
- **本机已安装插件的作者们**：
  - dsh-guardian（lonelymoon87）
  - dsh-visualize（Nagi-ovo）
  - dsh-rules-manager（jilian-dsh）
  - dsh-vision-router、dsh-example-injector 等未列出的作者
- **学习参考的社区文档/库作者**：
  - dsh-handbook（Electricitysheep）
  - SandBase deepseek-harness-handbook（sandbaseai）
  - 以及 DSH 官方文档镜像与源码维护者

## 免责声明

本项目是**个人/社区项目**，**不属于 DeepSeek Harness 官方项目**，与官方无隶属关系。使用风险自负，请在生产环境前充分测试。

## 开发与测试

```bash
npm test
bash scripts/build.sh
```

交付前体检（0.5.7 起）：`node scripts/verify-all.mjs`（七层：语法/单元/组合冒烟/工具箱覆盖/守卫链覆盖/关联一致性/真实判例）与 `node scripts/health-audit.mjs`（找茬）——详见「质量与验证」。

发布：`node ../../scripts/release-plugin.mjs <插件目录> <版本号>`（一键 npm + git + GitHub Release，见 `scripts/release-plugin.mjs` 注释）。

## License

MIT
