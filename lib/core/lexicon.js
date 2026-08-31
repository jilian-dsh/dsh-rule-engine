// lexicon.js - 规则 22 语义判定的唯一词表源（0.5.11，用户拍板"唯一词表源由引擎维护"）。
// 背景（2026-08-28 全量审查）：正文曾手抄词表（L144/148），引擎内部 intent.js 与 authorization.js
// 又各写一份（许可词在 authorization 出现 3 次：AUTH_WORDS_RE/APPROVAL_RE/APPROVAL_EXEC_RE）——
// 同语义多处定义 = 漂移根源。本文件 = 五表唯一源：
//   ① 执行许可词表（许可词 + 执行语，两者缺一才不构成许可）
//   ② 执行动作词表（意图/授权判定共用）
//   ③ 疑问词表（问询分点判定）
//   ④ 状态信号词表（"我已重启/好了/done"等，状态信号不触发无执行分点）
//   ⑤ 豁免工具清单（规则 22 ③ "只读/展示/ask/todo_write 等豁免"的明细）
// 调用方（intent.js/authorization.js）一律从这里 import，禁止再定义第二份。
// 设计原则：词表可以在，但只能有一份；语义变更改这里，正文措辞改 AGENTS.md，二者成对。

// ── ① 执行许可词表 ──
// 许可词：用户确认/同意/批准/授权/可以/允许/好/行/ok/yes 等 + 执行语（即可/现在/马上/…）
// 组合规则：许可词 [0,16 字符内] 执行语 → 构成执行许可；纯"确认方案/理解/方向"不构成。
export const APPROVAL_WORDS_RE = /(?:确认|同意|批准|授权|可以|允许|好|行|ok|yes)/i;
export const EXEC_FOLLOW_RE = /(?:即可|现在|马上|继续|开始|执行|落盘|去做|实施|进行|删除|修改|改|补|修|做|写入|创建|安装|发布|下载|提交|运行)/i;
export const APPROVAL_EXEC_RE = new RegExp(
  APPROVAL_WORDS_RE.source.replace(/\\\//g, "/") +
  "[^\\n]{0,16}" +
  EXEC_FOLLOW_RE.source.replace(/\\\//g, "/"),
  "i"
);
// 纯方案/理解/方向确认（不构成执行授权）
export const PLAN_ONLY_RE = /确认方案|确认理解|确认方向|确认无误|理解了|明白方向|了解|没问题|收到/i;

// ── ② 执行动作词表（intent.ACTION_RE / authorization.EXEC_ACTION_RE 的合并唯一源）──
// 注意：单一表同时服务"意图判定"（这句话是不是执行分点）与"ask 结果批准判定"（选择=批准），
// 语义一致，不另分裂；新增动作词只改这里。
export const ACTION_WORDS_RE =
  /执行|跑|落|落盘|认可|开始|写入|写(?:下|好|完|成|作|文件)?|保存|另存为|删除|修改|改(?:为|成|动|一下|进|善)?|补(?:上|齐|全|充|写)?|修(?:改|复|一下)?|做(?:好|完|一下)?|创建|建(?:设|立|好|一下|个|一个)?|安装|发布|下载|提交|推送|push|运行|修复|替换|重建|启动|重启|停止|卸载|开始改|开始写|改进|优化|增强|完善|升级|迁移|整理|调整|实现|实施|添加|增加|补充|重写|改造|调试|排查|处理|解决|继续|推进|更新|部署|核实|梳理|诊断|对齐|跟进|落实|设计并实现|调查|开工|动手|进行|完成|选择|采纳|选定|产出|编写|撰写|生成|审查|阅读|查看|核对|检查|审阅|复核|查阅|验证|对照|调研|研究|转化|转换|读取|读(?:出|一下|一遍|完|出来)?|展示|打开|提取|还原|导入|导出|清理|移除|清空|残留|合入|合并|并入|融合|整合|起草|开展|搭建|重构|兼容|投产|校验|核验|过一遍|跑一遍|复验/i;

// 强执行语（直接执行指令，不等授权确认——用于意图置信提升）
export const STRONG_EXEC_RE =
  /执行吧|开始执行|直接执行|立即执行|现在执行|马上执行|请落盘|开始写|开始改|执行以下|执行第|执行这个|执行它|落盘|开始蒸馏|开始迁移|开始修复|开始改进|开始优化|采纳|选定/i;

// 指令式动作词（用户命令式指令 = 视为授权执行；与批准词不同源、用途不同）
export const DIRECTIVE_WORDS_RE =
  /(?:请\s*)?(?:删除|移除|修改|编辑|替换|写入|写(?:下|好|完|成|作|文件)?|保存|另存为|创建|复制|移动|执行|运行|下载|提交|推送|备份|安装|卸载|清理|启动|停止|重建|修复|改(?:为|成|动|一下)?|补(?:上|齐|全|充|写)?|修(?:改|复|一下)?|做(?:好|完|一下)?|实施|推进|继续|处理|解决)/i;

// 拒绝词（授权/批准判定用）
export const REJECTION_WORDS_RE = /(?:不允许|拒绝|不要|不同意|取消(?:这次|并停)?|(?:^|[^是])否(?:[^则]|$)|no(?!tes?|thing|pe)\b|\bno\b|No)/i;

// ── ③ 疑问词表（问询分点判定；authorization.isQuestionMessage 同源）──
export const QUESTION_WORDS_RE =
  /[？?]|吗|为什么|是否|能不能|行不行|难道|是不是|能否|怎么|为何|是否要|影响吗|可以吗|要不要|需不需要/;

// ── ④ 状态信号词表（"我已重启/已输入/好了/done"；触发时不判"无执行分点"）──
export const STATUS_SIGNAL_WORDS_RE =
  /(?:我已|我已经|我(?:们)?(?:刚)?(?:重启|输入|执行|完成|搞定|做完|弄好|输完|输好))(?:了|完毕|完成|好)?|(?:^|\s)(?:已|已经)?(?:重启|输入|执行|完成|搞定|做完|弄好|输完|输好|unlock)(?:了|完毕|完成|好)?(?:\s|$)|(?:^|\s)已经(?:刚)?(?:重启|输入|执行|完成|搞定|做完|弄好|输完|输好|unlock)[^\s]*(?:\s|$)|(?:^|\s)(?:重启|输入|命令|操作)(?:完成|完毕|好了|已输入)(?:\s|$)|(?:^|\s)好了(?:\s|$)|^(?:done|restarted|finished|entered)$/i;
// 危险动作词：命中则不当作状态信号（防"我已删除了某文件"被当成就绪确认）
export const DANGEROUS_ACTION_WORDS_RE = /删除|覆盖|移除|清空|卸载|remove-item|rm\s+-r|del\s+/i;

// ── ⑤ 豁免工具清单（规则 22 ③ "只读/展示/ask/todo_write 等豁免"明细）──
// 只读/展示/询问/产物类工具在"无执行分点"回合也可调用（引擎 tool-catalog 的 analysis/artifact 分类
// 为总开关；本清单 = 规则正文"等豁免"所指的可枚举集，与 tool-catalog 一致，此处集中注释成对）。
export const EXEMPT_TOOL_NAMES = new Set([
  // 只读/查询
  "read", "grep", "glob", "read_image",
  // 视觉分析
  "vision_describe", "vision_detect", "vision_ground", "vision_colors", "vision_ocr", "vision_bootstrap",
  // 状态查询
  "job_list", "job_output", "list_agents", "get_goal", "schedule_list",
  "engram_recall", "engram_detail", "engram_model",
  "esr_status", "esr_ready", "esr_model",
  // 网络只读
  "web_fetch", "web_search",
  // 询问/展示/产物
  "ask_user_question", "todo_write", "visualize", "report",
  // inspect 只读
  "cordis_inspect_list", "cordis_inspect_query", "cordis_inspect_self"
]);
