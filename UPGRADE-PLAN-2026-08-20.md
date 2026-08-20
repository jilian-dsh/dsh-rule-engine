# dsh-rule-engine 升级方案（基于 stop-that-shit 调研）

> 日期：2026-08-20
> 状态：已实施（本地热重载通过、测试全绿、装配审计 MOUNT CONSISTENT；待用户确认后发布）
> 范围：只读调研 → 升级方案；本文不包含任何装配/配置变更

## 1. 背景与目标

用户目标是：

1. 优化 `dsh-rule-engine`（当前 v0.4.3），让它不仅能执行现有 AGENTS.md 规则，还能对模型形成**必要且合理**的约束，阻止过度工程/越界。
2. 参考 `lennney/stop-that-shit` 的设计，同时结合 DSH 生态已有 guard/approval 插件。
3. 最终把结论沉淀进 `dsh-usage-manual`。

本方案只描述升级设计；是否实施、按哪个阶段实施，需用户确认。

## 2. 调研结论摘要

### 2.1 stop-that-shit（核心参考）

- 来源：https://github.com/lennney/stop-that-shit
- 版本：0.1.0；不是 DSH 插件，是 Codex / Claude Code / OpenCode / Hermes 插件。
- 核心机制：**Skill（语义判断） + Hook（机器拦截） + Adapter（宿主事件归一化）**。
- 任务模式：`review / answer / monitor / change / watch / off`。
- 四类越界（SHIT）：
  - **S**cope creep：范围膨胀；
  - **H**ashing / hypothetical hardening：无消费者的哈希/防御性加固；
  - **I**ntent violation：只让 review 却动手改；
  - **T**ask thrashing：重复搜索/测试/审计。
- 预算/放行词：`files=`、`deps=allow`、`hash=allow`、`agents=N`。
- 决策分层：`deny_and_explain` / `require_user_approval` / `report_and_defer` / `allow`。
- 状态机：`OFF / OBSERVING / ARMED`；默认 `OBSERVING / unconfirmed`，显式指令后才 arm。
- 审计：只存元数据，区分 `checked action / context response / permission deny`，并支持人工标注 `correct / incorrect / inconclusive`；明确 `hostEffect: unobserved`。

### 2.2 DSH 生态相关插件

| 插件 | 结论 |
|---|---|
| dsh-guardian（已装） | 危险操作 deny/ask + 输出脱敏；不管“过度工程/任务越界” |
| dsh-plan-lattice | 执行期漂移防火墙：契约、目标文件 digest、授权 epoch、subagent 继承；重但方向高度相关 |
| @quill507/dsh-auto-approval-llm | Auto 档自动审批；方向是“自动放行”，与 stop-that-shit 相反，但审批管线可借鉴 |
| dsh-git-guardrails / dsh-plugin-eval 等 | 多为 skill 型，质量/成熟度待评估，参考价值有限 |

### 2.3 DSH 官方 API 约束（关键）

- `ctx.tools.guard()` 是**单调守卫**：只能返回 `string | undefined`，即只能 deny，不能 ask。
- `tools/pre-execute` waterfall 支持 `allow / deny / ask`；`ask` 会走官方 approval 服务，用户批准后一次性放行。
- 因此：**硬拒绝继续用 guard；需要“询问/放行词”的场景应新增 `tools/pre-execute` 监听或调用 `ctx.approval.request()`**。
- `ToolExecution` 提供 `name / arguments / agent`，可拿到会话 id，足以维护“会话级任务契约”。

## 3. 当前 dsh-rule-engine 现状与差距

当前能力：
- 解析 AGENTS.md 四要素 → 理解产物 → 工具守卫 + 文本纠察 + 时序检查 + 审计。
- `guard-core.js` 内已有规则 1/9/12A/12B/13A/18/21/24/25/27 等硬拦。
- 授权记录：`type + pathPrefix + TTL`，来自用户消息或 ask_user_question。
- 文本检测：B 级纠察 + D 级自证，覆盖规则 2/5/7/11/21/22/23/27 等。
- 审计：JSONL，简单裁剪。

差距：
1. **没有“任务模式/意图契约”**：无法区分“用户只让 review 还是允许 change”。
2. **没有反过度工程模式**：不检测无消费者的 hash、未请求依赖、subagent 超预算、重复搜索/测试。
3. **没有预算机制**：文件范围、依赖、hash、subagent 数量没有会话级配额。
4. **没有 Good Case 例外机制**：目前“有授权即放行”，不要求“可达证据”证明必要。
5. **没有观察/armed 状态机**：无法在低风险时只观察、用户显式 arm 后才硬拦。
6. **审计缺少可标注/可校准字段**：不能记录 `correct/incorrect/inconclusive`，难以持续优化。
7. **只使用 guard 硬拦**：遇到“应询问而非直接拒绝”的场景（如加依赖）没有原生 ask 通道。

## 4. 总体设计

在现有“规则容器 → 理解器 → 匹配机 → 执行框架”上增加一层 **Task Contract（任务契约）**，并扩展模式库、预算、审计。

```
用户消息 / 工具调用
        │
        ▼
┌─────────────────────────────┐
│ Task Contract 解析器         │  review/answer/change/monitor/watch/off
│ files/deps/hash/agents 预算  │
└─────────────────────────────┘
        │
        ▼
┌─────────────────────────────┐
│ 规则引擎 guard（硬拦）        │  现有规则 + 反过度工程硬规则
│ tools/pre-execute（ask）     │  需要用户确认的越界动作
└─────────────────────────────┘
        │
        ▼
┌─────────────────────────────┐
│ 文本纠察 / D 级自证           │  Stop Ladder 提示、越界表述检测
└─────────────────────────────┘
        │
        ▼
┌─────────────────────────────┐
│ 审计与标注                   │  决策、hostEffect、人工标注
└─────────────────────────────┘
```

## 5. 模块化升级设计

### 5.0 总开关与设置页（用户要求）

- 在规则引擎设置页新增「任务边界与反过度工程」卡片/开关：
  - `taskContractEnabled`（总开关，默认 **关闭**）：关闭时所有新增任务契约/预算/反过度工程/弹窗都不生效，保持现有行为；
  - `askEnabled`（弹窗询问开关，默认 **关闭**）：即使总开关打开，也默认不弹窗；需要确认的动作改为“观察/记录”或按配置直接拒绝；
  - `mode`（默认 `observe`）：`observe` 只审计提醒，`armed` 才真正拦截；
  - 子项：`files` / `deps` / `hash` / `agents` 预算可编辑。
- 规则引擎 Remote service 增加 `getTaskContractConfig / setTaskContractConfig`，设置页保存后热生效。
- 当 `taskContractEnabled=false` 时：
  - `/guard mode|budget|contract|label` 命令可保留但提示“未启用”；
  - `tools/pre-execute` 不注册 ask 监听；
  - 反过度工程检测不激活。

### 5.1 任务契约（Task Contract）

新增 `lib/core/contract.js`：

- 状态：`mode`（unconfirmed/review/answer/monitor/change/open）、`level`（off/watch/guard/lock）、`agentBudget`、`agentsUsed`、`hashPolicy`、`dependencyPolicy`、`allowedPaths`。
- 解析入口：
  - 用户消息中的显式指令，如“只 review”“只看不改”“修复 XX”“不要修改任何文件”；
  - 未来可支持 `/guard mode review` 之类的命令。
- 会话级存储：放入 `state.sessions[].contract`。
- 默认 `unconfirmed / watch`，不硬拦；用户显式给出模式后进入 `guard`。

对现有规则的影响：
- `review/answer/monitor` 模式下，写类工具（edit/write/str_replace 非 view/危险 pwsh/bash）直接 deny。
- `change` 模式下只允许“请求内 + 必要后果”，由 5.2/5.3 进一步约束。
- 用户后续消息“修复/改一下”可自然升级到 `change`（参考 stop-that-shit 的 `naturalCorrection`）。

### 5.2 反过度工程模式库（SHIT）

新增 `lib/core/overengineering.js`：

- **H - Hash/无消费者校验和**：
  - 在 pwsh/bash/edit 参数中识别 `Get-FileHash / sha256sum / openssl dgst / checksum` 等；
  - 总开关关闭时不激活；开启后：`observe` 只审计，`armed` 且无 `hash=allow`/无可见消费者时 deny 或 ask（受 `askEnabled` 控制）。
- **S - Scope creep**：
  - 识别“顺手重构/加兼容层/加 feature flag/加迁移”类表述；
  - 对未请求的大范围文件变更做“范围外路径”拦截（结合 `allowedPaths`），同样受总开关与模式控制。
- **S - Dependency**：
  - 识别 `npm install / pnpm add / pip install / go get` 等；
  - 默认 `observe` 只记录；`armed + askEnabled=true` 时走 approval；`armed + askEnabled=false` 时按配置拒绝或仅提醒。
- **I - Intent violation**：
  - 由任务契约的 mode 直接覆盖，`review` 下写文件即 deny（仅在总开关开启时生效）。
- **T - Task thrashing**：
  - 会话级“重复动作检测”：同一搜索/测试/审阅命令在短时间内重复出现且没有新证据，先注入提醒；`armed` 下连续重复可升级为 ask/deny，`observe` 下只记录。

### 5.3 预算机制

- `allowedPaths`：文件锁。`files=src/a|test/b` 限定写目标；未证明路径时拒绝（受总开关/模式控制）。
- `agentBudget / agentsUsed`：subagent 预算。在 `subagent` / `tool-subagent` / `workflow` 调用前检查并原子扣减；超预算 deny（受总开关/模式控制）。
- `dependencyPolicy` / `hashPolicy`：`deny / ask / allow` 三态；`ask` 仅在 `askEnabled=true` 时启用。

实现位置：
- 在 `guard-core.js` 增加对应 handler；或在新的 `contract-guard.js` 中实现。
- 预算状态放 session contract，随 `turn/start` 不清零（任务级），由新指令重置。
- 所有预算检查先读设置页总开关，关闭时直接跳过。

### 5.4 Good Case 例外机制

- 当反过度工程规则命中时，不是一律 deny，而是给模型/用户两条路：
  1. 提供“可达证据”（调用方、发布流程、验收条件）说明必要；
  2. 用户显式 `hash=allow / deps=allow / agents=N`。
- 审计中记录 `evidence` 字段，后续可统计误拦率。

### 5.5 观察模式与 arm

- 默认 `OBSERVING`：只审计、不 deny；与当前“低置信不硬拦”互补。
- 设置页 `mode` 默认 `observe`；用户显式开启 `armed`，或使用 `review / change / lock` 后才进入 `ARMED`。
- 总开关关闭时，观察/armed 均不生效。
- `/guard` 命令新增（总开关关闭时提示“未启用”）：
  - `/guard mode review|answer|change|monitor|watch|off`
  - `/guard budget agents=N files=... deps=allow hash=allow`
  - `/guard contract` 查看当前任务契约。

### 5.6 审计与标注

扩展 `audit.js` 条目字段：
- `contractMode` / `contractLevel`
- `family`（S/H/I/T）
- `decisionOutcome`（allow/deny/ask/report）
- `responseOutcome`（none/context/permission_deny/execution_denial）
- `hostEffect`（unobserved）
- `evidence`
- 可选人工标注：`label: correct|incorrect|inconclusive`

### 5.7 文本纠察扩展

在 `text-detect.js` 增加：
- 越界表述检测：如“我顺便改一下”“额外加个依赖”“防止以后需要”；
- Stop Ladder 四问自证：当模型声称“这是必要的”时，要求给出可达证据；
- 重复审计循环检测：输出中出现“我再检查一遍”“再跑一次测试”且没有新证据时触发 D 级自证。

## 6. 与 DSH 官方 API 的接入方式

| 场景 | 接入点 |
|---|---|
| 硬拒绝（review 模式写文件、路径越界、超预算） | `ctx.tools.guard()` 继续使用 |
| 需要询问（加依赖、hash、模糊范围） | 仅当 `askEnabled=true` 时新增 `ctx.on('tools/pre-execute')` 返回 `{kind:'ask'}`；或直接调用 `ctx.approval.request()`；关闭时不注册 ask |
| 工具执行后观察/记录 | 现有 `session/event` 的 `tool/result` |
| subagent 预算 | 在 `tool-subagent` / `subagent` 工具 guard 中检查；也可监听 `agent/pre-step` 等事件（需进一步验证） |
| 输出文本纠察 | 现有 `assistant/message` 事后检测 + `maybeInject` |

注意：
- `tools.guard` 是单调 deny，不能“放行”，所以 ask 必须走 pre-execute/approval。
- 同时存在多个 pre-execute 监听时，`ask` 与 deny 的合并规则需测试（官方文档：deny 优先于 ask 优先于 allow）。
- 与 dsh-guardian 同时存在时，应保持“最严格结果胜出”，避免冲突。

## 7. 兼容性/风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| 误拦正常“必要后果” | 反过度工程规则可能把必要的调用方/测试/迁移也拦掉 | 默认 OBSERVING；Good Case 例外；人工标注校准；总开关默认关闭 |
| 与 dsh-guardian / 官方 approval 叠加 | 多个守卫/pre-execute 可能重复拦截 | 统一走最严格合并；先做装配审计 |
| subagent 预算计数不准确 | DSH subagent 工具有多种（subagent / fork / workflow） | 先覆盖显式子代理工具，复杂委托标“未知”并 ask |
| 任务模式解析误判 | 用户自然语言“看看”可能被误判为 review | 默认 unconfirmed；只对高置信表述 arm |
| 性能 | 每个工具调用增加契约匹配 | 纯函数 + 缓存；只对变更类工具做完整判断 |
| 与 AGENTS.md 现有规则冲突 | 新规则可能与规则 12A/13A 重复 | 新模块只处理“任务边界”，授权/备份仍走现有规则 |

## 8. 分阶段实施计划

### Phase 0：准备（不动代码）
- 备份 `dsh-rule-engine` 当前版本（git tag / tgz）。
- 建立测试基线：`npm test` 全绿。
- 实现设置页“任务边界与反过度工程”总开关（默认关闭）的配置骨架。
- 用户确认本方案及优先级。

### Phase 1：任务契约最小闭环
- 新增 `contract.js` + session 状态。
- 支持 `/guard mode` 命令（总开关关闭时提示“未启用”）。
- 在 `guard-core.js` 增加 `review/answer/monitor` 写文件 deny（仅在总开关开启时生效）。
- 测试：总开关关→旧行为不变；总开关开 + review 模式 edit/write 被拦；change 模式放行请求内写。

### Phase 2：反过度工程模式库（观察模式先行）
- 新增 `overengineering.js`。
- 默认 `OBSERVING`：命中只审计 + 注入提醒，不 deny；总开关默认关闭时不激活。
- 增加审计字段 family/decision/evidence。

### Phase 3：预算与 ask 通道（弹窗默认关闭）
- 实现 `files=` / `deps=allow` / `hash=allow` / `agents=N`，受总开关控制。
- 接入 `tools/pre-execute`，但**仅当 `askEnabled=true` 时**对依赖/hash/范围外写返回 `ask`；默认不注册 ask。
- 与官方 approval UI 联调；`askEnabled=false` 时模糊动作按配置“仅记录”或“拒绝”，不弹窗。

### Phase 4：Good Case 与人工标注
- 支持 `/guard label <eventId> correct|incorrect|inconclusive`。
- 增加 evidence 字段和误拦统计。

### Phase 5：文本纠察增强
- 增加 Stop Ladder 自证、越界表述、重复循环检测。

### Phase 6：回归与发布
- 全量测试 + 装配审计 + 真实启动验证（规则 23）。
- 升级版本，按规则 26/27 走发布流程。

## 9. 测试与验证

- 单元测试：contract 解析、decision、overengineering 正则、预算扣减、审计字段。
- 集成测试：mock 工具调用，验证 guard deny / pre-execute ask / approval allowed-once；总开关关闭时不触发任何新逻辑。
- 装配审计：`node scripts/audit-mount-consistency.mjs --profile web`。
- 运行时验证：真实启动 web profile，确认不崩、设置页总开关可切换、`/guard mode` 在开启/关闭时行为正确。
- 回归：现有 `npm test` 全绿。

## 10. 回滚方案

- 代码回滚：git revert 到升级前 tag；或恢复备份 tgz。
- 装配回滚：若改过 profile 依赖/bundles，先备份 `profiles/web/package.json` 和 `cordis.patch.yml`，再移除变更。
- 配置回滚：新增配置项全部可选，默认关闭；异常时恢复默认配置。
- 审计：每次变更前按规则 13A 备份。

## 11. 已采纳的用户反馈与待确认

### 已采纳
1. **新增总开关**：在规则引擎设置页增加「任务边界与反过度工程」总开关，默认关闭；关闭后不产生任何新弹窗/新拦截，保持现有行为。
2. **观察模式优先**：反过度工程规则默认 `observe`，只审计提醒；只有用户主动开启总开关并切到 `armed` 才真正拦截。
3. **弹窗默认关闭**：`askEnabled` 默认 `false`；即使总开关打开，也不弹窗。需要确认的动作在 `armed` 下按配置“拒绝”或“仅记录”，超时默认拒绝。

### 仍需确认
1. 是否按 Phase 0-6 全部实施，还是先做 Phase 1-2 最小闭环？
2. 是否允许新增 `/guard mode`、`/guard budget`、`/guard contract`、`/guard label` 命令（总开关关闭时无效）？
3. 设置页新增总开关和子开关是否按上述默认值（全部默认关闭/观察）？
4. 升级方案文档已更新：`D:\DeepSeek harness\dsh-project\projects\oss\dsh-rule-engine\UPGRADE-PLAN-2026-08-20.md`
