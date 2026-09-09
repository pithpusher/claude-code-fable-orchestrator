// PreToolUse guard: keeps the main session in the orchestrator role.
// Subagents (payload has agent_id) are never restricted here — their own
// definitions and tool grants constrain them. Main session:
//   Agent  → Explore / Plan / general-purpose are denied; use the five roles.
//   Write  → project files over WRITE_MAX_LINES are denied; brief the builder.
//   Edit   → project-file edits whose new_string exceeds EDIT_MAX_LINES are denied.
// Scratchpad, HANDOFF.md, and anything under ~/.claude are always allowed.
const WRITE_MAX_LINES = 40;
const EDIT_MAX_LINES = 10;
const BANNED_AGENTS = new Set(["explore", "plan", "general-purpose"]);
const ROLES = "scout (locate), researcher (facts), builder (produce the file), refuter (verify), debugger (root cause)";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let p;
  try { p = JSON.parse(raw); } catch { return process.exit(0); }
  if (p.agent_id) return process.exit(0); // subagent: not our concern

  const norm = (s) => String(s || "").replace(/\\/g, "/").toLowerCase();
  const home = norm(process.env.USERPROFILE || process.env.HOME) + "/.claude/";
  const scratch = p.scratchpad_dir ? norm(p.scratchpad_dir) : "";
  const lines = (s) => (s ? String(s).split(/\r?\n/).length : 0);
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
      || f.startsWith(home) || /(^|\/)handoff\.md$/.test(f);
  };

  const t = p.tool_name, i = p.tool_input || {};
  if (t === "Agent") {
    const type = String(i.subagent_type || "").toLowerCase();
    if (BANNED_AGENTS.has(type)) {
      return deny(`Orchestrator guard: "${i.subagent_type}" is not one of the roles and runs on Opus at full context. Use ${ROLES}. In plan mode, use scout/researcher for exploration and write the plan yourself.`);
    }
    return process.exit(0);
  }
  if (t === "Write" && !exempt(i.file_path)) {
    const n = lines(i.content);
    if (n > WRITE_MAX_LINES) {
      return deny(`Orchestrator guard: Write of ${n} lines to a project file. The orchestrator does not produce deliverables — write the spec (conclusions, structure, MUST VERIFY) into a brief and dispatch the builder. Files under ${WRITE_MAX_LINES} lines, the scratchpad, HANDOFF.md, and ~/.claude are allowed.`);
    }
  }
  if ((t === "Edit" || t === "MultiEdit" || t === "NotebookEdit") && !exempt(i.file_path || i.notebook_path)) {
    const n = t === "MultiEdit"
      ? (i.edits || []).reduce((a, e) => a + lines(e.new_string), 0)
      : lines(i.new_string || i.new_source);
    if (n > EDIT_MAX_LINES) {
      return deny(`Orchestrator guard: ${t} inserting ${n} lines into a project file. One-line fixes are yours; anything larger is a builder brief with MAY CHANGE set to this file.`);
    }
  }
  process.exit(0);
});
