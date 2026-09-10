// PreToolUse guard: keeps the main session in the orchestrator role.
// Subagents (payload has agent_id) are never restricted here — their own
// definitions and tool grants constrain them. Main session:
//   Agent  → Explore / Plan / general-purpose are denied; use the five roles.
//   Write  → project files over WRITE_MAX_LINES are denied; brief the builder.
//   Edit   → project-file edits whose new_string exceeds EDIT_MAX_LINES are denied.
//   Bash / PowerShell → commands that write a project file are denied.
// Scratchpad, HANDOFF.md, and anything under ~/.claude are always allowed.
const WRITE_MAX_LINES = 40;
const EDIT_MAX_LINES = 10;
const BANNED_AGENTS = new Set(["explore", "plan", "general-purpose"]);
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const ROLES = "scout (locate), researcher (facts), builder (produce the file), refuter (verify), debugger (root cause)";
const HOME_DIR = String(process.env.USERPROFILE || process.env.HOME || "");
const NULL_SINKS = new Set(["/dev/null", "$null", "nul"]);
const INTERPRETERS = "python3|python|py|node|ruby|perl|php|bash|sh|pwsh|powershell";
const WRITE_CALL = /open\s*\([^)]*['"][wa]['"]|write_text|writeFileSync|writeFile|appendFile|Out-File|Set-Content|Add-Content/i;
// A wrapped run — bash -c "...", powershell -Command '...' — is re-scanned as its own command.
const WRAPPER = /(?:^|[|;&]\s*)(?:bash|sh|zsh|pwsh|powershell)(?:\.exe)?\s+(?:-\S+\s+)*-(?:c|command)\s+("[^"]*"|'[^']*')/i;
const AWK_PROG = /(?:^|[|;&]\s*)(?:awk|gawk|mawk)\b[^'"]*('[^']*'|"[^"]*")/;
const GIT_OVERWRITE = /(?:^|[|;&]\s*)git\s+(?:-C\s+\S+\s+|-\S+\s+)*(?:restore\b(?![^|;&]*--staged\b)|checkout\b[^|;&]*\s--(?:\s|$)|reset\b[^|;&]*--hard\b|stash\s+(?:pop|apply)\b|clean\b[^|;&]*\s-\S*f)/i;
const MAX_DEPTH = 3;

const norm = (s) => String(s || "").replace(/\\/g, "/").toLowerCase();
const HOME = norm(HOME_DIR) + "/.claude/";
const lines = (s) => (s ? String(s).split(/\r?\n/).length : 0);
let scratch = "", cwd = "";

const deny = (reason) => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  }));
  process.exit(0);
};
const exempt = (file) => {
  const f = norm(file);
  // Fallback pattern so a missing scratchpad_dir never blocks scratch writes.
  return (scratch && f.startsWith(scratch)) || /\/temp\/claude\/.*\/scratchpad\//.test(f)
    || f.startsWith(HOME) || /(^|\/)handoff\.md$/.test(f);
};

// --- shell helpers: turn a command line into path tokens we can test ---
const strip = (s) => String(s).replace(/^["']|["']$/g, "");
const expand = (s) => s.replace(/^~(?=[\\/])/, HOME_DIR)
  .replace(/^\$HOME(?=[\\/])/, HOME_DIR).replace(/^%USERPROFILE%(?=[\\/])/i, HOME_DIR);
const okPath = (tok) => {
  const n = norm(expand(strip(tok)));
  if (NULL_SINKS.has(n)) return true;
  if (/^[a-z]:\//.test(n) || n.startsWith("/")) return exempt(n);
  return cwd ? exempt(cwd + "/" + n) : false; // relative with no cwd: assume project
};
const paths = (s) => s.split(/\s+/).map(strip)
  .filter((x) => x && !x.startsWith("-") && (/[\\/]/.test(x) || /^[\w.-]+\.[A-Za-z0-9]+$/.test(x)));
// A quoted arg is data (a sed script, a pattern) unless it carries a drive letter.
const qPaths = (s) => s.match(/["'][A-Za-z]:[\\/][^"']*["']/g) || [];
const sealed = (toks) => toks.length > 0 && toks.every(okPath);
const clean = (s) => s.replace(/2>&1|&>>?|2>\s*(?:\$null|\/dev\/null|nul)\b|>\s*(?:\$null|\/dev\/null|nul)\b|2>/gi, " ");
// Blank the inside of quoted runs, keeping length, so ">" in data is not read as syntax.
const mask = (s) => s.replace(/"[^"]*"|'[^']*'/g, (q) => q[0] + q.slice(1, -1).replace(/[^\n]/g, " ") + q[0]);
// Targets are located in the masked text, then read back from the original at the same offsets.
const redirects = (s, m) => {
  const out = [], re = /(?:^|[^-=<>&\d])>>?\s*("[^"]*"|'[^']*'|[^\s|;&<>]+)/g;
  let x;
  while ((x = re.exec(m))) out.push(s.slice(x.index + x[0].length - x[1].length, x.index + x[0].length));
  return out;
};
const writes = (s, m) => WRITE_CALL.test(s) || /\s>\s/.test(m);
const argsOf = (s, re) => { const x = re.exec(s); return x ? s.slice(x.index + x[0].length).split(/[|;&]/)[0] : ""; };
// The cmdlet name is read from masked text (a grepped literal is not a call); paths from the original.
const psWrite = (s) => /\|\s*(?:sc|ac)\b/.test(s) || /\b(?:Set-Content|Add-Content|Out-File)\b/i.test(s)
  || (/\bNew-Item\b/i.test(s) && !/-ItemType\s+(?!File\b)\w+/i.test(s));
const psFlagPaths = (s) => (s.match(/-(?:Path|FilePath|LiteralPath)[\s:=]+["']?[^"'\s]+/gi) || [])
  .map((x) => x.replace(/^-\w+[\s:=]+["']?/, ""));
const unquote = (s) => s.slice(1, -1).replace(/\\(["'$`\\])/g, "$1");
// awk hides its redirects inside the quoted program: awk '{print > "out.txt"}'
const awkWrite = (s) => {
  const prog = AWK_PROG.exec(s);
  if (!prog) return false;
  return (prog[1].match(/>>?\s*("[^"]*"|'[^']*')/g) || [])
    .map((x) => x.replace(/^>>?\s*/, "")).some((x) => !okPath(x));
};

// Returns the name of the rule a write-bearing command trips, or "" when clean.
const shellRule = (command, depth = 0) => {
  const cmd = clean(command), first = cmd.split(/\r?\n/)[0];
  const mcmd = mask(cmd), mfirst = mcmd.split(/\r?\n/)[0];
  const wrap = WRAPPER.exec(cmd);
  if (wrap && depth < MAX_DEPTH) {
    const inner = shellRule(unquote(wrap[1]), depth + 1);
    if (inner) return inner;
  }
  const heredoc = /<<-?\s*["']?[A-Za-z_]/.test(first);
  const toks = paths(cmd);
  for (const tgt of redirects(heredoc ? first : cmd, heredoc ? mfirst : mcmd)) if (!okPath(tgt)) return "redirect";
  if (heredoc && new RegExp(`\\b(?:${INTERPRETERS})\\b[^<]*<<`).test(first)
    && writes(cmd, mcmd) && !sealed(toks)) return "heredoc into an interpreter";
  if (awkWrite(cmd)) return "awk redirect";
  const iFlag = /(?:^|\s)(?:-i\S*|--in-place)(?:\s|=|$)/;
  if (/\b(?:sed|perl)\b/.test(cmd) && iFlag.test(mcmd)
    && paths(argsOf(mcmd, iFlag)).concat(qPaths(argsOf(cmd, iFlag))).some((x) => !okPath(x))) return "in-place edit";
  if (/(?:^|[|;&]\s*)(?:cp|mv|install|rsync|copy-item|move-item)\s/i.test(cmd)
    && toks.length && !okPath(toks[toks.length - 1])) return "copy or move";
  if (paths(argsOf(cmd, /(?:^|[|;&]\s*)tee\s/)).some((x) => !okPath(x))) return "tee";
  if (/\b(?:python3|python|py|node|ruby|perl|php)\b\s+(?:-\S+\s+)*-[ce]\b/.test(cmd)
    && writes(cmd, mcmd) && !sealed(toks)) return "inline script";
  const patching = /(?:^|[|;&]\s*)patch\s/.test(cmd);
  if ((patching || /(?:^|[|;&]\s*)git\s+(?:-\S+\s+\S+\s+)*apply\b/.test(cmd))
    && !/--check\b|--dry-run\b/.test(cmd) && !(patching && /\s-C(?:\s|$)/.test(cmd))) return "patch";
  if (GIT_OVERWRITE.test(mcmd)) return "git overwrite";
  if (psWrite(mcmd) && [...toks, ...psFlagPaths(cmd)].some((x) => !okPath(x))) return "PowerShell write cmdlet";
  return "";
};

const agentDenial = (i) => {
  const type = String(i.subagent_type || "").toLowerCase();
  if (!BANNED_AGENTS.has(type)) return "";
  return `Orchestrator guard: "${i.subagent_type}" is not one of the roles and runs on Opus at full context. Use ${ROLES}. In plan mode, use scout/researcher for exploration and write the plan yourself.`;
};

const editDenial = (t, i) => {
  if (t === "Write") {
    if (exempt(i.file_path)) return "";
    const n = lines(i.content);
    if (n <= WRITE_MAX_LINES) return "";
    return `Orchestrator guard: Write of ${n} lines to a project file. The orchestrator does not produce deliverables — write the spec (conclusions, structure, MUST VERIFY) into a brief and dispatch the builder. Files under ${WRITE_MAX_LINES} lines, the scratchpad, HANDOFF.md, and ~/.claude are allowed.`;
  }
  if (exempt(i.file_path || i.notebook_path)) return "";
  const n = t === "MultiEdit"
    ? (i.edits || []).reduce((a, e) => a + lines(e.new_string), 0)
    : lines(i.new_string || i.new_source);
  if (n <= EDIT_MAX_LINES) return "";
  return `Orchestrator guard: ${t} inserting ${n} lines into a project file. One-line fixes are yours; anything larger is a builder brief with MAY CHANGE set to this file.`;
};

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let p;
  try { p = JSON.parse(raw); } catch { return process.exit(0); }
  if (p.agent_id) return process.exit(0); // subagent: not our concern
  scratch = p.scratchpad_dir ? norm(p.scratchpad_dir) : "";
  cwd = p.cwd ? norm(p.cwd).replace(/\/+$/, "") : "";

  const t = p.tool_name, i = p.tool_input || {};
  if (t === "Agent") {
    const reason = agentDenial(i);
    return reason ? deny(reason) : process.exit(0);
  }
  if (EDIT_TOOLS.has(t)) {
    const reason = editDenial(t, i);
    if (reason) return deny(reason);
  }
  if (t === "Bash" || t === "PowerShell") {
    const rule = shellRule(String(i.command || ""));
    if (rule) {
      return deny(`Orchestrator guard: ${t} would write a project file (${rule}). The main session does not produce deliverables by any tool. Write a builder brief with MAY CHANGE set to that file. Scratchpad, HANDOFF.md, ~/.claude, and /dev/null are allowed.`);
    }
  }
  process.exit(0);
});
