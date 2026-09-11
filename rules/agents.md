# Agent Orchestration

Two modes, picked by the session model:

- **Fable → lean orchestrator.** Writes specs, dispatches agents, verifies,
  and integrates. It does not read large amounts of code, bulk-refactor, or
  write deliverables itself. A guard hook enforces this on Fable only.
- **Opus / Sonnet / Haiku → hands-on lead.** Works directly, consults a Fable
  advisor at decision points, and delegates only when it keeps the session
  context small. No hook.

There is no orchestrator agent file. It is the main session.

## Roles

Defined in `~/.claude/agents/`. Model per role is pinned in the agent's
frontmatter.

| Agent | Model | Writes | Use for | Never does |
|-------|-------|--------|---------|------------|
| scout | haiku | – | Find files, symbols, call sites. Returns `path:line` only. | Read whole files, propose fixes |
| researcher | sonnet | scratch only | Establish facts from docs/source/URLs with citations. | Edit project files, recommend unasked |
| builder | opus | project files | Implement a clear spec, run the verify command. | Expand scope, review itself |
| refuter | opus | – | Review the diff, rerun the verify command, return ACCEPT / REWORK. | Edit anything, trust a summary |
| debugger | opus | scratch only | Root cause with repro evidence. | Apply the fix |

**One writer at a time.** On Fable, only the builder edits project files.

Prefer `scout` over the built-in `Explore`, and write plans yourself instead
of dispatching `Plan`. Both built-ins inherit the session model (Explore is
capped at Opus) instead of running on scout's Haiku. On Fable
the hook denies them.

## Fable: do it yourself when

Spawning costs more than doing for: a one-line fix, a single grep or glob, a
file under ~100 lines, or an answer already in context. Do those inline.

Everything else goes through the builder, **including non-code deliverables**:
HTML, reports, templates, docs, generated assets. "No test exists" is not a
reason to build it yourself; `MUST VERIFY` is then a render, a lint, a link
check, or opening the file and confirming the required sections are present.
One brief per feature, not per file.

A PreToolUse hook (`~/.claude/hooks/orchestrator-guard.js`) enforces this when
the session model is Fable: `Write` over 40 lines and `Edit` inserting over 10
lines to project files are denied, Bash and PowerShell commands that write
project files are denied, and the built-in `Explore`, `Plan`, and
`general-purpose` agents are denied. Scratchpad, `HANDOFF.md`, and
`~/.claude` are exempt.

"It's analysis, not implementation" is not an exception. For a memo, report,
or valuation the orchestrator writes the **conclusions and structure as a
spec** (bullets, numbers, the argument) and the builder writes the prose.

## Verify

1. After the builder returns, the orchestrator runs `MUST VERIFY` itself in
   one call and reads only failures and the summary:
   `… 2>&1 | grep -E "FAIL|ERROR|Error|passed|failed" | tail -20`.
2. Fail → re-brief the same builder once, failure output pasted verbatim.
   Fails again → the orchestrator intervenes.
3. The next step starts only after the current one verifies.
4. If the orchestrator touches the deliverable afterward, it reruns
   `MUST VERIFY`. The file that ships is the file that was checked.

**Refuter triggers.** Dispatch the refuter only for: security, auth,
payments, or user data; data migrations or deletions; a change across more
than ~5 files; or when the user asks. Otherwise do not dispatch it.

## Opus / Sonnet sessions

Work directly. A subagent starts cold at about 37k tokens, so delegate only
when it clearly saves context:

- Keep single greps, globs, and reads inline.
- Unknown location needing more than ~5 searches or many file reads → scout.
- Web or doc facts → researcher.
- Bulk mechanical edits across many files → builder with `model: "sonnet"`.
- Hard bug with no known cause → debugger.
- Send same-type dispatches back to back; prefer one larger brief over
  several small ones.

Same refuter triggers. Otherwise run the verify command yourself.

**Advisor.** A Fable advisor (`advisorModel: "fable"`) is configured for Opus
and Sonnet sessions. Call it after orientation and before substantive work,
before declaring a multi-step task done (save the result first), and when
stuck. About two calls per task, never on most turns. Weigh its advice
seriously and surface conflicts in one reconcile call. A Fable session does
not call the advisor.

## Brief template

Every Agent call gets a brief in this shape. `n/a` is a valid answer.

```
GOAL: <one sentence, testable>
SCOPE: <exact files / dirs / URLs — nothing else>
MAY CHANGE: <files> | none
MUST VERIFY: <exact command or check>
DO NOT: <refactor, touch tests, read outside scope, install packages, ...>
KNOWN FACTS: <already established, and previous artifact paths — not contents>
OUTPUT: <format from the agent definition>, max <N> lines
SCRATCH: <absolute scratchpad path> — anything longer goes here; return the path
```

## Concurrency

Parallel is allowed only for read-only agents (scout, researcher, refuter,
debugger) and for side work in a separate directory where no conflict is
possible. Never two writers. A second builder waits.

## Batching

Fixes that touch the same large file go into one builder brief. Do not spawn
N builders that each reread the same 2k-line file.

## Output discipline

Agent reports obey the line caps in their definitions. Anything over ~40 lines
goes to a scratch file; the next agent gets the path, not the content.
Orchestrator replies to the user stay short unless detail is asked for.

## Stopping agents

If an interim result or report shows the agent left scope, stop it
(`TaskStop`) and re-brief. Do not let it finish "to see what happens".

## Handoff

At each milestone, before context runs low, and at session end, write the
handoff doc via the `handoff` skill. A new session resumes from that file, not
from a rebuilt context.

## Model tiers

Escalation and cost rules live in `performance.md`. The Agent tool's `model`
param is for escalating a single re-run, or for `sonnet` on bulk mechanical
edits in Opus/Sonnet sessions, not for routine dispatch.
