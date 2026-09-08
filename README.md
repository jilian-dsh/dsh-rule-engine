# dsh-rule-engine

![npm](https://img.shields.io/npm/v/dsh-rule-engine)
![version](https://img.shields.io/badge/version-0.6.2-blue)

DSH 规则执行引擎 v3 的插件实现。它把 `~/.dsh/AGENTS.md` 当作唯一真相源，自动解析规则四要素与执行等级，再通过「工具守卫 + 文本检测 + 时序检查 + 审计台账」执行用户规则，而不是内置一套与用户无关的安全清单。

> 当前版本 **0.6.2**（0.1.2-rc.1 适配：Remote 新合同（typert-protocol `Remote(undefined, …)` 形态，typeof-null 陷阱修复）+ peer 锚扩 `>=0.1.2-rc.0`；白名单 3 轮扩充（gh 只读态 / `gh api` 只读 / `git ls-remote` / `cmdkey /list` + Do- 结构词回归修复）；E7 豁免预插（release-plugin bump 后自动追加 pnpm minimumReleaseAgeExclude——⑬ 口径防发布后红灯窗口，单源 `scripts/lib/pnpm-exempt.mjs`））。本插件面向"规则机器化执行"：规则写在 AGENTS.md 里，引擎负责让它们真的被遵守；所有规则动态解析，规则增删改后无需重写插件。

## 项目背景

这个项目来自一个非常具体的个人需求：

- 作者是**零编程基础**用户，但极其重视规则的制定、执行、遵守与复盘。
- 作者发现：规则如果只写在文本里、靠模型“自觉”执行，会反复失效（例如时间词写错、内联命令违规、交付前漏验证等）。
- 因此核心思路是：**规则的执行不能只靠自觉，要尽量靠插件在机制层强制**。
- 本插件所有规则均从 `AGENTS.md` 动态解析，规则增删改后无需重写插件。

当前实现基于已有的 `AGENTS.md` 规则体系拓展，社区暂无类似插件供参考（大概率为该等约束可能限制开发自由性，不适用于专业编程人员），**可能存在大量不完备、误判或边界问题**。欢迎任何使用者提出调整建议、提交 issue 或 PR。项目仍处于“可运行但需要持续打磨”的阶段。

## 通用性调整（0.5.13，2026-08-31）

本插件定位：**通用规则执行引擎**——任何用户的 AGENTS.md 规则集均可使用；本机工作流偏好仅作默认兜底（配置层），不含任何强制绑定。

- **声明式绑定**：规则正文可写 `<!-- handler: xxx -->`（或经插件配置 `handlerOverrides: {规则编号: 执行器名}`）显式绑定引擎执行器；未声明的规则按"纯自证"处理（参与匹配/自证提示，不参与机器硬拦）；
- **执行器语义名**：声明/配置可写语义名（`approval`/`backup`/`inline-command`…），自动映射到内部执行器；直接写内部名（`rule12a-approval` 等）同样兼容；
- **禁用语义**：管理器禁用的规则以"禁用占位"存在——`/guard rules` 显示"（已禁用）"，不参与硬拦/纠察；恢复启用后自动重新生效（禁用 ≠ 删除，不再"消失"）；
- **无 AGENTS.md 也可用**：无规则文件时引擎零错加载、零规则、零误拦（发布门禁验证）；
- **本机偏好表下沉配置**：内置默认偏好表已从代码移除——通用部署=空表（代码零本机编号）；本机偏好经 `rule-engine.json` 的 `handlerDefaultMap` 提供（可整体替换/清空，引擎升级不丢）；
- **验证通道**：调研/验证类操作（只读、临时脚本、验证命令如 `npm test`/`verify-all`/`--dry-run` 等）如期放行；执行类（发布/注入/安装/提交等）仍按授权语义严格执行；
- **发布物卫生**：lib 源码不含个人标识（仓库信息从 package.json 解析，非硬编码）；`scripts/publish-aptitude-check.mjs` 为发布适用性门禁（无 AGENTS.md 冷启动 / 空白规则 / 任意编号 / 标识扫描，挂 verify-all 第 8 层）。

## 功能分层

- 阶段 1 容器：解析 AGENTS.md 全部规则 → 理解产物（`rule-understanding.json` 可生成）
- 阶段 2 匹配机 + 工具守卫 + 文本检测
- 阶段 3 时序检查 + 授权询问集成
- 阶段 4 D 级自证调度 + `/guard` 命令完善

当前实现以「模式库兜底」为主，LLM 理解器预留扩展点；所有规则均从 AGENTS.md 实时解析。

## 本机集成（可选，0.6.0）

**核心设计原则：配置存在 = 守卫存在；配置不存在 = 该守卫在代码路径上根本不存在**（不是"可覆盖"，是"默认无"）。0.6.0 起，此前依赖内置默认值的本机约定（统一入口脚本名、本机手册/技能豁免、M8 双通道、本机追加受保护文件）全部移入 `rule-engine.json` 的 `localIntegrations` 配置段；通用用户零配置即零本机行为。

字段（全部经 `localIntegrations`，示例一律用占位名）：

| 字段 | 含义 | 缺省行为（无配置） |
| --- | --- | --- |
| `entryScript` | 本机统一入口脚本名（如 `your-entry-script.mjs`）；配置后才存在"合法写入通道"概念 | 无 = 阶段 C 守卫整体不存在（直写受保护文件不受引擎限制） |
| `protectedFiles` | **追加**受保护文件（在通用基线 `AGENTS.md`/`settings.yaml` 等 7 项之上） | 无 = 仅用通用基线；无 `entryScript` 时本字段一并失效 |
| `m8.enabled` / `m8.entryMarker` | M8 双通道（经统一入口落盘手册/AGENTS 后须同轮记忆沉淀，缺失注入纠正） | 无 = M8 机制整体禁用（**v0.6.0 语义反转：默认开启 → 显式开启**） |
| `manualExempt.skills/paths` | 规则 18"先查手册"与 12B/12A 豁免链的本机手册/技能 | 无 = 该检测链无对象、自然静默 |

配置示例（`~/.dsh/rule-engine.json`，占位名）：

```json
"localIntegrations": {
  "entryScript": "your-entry-script.mjs",
  "protectedFiles": [
    "skills/your-manual/SKILL.md"
  ],
  "m8": { "enabled": true, "entryMarker": "your-entry-script.mjs" },
  "manualExempt": {
    "skills": ["your-manual", "your-planner"],
    "paths": ["your-manual/SKILL.md"]
  }
}
```

**迁移（0.5.x → 0.6.0）**：0.6.0 前默认生效的守卫在升级后**不再默认激活**——需要本机行为（统一入口保护 / 手册豁免 / M8 记忆链 / 追加受保护文件）时，按上表把配置段并入本机 `rule-engine.json`。**通用用户无需任何配置**；未配置时相关守卫路径不存在，直写任意文件不受引擎限制（这是 0.6.0 的设计决定：发布物无权限制其他用户的写入方式；本机约定属于本机配置，不属于通用引擎）。

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

> **版本状态说明（2026-09-01 更新）**：0.5.11-0.5.14 均已独立发布（见上；0.5.14 = 2026-09-01 三通道，git 8105d3e）。历史说明：0.5.11 发布时含 0.5.10 git 提交欠账 7 文件补齐（baseline/intent/judge/llm-intent/semantic/tool-catalog/whitelist.js——npm 包本已包含，git 通道缺失）。

## 版本历史（摘要）

> 更早版本（0.1.0-0.5.5）与本机历史要点见 git 历史；各版本内部"用户定稿"等决策细节不再随发布物携带。

| 版本 | 日期 | 要点 |
| **0.6.2** | 2026-09-08 | fix(0.6.2): whitelist 3-round + 0.1.2 adaptation + peer-anchor 0.1.2 + E7 pre-plug wiring  |
|---|---|---|
| **0.6.1+（本地增强，未发版）** | 2026-09-07 | 只读豁免清单扩充（用户定调"纯只读顺畅"）：`gh api` 只读态（无 -X/--method/graphql/-F/-f 的段）、`gh release/issue/pr/run view`、`cmdkey /list`、`git ls-remote` 显式；写形态（gh api -F/graphql、git fetch、curl 下载、重定向落盘）保持拦截；26 用例全绿 + 语法体检 + 热重载生效（发版需 bump 0.6.2） |
| **0.6.1** | 2026-09-07 | **B 档发布**：豁免预插（release-plugin bump 后自动追加 minimumReleaseAgeExclude——⑬ 口径防发布后红灯窗口）；豁免判定单源化（scripts/lib/pnpm-exempt.mjs 与 verify-all ⑬ 共享 + 4 单测）；viewFails 发布语境 STRICT 计 ❌；⑬ 头注释绝对口径 |
| **0.6.0** | 2026-09-04 | **行为变更**：通用与本机分离——`localIntegrations` 本机集成层（entryScript/protectedFiles/m8/manualExempt 四键）；此前默认强制的守卫（统一入口阶段 C / 手册/技能豁免 / M8 双通道）改为"配置存在=守卫存在、无配置=代码路径上不存在"；`m8` 语义反转（默认开启→显式开启）；消号本机痕迹（lib/ 零命中，词表唯一源 `scripts/local-residue-markers.txt`） |
| **0.5.14** | 2026-09-01 | 分点三柱（条件句零授权/显式命名对象锚定/clauseId 隔离）+ skill 词收紧 + 规则 5 引证检测扩展（内部引用无依据→审计注入）+ 规则 31 查证纪律（B+D）+ README 版本四性对齐 |
| **0.5.17** | 2026-09-03 | A1 规则 2 时间词拆组（当下词=Get-Date① / 历史日期=证据锚②，消除"引用历史日期必判未核对"误报）+ EVIDENCE_MARK_RE 增证据锚（commit hash/版本行/踩坑 N/版本记录） |
| **0.5.16** | 2026-09-02 | 批评≠授权检测双层重构（STRONG 直接提醒 / WEAK 嫌疑交 judge 裁决——实弹漏判"你怎么还在做！"修复；词表只产嫌疑+模型定论）+ 0.5.15 后批次（Remote 签名一致性回归/调试产物清理/PERSONAL_RE git 门禁/CRITICISM_RE 初版/LICENSE 豁免）+ DSH-STORE 权限披露 |
| **0.5.15** | 2026-09-02 | 回合末裁决卡片（host 侧 turn/end 裁决摘要 + client 包 dsh-rule-engine-client：可交互 ✅/❌ 卡片；判例登记一次性（per-block）；多次裁决一卡逐条分组；卡片/判例落盘 rule-engine-turn-cards.json 重启不丢） |
| **0.5.13** | 2026-08-31 | 通用化（声明式绑定/禁用语义/会话寻址/验证通道/发布适用性门禁）+ 阶段二·三（委派豁免/中文顿号路径/ask 节流区分/D1-D3 注入/F1 规则 2/F2 verify-gap） |
| **0.5.12** | 2026-08-30 | 意图优先级修正（动作词先于方案词）、LLM 意图兜底同步等待、@文件引用信号、只读判定三档（写特征/白名单/保守拒）、规则 22 粒度并入会话授权、ERR 码打标链路、F2 打标指纹、F5 契约类别白名单 |
| **0.5.11** | 2026-08-29 | 判定内核第一轮：新建豁免补"新建"语义、分析通道移除脚本区语义豁免、12A 与 22-7 判据同源、后台判定模型 = 当前会话模型；词表唯一源（lexicon.js）、rule14 空转映射清理、规则 24 机器执行修正（守卫链覆盖测试） |
| **0.5.10** | 2026-08-27 | 分析通道（单真源 isAnalysisOp：严格只读 ∪ 分析临时区写）、写类判定单真源（isMutationCommand）、只读词表补全、统一入口加固（转义检测 + 写后校验）、误判打标闭环、已知坑错误码召回 |
| **0.5.9** | 2026-08-27 | 工具分类单真源（tool-catalog.js）、官方 59 工具全集覆盖、前缀规则（mcp__/esr_/dev_ 等命名空间自动归类）、unknownPolicy（默认 deny）、白名单 v2 带元数据、/guard tools、工具箱覆盖门禁 |
| **0.5.8** | 2026-08-26 | 白名单持久化（rule-engine-tools.json）、只读命令词表补全（Select-Object 等）、`npm run verify` 注册 |
| **0.5.7** | 2026-08-26 | 注入噪音治理（词表只产嫌疑 + LLM 裁决 + fail-closed + 投递资格闸 + 审计完整性）、注入通道重入修复（宏任务投递）、语义层（awaitingJudge/judge-pass/false/unavailable） |
| **0.5.6** | 2026-08-26 | 同回复聚合注入、已自证规则不重复触发、C2 规则统计（detected/suppressed/injected） |

## 发行固定源

- **0.6.2（当前）** 固定于 main Commit `92da194`（`git checkout 92da194` 可复现 npm `dsh-rule-engine@0.6.2` 与 GitHub Release v0.6.2 同源代码——0.6.2 = 0.1.2-rc.1 适配（Remote 新合同 `Remote(undefined, …)` / peer 锚扩 `>=0.1.2-rc.0`）+ 白名单 3 轮扩充 + Do- 结构词回归修复 + E7 豁免预插机制上线）。
- **0.6.1** 固定于 main Commit `051e2da`（`git checkout 051e2da` 可复现 npm `dsh-rule-engine@0.6.1` 与 GitHub Release v0.6.1 同源代码——0.6.1 = 豁免预插（release-plugin bump 后自动追加 pnpm minimumReleaseAgeExclude，⑬ 绝对口径防发布后红灯窗口——踩坑 18 镜像）+ 豁免判定单源化（scripts/lib/pnpm-exempt.mjs 与 verify-all ⑬ 共享，4 单测锁定）+ viewFails 发布语境 STRICT 计 ❌ + ⑬ 块头注释绝对口径（E1/E2/E3 收尾批）。
- **0.6.0** 固定于 main Commit `be5b8c93`（可复现 `dsh-rule-engine@0.6.0` 与 Release v0.6.0——0.6.0 = 本机集成层（localIntegrations 四键）+ 本机痕迹消号 + li-skipped/entry-script-missing 启动审计 + 发布门禁 B1/B2（readme-version-check / local-residue-scan，挂 verify-all/release-plugin/check:meta）+ check-tool-coverage 素材 fail-closed；词表文件 `scripts/local-residue-markers.txt` 为本机门禁工具，不入库、不进发布物（见 .gitignore / package.json files 排除）。固定源之后的提交仅限 README 指针文本）。

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
| `/guard contract categories ...` | 设定契约类别白名单（build/test/install 等非破坏类；0.5.12） |
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

## 权限、依赖、外部服务与失败边界（DSH STORE 披露）

> 面向插件商城（DSH STORE）自动审核与安装者；普通用户可跳过。
> 声明原则：只陈述实际能力，不因申请自动上架而省略或弱化；本插件因权限信号被商城保守标记，符合"高权限防护工具需 user-reviewed"的商城契约。

- **文件访问**：读写 `~/.dsh/rule-engine.log.jsonl`（审计台账）、`rule-engine-tools.json`（工具白名单）、`rule-engine-verify.json`（验证通过记录）、`rule-engine-turn-cards.json`（回合末判例卡片）、`disabled-rules.json`（读）、`rule-engine.json`（配置，读）、`AGENTS.md`（读 + watch 重载）。**写入仅限插件私有状态文件**；对用户业务文件的写动作只在用户规则触发的守卫流程内执行（如版本守卫的备份/回滚）。
- **网络**：仅 `lib/service.js` 两处**只读 GET**（`api.github.com` release 检查、`raw.githubusercontent.com` upgrade-impact），8 秒超时、无凭据、无请求体，URL 由 package.json 解析（不访问任意地址）。
- **命令执行**：无 `child_process`/子进程调用；"命令检测"= 对用户命令文本做正则分析（词表），不运行任何被检测的命令。
- **凭据**：读取环境变量 `DSH_LLM_PROVIDER` / `DSH_LLM_MODEL` / `DSH_WORKSPACE` 作为运行配置（非密钥）；不读取 API Key、令牌；审计与注入消息不含凭据。
- **依赖**：无运行时 `dependencies`；peer 依赖 `@deepseek-ai/dsh-home-paths`、`@deepseek-ai/dsh-typert-protocol`（官方接口）；`package.json` 无安装期生命周期脚本（无 preinstall/install/postinstall/prepare）。
- **外部服务**：同网络项；失败时静默降级（release 检查失败只影响升级提示展示，不阻断守卫）。
- **失败边界**：LLM 裁决/意图兜底不可用时 fail-closed（不投递、不误放）；审计写入失败不阻断拦截（拦截先于落盘）；词表/LLM 双通道判定，低置信不参与硬拦；守卫拒绝仅针对变更类动作，只读操作无条件放行。
- **权限等级**（保守自评）：**高**（可写审计/白名单等持久状态、访问网络只读端点、读取环境变量配置）——建议安装前阅读上文「安全设计」并按需二次审查。

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
- **社区插件的作者们**：
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

发布：`node scripts/release-plugin.mjs <插件名> <版本号>`（一键 npm + git + GitHub Release；发布脚本随插件仓库管理——`scripts/release-plugin.mjs`；改发布脚本后须 `--dry-run` + 代码审查，注意 dry-run 不覆盖 git 段）。

## License

MIT
