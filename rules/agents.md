# Agent Orchestration

The session model is the **orchestrator**: it writes specs, dispatches agents,
reads their reports, makes judgment calls, and integrates. It does not read
large amounts of code, bulk-refactor, or write docs itself. There is no
orchestrator agent file — it is the main session.

## Roles

Model per role is pinned in each agent's frontmatter.

| Agent | Model | Writes | Use for | Never does |
|-------|-------|--------|---------|------------|
| scout | haiku | – | Find files, symbols, call sites. Returns `path:line` only. | Read whole files, propose fixes |
| researcher | sonnet | scratch only | Establish facts from docs/source/URLs with citations. | Edit project files, recommend unasked |
| builder | opus | project files | Implement a clear spec, run the verify command. | Expand scope, review itself |
| refuter | opus | – | Review the diff, rerun the verify command, return ACCEPT / REWORK. | Edit anything, trust a summary |
| debugger | opus | scratch only | Root cause with repro evidence. | Apply the fix |

**Only the builder edits project files, and only one builder runs at a time.**

## Do it yourself when

Spawning costs more than doing for: a one-line fix, a single grep or glob, a
file under ~100 lines, or an answer already in context. Do those inline.

Everything else goes through the builder — **including non-code deliverables**:
HTML, reports, templates, docs, generated assets. "No test exists" is not a
reason to build it yourself; `MUST VERIFY` is then a render, a lint, a link
check, or opening the file and confirming the required sections are present.
If you are about to Write a file over ~100 lines, stop and brief the builder.

## Sequential phases

Work runs one phase at a time. Parallel writers lose shared context and
collide; the quality loss is not worth the wall-clock gain.

1. Orchestrator writes the phase spec into a brief. `KNOWN FACTS` carries the
   previous phase's artifact **path**, not its contents.
2. Builder makes the change, writes the diff and verify output to `SCRATCH`,
   returns ≤25 lines.
3. Refuter reads the artifact and the real diff, reruns the verify command,
   returns the verdict.
4. Orchestrator reads verdict and path only. `ACCEPT` → update the handoff
   doc, dispatch the next phase. `REWORK` → same builder, findings pasted
   verbatim. Max 2 rework loops, then the orchestrator intervenes.
5. Never dispatch phase N+1 while phase N is unverified.

## Brief template

Every Agent call gets a brief in this shape. Fill every line; "n/a" is a valid
answer, silence is not.

```
GOAL: <one sentence, testable>
SCOPE: <exact files / dirs / URLs — nothing else>
MAY CHANGE: <files> | none
MUST VERIFY: <exact command or check>
DO NOT: <refactor, touch tests, read outside scope, install packages, ...>
KNOWN FACTS: <already established — do not rediscover>
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

Model per role is fixed in agent frontmatter. The Agent tool's `model` param
is for changing a single call — `sonnet` for a trivial, tightly-specified
builder phase, or a re-run one tier up — not for routine dispatch.

Escalate, don't start high: if a cheaper agent returns a low-confidence or
incomplete result, re-run that one task on a stronger model. Don't spend opus
on breadth: fan out with scouts, concentrate opus on the findings that matter.
Within one model family a weaker critic reviewing a stronger drafter is a
downgrade, not independence — the refuter is never weaker than the builder.
