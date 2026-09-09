// test/helpers.js - 测试辅助：临时 DSH_HOME
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setLexicons } from "../lib/core/lexicon.js";
import { setPatterns } from "../lib/core/patterns.js";

// 残余1 剥离后（2026-08-31）：本机回归测试夹具需注入默认偏好表（模拟本机配置 handlerDefaultMap）——
// 代码层默认表已下沉配置，测试经此表绑定执行器（与真实环境守门 consistency-live 读配置口径一致）
export const TEST_DEFAULT_MAP = {
  "1": "rule1-retry",
  "2": "rule2-time",
  "5": "rule5-source",
  "7": "rule7-promise",
  "9": "rule9-inline-bom",
  "11": "rule11-language",
  "12A": "rule12a-approval",
  "12B": "rule12b-skill",
  "12C": "rule12c-network",
  "13A": "rule13a-backup",
  "18": "rule18-manual-first",
  "21": "rule21-meta",
  "22": "rule22-7-direct",
  "23": "rule23-runtime-verify",
  "24": "rule24-assembly-type",
  "26": "rule26-release-asset",
  "27": "rule27-mount-audit"
};

// P8 小批 A（2026-09-08）：中文行为词表测试夹具。
// 内置默认已改为通用最小集（语言无关，随 npm 包发布）；本机中文词表经 rule-engine.json.lexicons 注入。
// 既有回归测试全部基于中文样本 → 测试入口统一注入本夹具，与真实环境（本机 json 已注入同表）口径一致。
// 维护约定：本表 = 迁移前 lexicon.js 11 张表的逐字快照；改词表请同步本机 rule-engine.json.lexicons。
export const TEST_LEXICONS_ZH = {
  approval: "(?:确认|同意|批准|授权|可以|允许|好|行|ok|yes)",
  exec_follow: "(?:即可|现在|马上|继续|开始|执行|落盘|去做|实施|进行|删除|修改|改|补|修|做|写入|创建|安装|发布|下载|提交|运行)",
  plan_only: "确认方案|确认理解|确认方向|确认无误|理解了|明白方向|了解|没问题|收到",
  action_words: "执行|跑|落|落盘|认可|开始|写入|写(?:下|好|完|成|作|文件)?|保存|另存为|删除|修改|改(?:为|成|动|一下|进|善)?|补(?:上|齐|全|充|写)?|修(?:改|复|一下)?|做(?:好|完|一下)?|创建|建(?:设|立|好|一下|个|一个)?|安装|发布|下载|提交|推送|push|运行|修复|替换|重建|启动|重启|停止|卸载|开始改|开始写|改进|优化|增强|完善|升级|迁移|整理|调整|实现|实施|添加|增加|补充|重写|改造|调试|排查|处理|解决|继续|推进|更新|部署|核实|梳理|诊断|对齐|跟进|落实|设计并实现|调查|开工|动手|进行|完成|选择|采纳|选定|产出|编写|撰写|生成|审查|阅读|查看|核对|检查|审阅|复核|查阅|验证|对照|调研|研究|转化|转换|读取|读(?:出|一下|一遍|完|出来)?|展示|打开|提取|还原|导入|导出|清理|移除|清空|残留|合入|合并|并入|融合|整合|起草|开展|搭建|重构|兼容|投产|校验|核验|过一遍|跑一遍|复验",
  strong_exec: "执行吧|开始执行|直接执行|立即执行|现在执行|马上执行|请落盘|开始写|开始改|执行以下|执行第|执行这个|执行它|落盘|开始蒸馏|开始迁移|开始修复|开始改进|开始优化|采纳|选定",
  directive: "(?:请\\s*)?(?:删除|移除|修改|编辑|替换|写入|写(?:下|好|完|成|作|文件)?|保存|另存为|创建|复制|移动|执行|运行|下载|提交|推送|备份|安装|卸载|清理|启动|停止|重建|修复|改(?:为|成|动|一下)?|补(?:上|齐|全|充|写)?|修(?:改|复|一下)?|做(?:好|完|一下)?|实施|推进|继续|处理|解决)",
  rejection: "(?:不允许|拒绝|不要|不同意|取消(?:这次|并停)?|(?:^|[^是])否(?:[^则]|$)|no(?!tes?|thing|pe)\\b|\\bno\\b|No)",
  question: "[？?]|吗|为什么|是否|能不能|行不行|难道|是不是|能否|怎么|为何|是否要|影响吗|可以吗|要不要|需不需要",
  status_signal: "(?:我已|我已经|我(?:们)?(?:刚)?(?:重启|输入|执行|完成|搞定|做完|弄好|输完|输好))(?:了|完毕|完成|好)?|(?:^|\\s)(?:已|已经)?(?:重启|输入|执行|完成|搞定|做完|弄好|输完|输好|unlock)(?:了|完毕|完成|好)?(?:\\s|$)|(?:^|\\s)已经(?:刚)?(?:重启|输入|执行|完成|搞定|做完|弄好|输完|输好|unlock)[^\\s]*(?:\\s|$)|(?:^|\\s)(?:重启|输入|命令|操作)(?:完成|完毕|好了|已输入)(?:\\s|$)|(?:^|\\s)好了(?:\\s|$)|^(?:done|restarted|finished|entered)$",
  dangerous_action: "删除|覆盖|移除|清空|卸载|remove-item|rm\\s+-r|del\\s+"
};

/** 注入中文词表夹具（返回 setLexicons 的 {applied, rejected} 明细；测试入口调用一次即可） */
export function useChineseLexicons() {
  return setLexicons(TEST_LEXICONS_ZH);
}

// P8 小批 B（2026-09-08）：检测正则测试夹具（迁移前 patterns.js 16 张表的逐字快照）。
// 内置默认 = 语言无关最小集；本机中文检测正则经 rule-engine.json.patterns 注入。
// 维护约定：改检测词表请同步本机 rule-engine.json.patterns。
export const TEST_PATTERNS_ZH = {
  time_words: "今天|昨天|前天|上周|本周|刚才|\\d+\\s*分钟前",
  historic_date:
    "\\d{1,2}\\s*月\\s*\\d{1,2}\\s*日|\\d{4}\\s*年\\s*\\d{1,2}\\s*月\\s*\\d{1,2}\\s*日|20\\d{2}[-/.]\\d{1,2}[-/.]\\d{1,2}",
  evidence_mark:
    "日志\\s*(?:ts|时间戳)|mtime|启动时间|进程\\s*StartTime|文件\\s*修改时间|来源[:：]|ts\\s*[:＝]|Get-Date\\s*输出|事件时间已核实|【时间未核实】|\\b[0-9a-f]{7,40}\\b|\\bv\\d+(?:\\.\\d+){1,2}\\b|踩坑\\s*\\d+|版本(?:记录)?\\s*v\\d+(?:\\.\\d+){1,2}",
  promise_words: "包在我身上|肯定能|绝对没问题|保证(?!不|无法)|一定可以|放心(?:，|,)?肯定|万无一失",
  source_mark: "来源|出处|via|source|reference|引自|参考",
  domain_words: "DSH|dsh|插件|技能|规则|配置|迁移|手册|会话|装配|profile|bundle",
  plan_instruction: "方案|调整|补充|建议|评估|草案|完善|优化|改进|提炼|重构|梳理",
  write_instruction: "落盘|写入|发布|正式写入|正式落盘|改为|改成|保存到手册|写进手册|确定为|确认后(?:落盘|写入|发布)",
  execute_action: "执行|推进|实施|开始|落实|继续|启动|办理|开展|落地|操作|运行",
  tech_term:
    "\\b(?:API|JSON|REST|WebSocket|OAuth|JWT|ORM|Schema|SSR|CSR|DI|Docker|Kubernetes|K8s|npm|pnpm|Node\\.js|TypeScript|Git)\\b|正则(?:表达|表达式)?|异步|回调|闭包|哈希|令牌|中间件|依赖注入|虚拟DOM|虚拟 DOM|数据库|SQL|序列化|反序列化|面向对象|函数式|类型推断|泛型",
  term_explanation: "例如|比如|即\\b|就是|简单说|换言之|类比|也就是说|通俗|直白|理解为|打个比方|举个例子",
  suggest_words: "我建议|建议用|推荐|更优方案|建议(?:是|考虑|换成|用|来)|档位建议|不如换|优化建议",
  negating_suggestion:
    "(?:不再|不重复|避免|停止|取消|暂不|未再|不要(?:再)?|以后(?:不|别)|今后(?:不|别)|已呼应|已回应|无(?:新)?(?:建议|重复)|没有(?:新)?(?:建议|重复)|只等待)",
  paraphrase_before:
    "(?:用户|你|他|她|它|对方|作者|维护者|客户|大家|网友|某人|群友|别人).{0,6}?(?:说|说过|表示|提到|提到过|称|强调|认为|写道|原话)",
  paraphrase_mark_before: "引述|引用|原文|转述|转发|据\\S{0,5}说|写过|改成|改为|换成",
  paraphrase_mark_after: "改成|改为|换成|转述|引用",
  // 小批 C（A″ 批评检测）：强形态语言无关（与本机配置同值，显式声明便于复核）；弱形态=迁移前中文表
  criticism_shape: "(?:[？?]{3,}|[!！]{4,})",
  criticism_weak:
    "(?:怎么(?:又|还|居然|仍然|老是|总)?[^，。！？]{0,14}(?:了|呢|啊|？|!|！)?|你(?:又|还|居然|咋|怎么)[^，。！？]{0,12}(?:了|呢|啊|吧)?|(?:又|还|总是|老是|仍然|居然)[^，。！？]{0,12}(?:了|呢|啊|吧)?|这(?:不|有点|根本|完全|哪)?(?:对|行|合理|应该|像话)(?:吧|么|吗|啊|呢)?|你(?:是不是|难道|难道说|该不会)[^，。！？]{0,10}(?:了|呢|吧)?|(?:搞什么|干什么|什么情况|怎么回事|搞砸|搞错了|犯什么错))",
  // A″ 反向检查（第三批）：消息含明确执行指令词 → 弱信号只留痕不注入提示
  exec_directive: "写|更新|执行|提交|落盘|修改|新增|修复|实现|创建|删除|发布|下载|推送|运行|实施|落实|重写|重构|改(?:为|成|一下)|补(?:上|齐|全|充|写)",
  // 规则激活词（小批 B 第一小域）：matcher.js 情境匹配
  activate_skill: "技能|skill",
  activate_approval: "执行|创建|删除|覆盖|移动|下载|提交|配置",
  activate_network: "下载|网络|curl|境外|clash",
  activate_backup: "删除|覆盖|迁移|备份",
  activate_time: "时间|今天|昨天|日期",
  activate_promise: "保证|肯定|承诺",
  activate_source: "引用|来源|URL|链接",
  delivery_claim: "(?:已完成|全部(?:[^\\s，。；！？]{0,12})完成|已[^\\s，。；！？]{0,8}完成|修复完成|落盘完成|验证[^\\s，。；！？]{0,6}(?:通过|成功)|全部通过|全部[^\\s，。；！？]{0,10}通过|已通过|已修复|搞定)(?:\\s*了|!|！|，[^。]*)?(?![^。]*(?:尚未|没有|未|没|还没|未完|待做|待完成))",
  internal_ref: "(?:手册|踩坑\\s*\\d+|条款\\s*\\d+|第\\s*\\d+\\s*章|SKILL\\.md|AGENTS\\.md|源码|README|文档[^\\n]{0,12}(?:写了|记载|记录|写明|说明))",
  verify_intent: "(?:验证|查证|核对|目标|交叉|对照|确认)",
  empty_talk: "我记下了|记住了|收到，我记下了|放心，我记住了",
  delivery_no_verify: "完成|交付",
  verify_evidence: "运行时验证|mock|启动|实测|测试|验证",
  mount_mention: "重启|装配|挂载",
  mount_audit_ok: "审计通过|全量审计|MOUNT CONSISTENT|DUPLICATES FOUND|audit-mount-consistency",
  scope_overreach: "(?:我补充|顺便补充|额外补充|我增加|顺便加|额外加|多加|自行纳入)",
  scope_bounded: "仅按勾选|只实现被选项|未选项|单独确认|再次征求",
  apology_only: "(?:抱歉|对不起|我错了|这是我的错|失误)",
  apology_with_cause: "(?:原因|改正|防再犯|避免|机制|解法|修正)",
  version_record_mention: "版本记录|v\\d+\\.\\d+",
  version_record_only: "已记入版本记录|版本记录已|只加了版本记录|只加版本记录",
  version_sync_ok: "正文|同步|无需同步|无需改正文"
};

/** 注入中文检测正则夹具（返回 setPatterns 的 {applied, rejected} 明细） */
/** 条款自证触发词（映射型夹具；与本机 rule-engine.json.patterns.self_cert_hints 同源） */
export const TEST_SELF_CERT_HINTS_ZH = {
  "14": "总结|汇报|完成",
  "22": "我记下了|记住了|收到，我记下了|放心，我记住了",
  "23": "完成|交付",
  "16": "建议|优化|更优方案|推理档位|档位",
  "12E": "重启|GUI|登录|界面|窗口",
  "26": "(?=发布|Release|附件)(?!(?:Attach binaries|正式 Asset|release\\.assets))",
  "10": "新会话|旧会话|旧项目|上下文恢复",
  "12C": "下载|网络|curl|Clash|被墙",
  "13B": "会话文件|会话修复|fromRestore|Inbox 回放|孤儿扫描",
  "15": "文件版本|文件用途|新旧|版本.*处置|保留文件",
  "19": "学到新.*DSH|踩到新坑|踩坑.*沉淀|手册有误|知识必沉淀",
  "28": "新建.*文件|放入.*目录|工作区.*归类",
  "29": "依赖闭包|node_modules.*验证|动过.*node_modules",
  "30": "变更验证|验证证据|不破坏.*依赖",
  "31": "撞(?:了)?南墙|撞墙|盲试|乱撞|连续盲试"
};

/** 注入中文检测正则夹具（返回 setPatterns 的 {applied, rejected} 明细） */
export function useChinesePatterns() {
  return setPatterns({ ...TEST_PATTERNS_ZH, self_cert_hints: TEST_SELF_CERT_HINTS_ZH });
}

export function makeTempHome() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-rule-engine-test-"));
  process.env.DSH_HOME = dir;
  return dir;
}

export function writeAgents(dir, text) {
  const file = join(dir, "AGENTS.md");
  writeFileSync(file, text, "utf8");
  return file;
}

export function cleanupTempHome(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  delete process.env.DSH_HOME;
}
