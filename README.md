# dsh-rule-engine

DSH 规则执行引擎 v3 的 host 插件实现。它把 `~/.dsh/AGENTS.md` 当作唯一真相源，
自动解析规则四要素与执行等级，再通过「工具守卫 + 文本检测 + 时序检查 + 审计台账」
执行用户规则，而不是内置一套与用户无关的安全清单。

## 功能分层

- 阶段 1 容器：解析 AGENTS.md 全部规则 → 理解产物（`rule-understanding.json` 可生成）
- 阶段 2 匹配机 + 工具守卫 + 文本检测
- 阶段 3 时序检查 + 授权询问集成
- 阶段 4 D 级自证调度 + `/guard` 命令完善

当前实现以「模式库兜底」为主，LLM 理解器预留扩展点；所有规则均从 AGENTS.md 实时解析。

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
| `/guard reload` | 强制重解析 AGENTS.md |

## 开发

```bash
npm test
bash scripts/build.sh
```

## 装配方式（重要）

本插件是 `dsh.plugin` 普通 host 插件，**不要**加入 `dsh.profile.bundles`（会因缺少 `dsh.bundle` 导致 DSH 启动崩溃）。
正确挂载方式是在 `profiles/<profile>/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: dsh-rule-engine
      name: 'dsh-rule-engine'
```

前提是 `profiles/<profile>/node_modules/dsh-rule-engine` 可解析（dependencies 里的 link 或实际安装均可）。

## 安全设计

- 只读操作（read/grep/glob/read_image/str_replace_editor view）无条件放行，拦截只针对变更类操作
- 插件自身配置/理解产物对模型只读：直接 `edit/write` 会被守卫拒绝，需 `/guard unlock`
- AGENTS.md mtime 变化后自动重解析（2 秒节流），规则增删改无需重启
- 低置信规则不参与硬拦，避免误伤；在 `/guard rules` 中标记人工复核
- 授权证据按“操作类型 + 目标路径前缀”结构化匹配，区分“询问”与“授权”
- 备份证据按“目标路径 → 备份路径”记录，删除/覆盖前必须存在对应路径的备份
- 版本/手册类文件写后自检：版本号连续、append 不覆盖上一行，失败自动回滚并审计
- 跨工具一致性：同一敏感操作经 `edit` 与 `pwsh` 必须得到相同拦截/放行结论
- 命令输出静默错误检测：全 false/0/null 或与上一条完全一致时审计 + 注入提醒，不阻断
- 技能目录实时联动：`ctx.skills` 目录变化后自动刷新，已禁用/不存在的技能不触发 12B
- LLM 增量理解：对非 high 置信规则调用 `ctx.llm` 补全结构化理解，失败自动回退模式库
- D 级自证泛化：按规则特征触发自证提示，每规则每会话限 3 次
- 授权记录默认 10 分钟 TTL，可用 `/guard revoke` 撤销全部授权
- 用户直接命令式指令（如“删除这个文件”）也视为授权
- 备份证据校验“备份文件真实存在”，仅字符串映射不算数
- 规则 1 支持“用户明确要求重试”豁免
- `str_replace_editor` 非 view 命令已纳入敏感写操作统一守卫，防止绕过 edit/write 检查
- 会话状态有容量上限并自动清理，防止长跑内存膨胀
- LLM 理解按“规则 + AGENTS.md mtime”去重，避免重复烧 token
- AGENTS.md 使用 `fs.watch` 即时监听，stat 轮询保留为兜底
- 版本号提取只匹配 `| vX.Y |` 表格行，不扫全文；表头插入合法编辑不再被误回滚
- Copy-Item 路径解析支持带引号/空格路径，解析失败时不记录脏备份；13A 判定侧同样支持引号含空格路径
- 修复 pwsh 备份记录重复问题：同一命令只记录一次
- 复制到“尚不存在”的新目标文件时跳过 13A 备份要求（创建新文件非覆盖）
- 只有备份到 `.bak/.backups/trash-` 的 Copy-Item 才记录为备份证据；普通覆盖目标文件的 Copy-Item 不产生错误方向的备份记录
- 备份证据只在工具调用成功后记录，被拦截/失败的调用不产生备份记录
- 授权类型对齐：Copy-Item 到 `.bak/.backups/trash-` 推断为 `backup`，与“备份”授权匹配
- ask 授权记录为宽泛类型 `any` + 路径前缀，避免问题文本措辞导致类型错位；无路径的全局授权 TTL 缩短为 2 分钟
- version-guard 删除/缩短编辑（new_string 为 old_string 子串）放行，版本连续性校验仍兜底
- 授权为内存态（重启失效），`/guard status` 和授权描述中明确提示
- 审计日志：`~/.dsh/rule-engine.log.jsonl`
- 守卫使用 `ctx.tools.guard()` 单调拒绝，模型无法自行绕过
- 运行时验证通过后才可部署（规则 23）
