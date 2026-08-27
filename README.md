# dsh-rule-engine

![npm](https://img.shields.io/npm/v/dsh-rule-engine)
![version](https://img.shields.io/badge/version-0.5.10-blue)

DSH 规则执行引擎 v3 的插件实现。它把 `~/.dsh/AGENTS.md` 当作唯一真相源，自动解析规则四要素与执行等级，再通过「工具守卫 + 文本检测 + 时序检查 + 审计台账」执行用户规则，而不是内置一套与用户无关的安全清单。

> 当前版本 **0.5.7**（2026-08-26 发布）。本插件面向"规则机器化执行"：规则写在 AGENTS.md 里，引擎负责让它们真的被遵守；所有规则动态解析，规则增删改后无需重写插件。

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
- `node scripts/verify-all.mjs` —— 交付前**五层**体检：语法（lib 全文件 `node --check`）→ 单元（run-all）→ **组合冒烟**（`test/loader-smoke.e2e.mjs`：真实引擎代码 + 真实审计文件，仅 mock LLM 边界，断言**外部世界**——审计文件里真的出现 judge-false/judge-pass 记录，而非自我报告）→ **工具箱覆盖**（`scripts/check-tool-coverage.mjs`：官方 tool-catalog 全集 vs 分类表，出现 unknown 即红）→ **真实判例**（近 24h 台账 judge-pass/false 记录数，0 条 = WARN 提示需实弹）；
- `node scripts/health-audit.mjs` —— 找茬清单：近 24h 失败/降级类统计（intent-llm 失败、judge-unavailable、verify-gap、inject-skip…）+ 关键导出接线交叉（疑似未接线 = 告警）——"失败可见化"，不再有静默躺 20 小时的降级；
- 执行协议（本仓库自身交付纪律）：方案冻结单（范围/影响面/测试计划/失败预测）→ todo 化 → 小步闭环（每改动立即 `node --check`）→ 对账交付（计划×实际逐项 ✅/❌/跳过原因）。

## 0.5.10（2026-08-27 追加）

> 收编：用户审查后的 real-legal 会话建议（建议 2/3/4/5，依据本手册知识条目 K-01~K-06 批判性审查）+ 分析通道（用户多次提出的"只读分析需要写临时脚本/输出"痛点）+ 统一入口加固（2026-08-27 手册损伤事故复盘）。

- **分析通道（单真源 `isAnalysisOp`）**：严格只读 ∪ 分析脚本区（repo `scripts/*.mjs`）∪ 分析临时区写（`logs/` `.analysis-tmp/` `.backups/`）→ 任何回合放行 + 审计 `analysis-scratch`；**红线**（红线层在 guard-core）：受保护文件名/工作区外（isOutsideWorkspace）/删除移动/覆盖正式文件一律不豁免；
- **写类判定单真源**：self-protect / 22 / 13A 统一走 `isMutationCommand`——修复 `Write-Output` 被 `write` 子串误杀（WGO654/ES3VCD 案例：纯读命令查受保护文件名被误拦）；
- **只读词表补全**：ForEach-Object / Get-ItemProperty / Get-Variable / Get-FileHash（多行"读+筛选+循环"组合判只读）；
- **统一入口加固**（example-manual-write.mjs）：① 转义事故特征检测——表格行内字面 `\n` / `\$`（PowerShell 单引号转义事故模式，2026-08-27 手册坏行事故）→ 拒绝；② 写后结构校验——表格块列宽一致（±2 容忍）+ 手册版本记录行存在，不通过自动回滚；
- **误判打标闭环（建议 4）**：所有硬拦文案尾部附「误判可打标：/guard label <事件号> incorrect」指引；health-audit 新增 deny 总数 vs incorrect/correct 打标占比统计（词表迭代量化依据）；
- **已知坑召回（建议 5）**：工具错误文本命中特征表（SEC_E_NO_CREDENTIALS / ECONNREFUSED:7890 / EPERM 管道 / ERR_MODULE_NOT_FOUND）→ 审计 `error-hint` + 注入指向知识库提示（本轮去重、走投递资格链，不违反注入噪音治理）；
- **质保**：新增强力测试（写类判定/分析通道/临时区红线/转义检测 REFUSED 实测/召回特征）+ verify-all 五层全绿 + 工具箱覆盖门禁回归。

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
- **测试**：全量单测（新增 whitelist 格式 5 用例）+ loader-smoke 新增 E 场景（白名单 v2 真实落盘断言：对象数组/时间/来源会话/审计留痕）+ verify-all **五层**全绿。

## 0.5.8（2026-08-26 追加）

- **白名单持久化**："允许使用 X"（未归类工具批准）落盘 `~/.dsh/rule-engine-tools.json`——此前为内存态，热重载/重启即清（用户需反复重发，实测 esr_task/esr_close 各被清一次）；
- **只读命令词表补全**：`Select-Object / Out-String / Format-Table / Measure-Object / Sort-Object / Where-Object / Group-Object / Out-Null / ConvertTo-Json` 等常见只读 cmdlet 纳入只读判定（此前 `Get-Item | Select-Object` 被误判为变更拦截）——含"管道内含写操作仍判变更"的安全回归；
- **`npm run verify`** 注册（= `scripts/verify-all.mjs` 四层体检别名）；
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

交付前体检（0.5.7 起）：`node scripts/verify-all.mjs`（四层：语法/单元/组合冒烟/真实判例）与 `node scripts/health-audit.mjs`（找茬）——详见「质量与验证」。

发布：`node ../../scripts/release-plugin.mjs <插件目录> <版本号>`（一键 npm + git + GitHub Release，见 `scripts/release-plugin.mjs` 注释）。

## License

MIT
