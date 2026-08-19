// verify-guard4.mjs —— 拆解 isSensitiveToolCall 的每个条件
import { commandText } from "../lib/core/patterns.js";

const cmd = `$env:HTTPS_PROXY = "http://127.0.0.1:7890"; $env:HTTP_PROXY = "http://127.0.0.1:7890"; gh release create v0.4.1 "D:\\DeepSeek harness\\dsh-project\\projects\\oss\\dsh-rule-engine\\dsh-rule-engine-0.4.1.tgz" --repo jilian-dsh/dsh-rule-engine --title "dsh-rule-engine v0.4.1" --notes "## v0.4.1

- Rule 9 PS7 semantics: BOM hard-block narrowed to explicit -Encoding utf8BOM; utf8/utf8NoBOM (no BOM) allowed; removed the PS5.1-era Chinese-.ps1-must-have-BOM check
- P0-1: write-target extraction reads only the adjacent argument of -Path/-Destination (variable targets no longer capture unrelated later paths)
- P0-1b: 2>&1 / 2>$null no longer treated as write redirects (read-only commands touching protected filenames were mis-blocked)
- version-guard: allow same-line inline version changes (README badge updates)
- disabled-rules sync with dsh-rules-manager
- LLM incremental understanding after AGENTS.md changes (deduped)
- unified home resolution via @deepseek-ai/dsh-home-paths; audit log lazy trim; update-check fetch timeouts"`;

const SENSITIVE_CMD = /(?:git\s+(?:push|commit)|remove-item|rm\s+-r|rmdir\s+\/s|rd\s+\/s|del\s+\/s|move-item|rename-item|copy-item\s+[^\n]*?(?:-\s*force|overwrite))/i;
const PROTECTED = /(?:AGENTS\.md|settings\.yaml|\.credentials\.yaml|workspace\.json|cordis\.patch\.yml|rule-understanding\.json|rule-engine\.json)/i;

console.log("SENSITIVE_CMD:", SENSITIVE_CMD.test(cmd));
console.log("PROTECTED:", PROTECTED.test(cmd));
if (PROTECTED.test(cmd)) {
  const m = cmd.match(/(?:AGENTS\.md|settings\.yaml|\.credentials\.yaml|workspace\.json|cordis\.patch\.yml|rule-understanding\.json|rule-engine\.json)/i);
  console.log("  matched:", m[0], "at index", m.index);
}
// writeTargetPathsFromCommand 的写类动词检测
const WRITE_VERB = /(?:set-content|add-content|out-file|writealltext|new-item|remove-item|clear-content)/i;
console.log("WRITE_VERB:", WRITE_VERB.test(cmd));
if (WRITE_VERB.test(cmd)) console.log("  matched:", cmd.match(WRITE_VERB)[0]);
const MUTATING = /(?:Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|Rename-Item|New-Item|Clear-Content|git\s+(?:push|commit)|rm\s+-r|rmdir\s+\/s|del\s+\/s|(?:^|[^0-9])>>|(?:^|[^0-9])>)/i;
console.log("MUTATING:", MUTATING.test(cmd));
if (MUTATING.test(cmd)) console.log("  matched:", cmd.match(MUTATING)[0]);
