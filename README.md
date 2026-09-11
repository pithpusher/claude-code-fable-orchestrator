# claude-code-fable-orchestrator

**Fable as the orchestrator, cheaper models as the workers.** A Claude Code plugin with five subagents — scout (Haiku), researcher (Sonnet), builder (Opus), refuter (Opus), debugger (Opus) — two session modes, a brief template for every agent call, and a `/handoff` skill so a new session resumes from a file instead of rebuilding context. On Fable, the session plans, dispatches, and verifies; it never reads whole codebases or writes deliverables. On Opus or Sonnet, it works directly and hands off only searches, research, and bulk edits. The recommended default is an **Opus session with a Fable advisor**, which Anthropic measured at 3.5 points above Opus alone for slightly less money.

```
/plugin marketplace add pithpusher/claude-code-fable-orchestrator
/plugin install claude-code-fable-orchestrator@pithpusher
```

## Contents

- [Install](#install)
- [Workflow and model selection, start to finish](#workflow-and-model-selection-start-to-finish)
- [The advisor: Fable at decision points](#the-advisor-fable-at-decision-points)
- [Enforcement: the guard hook](#enforcement-the-guard-hook)
- [Which model should each Claude Code subagent use?](#which-model-should-each-claude-code-subagent-use)
- [How delegation works](#how-delegation-works)
- [How do I keep Fable's context light?](#how-do-i-keep-fables-context-light)
- [Trim the base context](#trim-the-base-context)
- [What a subagent costs](#what-a-subagent-costs)
- [Does parallel multi-agent work hurt quality?](#does-parallel-multi-agent-work-hurt-quality)
- [The brief template](#the-brief-template)
- [Claude Code settings that control subagent models](#claude-code-settings-that-control-subagent-models)
- [FAQ](#faq)
- [Prior art](#prior-art)
- [Origin and credits](#origin-and-credits)

## Install

1. Add the marketplace and install the plugin (agents + `/handoff` skill):

   ```
   /plugin marketplace add pithpusher/claude-code-fable-orchestrator
   /plugin install claude-code-fable-orchestrator@pithpusher
   ```

2. Copy the orchestration rule — plugins can't ship rules, so this one step is manual:

   ```bash
   cp rules/agents.md ~/.claude/rules/fable-orchestrator.md
   ```

3. Merge [`settings.snippet.json`](settings.snippet.json) into `~/.claude/settings.json`:

   ```json
   {
     "model": "opus",
     "advisorModel": "fable",
     "fallbackModel": ["sonnet"],
     "env": { "CLAUDE_CODE_SUBAGENT_MODEL": "sonnet" }
   }
   ```

   For the Fable-conducted mode instead, set `"model": "claude-fable-5-1"` and leave `advisorModel` out.

4. Turn on the output style — it puts the orchestrator contract in the system prompt, where it outranks rules files:

   ```json
   { "outputStyle": "Orchestrator" }
   ```

5. Restart Claude Code. Confirm the "Advisor Tool (experimental) is on" notice appears. Ask it to dispatch each of `scout`, `researcher`, `builder`, `refuter`, `debugger` on a trivial task. Then run `/model fable`, ask it to write a 50-line file directly, and confirm the hook denies it.

No MCP servers, no background processes. Five agents, one skill, one rule, one output style, and one hook.

## Workflow and model selection, start to finish

The recommended default is an **Opus session with a Fable advisor**. Opus does the work, and Fable weighs in at the two moments that decide the outcome.

| Step | Who does it | Model | Why this model |
|---|---|---|---|
| Session | main session | Opus 5 | Strong enough to write production code directly, and cheaper per turn than Fable |
| Orient | main session, or scout past ~5 searches | Opus 5 / Haiku 4.5 | A subagent cold-starts at ~37k tokens, so small lookups stay inline |
| Facts from docs or the web | researcher | Sonnet 5 | Retrieval with citations doesn't need Opus |
| Plan | main session, advisor consulted once | Opus 5 + Fable 5.1 | The first advisor call, before the approach sets, is where it adds the most |
| Small edits | main session | Opus 5 | Spawning costs more than doing |
| A whole feature | builder | Opus 5 | Keeps the session's context small on long work |
| Bulk mechanical edits | builder with `model: "sonnet"` | Sonnet 5 | Renames and codemods don't need Opus |
| Verify | main session, one filtered command | Opus 5 | One turn instead of a reviewer agent |
| Review | refuter, only on risk triggers | Opus 5 | Security, auth, payments, user data, migrations, deletions, changes over ~5 files |
| Stuck | advisor, then debugger | Fable 5.1, then Opus 5 | A second opinion first, then a root-cause hunt if that doesn't unstick it |
| Done check | advisor, after the result is saved | Fable 5.1 | The second of about two advisor calls per task |
| Milestones | `/handoff` | – | A new session resumes from a file |

**Fable-conducted alternative.** When Fable quota is plentiful, set `model` to `claude-fable-5-1`. The session becomes a lean orchestrator: the builder writes every deliverable, and the guard hook enforces that. A Fable session uses no advisor, because no model is stronger.

| Step | Who | Model |
|---|---|---|
| Plan, specs, judgment | main session | Fable 5.1 |
| Locate / facts | scout / researcher | Haiku 4.5 / Sonnet 5 |
| Every deliverable | builder | Opus 5 |
| Verify | main session, one command | Fable 5.1 |
| Review | refuter, triggers only | Opus 5 |

## The advisor: Fable at decision points

Claude Code's [advisor tool](https://code.claude.com/docs/en/advisor) lets the session model consult a stronger model mid-task. Set it once:

```json
{ "model": "opus", "advisorModel": "fable" }
```

What Anthropic measured, in [*Optimizing for cost and intelligence*](https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence):

- **Opus 5 + Fable 5.1 advisor** was the most accurate configuration on an internal agentic-coding benchmark: **3.5 points above Opus 5 alone, for slightly less money.** Good early advice cuts dead-end exploration, which pays for the consultations. Claude Code's advisor mode showed the same ordering.
- **Sonnet 5 + advisor** closes at least half the gap to the stronger model when it keeps consulting. At low effort it can stop consulting and score below Sonnet alone. It is not reliably better than Opus alone.
- **It loses when consulted on most tasks.** On one benchmark the pairing matched Fable alone at 2.6 times the cost, because the advisor fired almost every time.

How the output style keeps it on the winning side:

- About **two calls per task**: one after orientation and before substantive work, one before declaring done with the result already saved. Extra calls only when stuck.
- No calls on short reactive tasks.
- A line addressed to the advisor asks for guidance under 150 words, since advisor output is its largest cost.
- Effort stays at the default or higher. Lower effort makes the session stop consulting.

An Opus main accepts a Fable advisor; a Fable main accepts only Fable. The advisor rereads the whole conversation on every call, uncached. Toggling it doesn't invalidate the session's prompt cache, unlike `/model`. Fable 5.1 as advisor needs Claude Code 2.1.257 or later, and `/advisor` in the desktop app needs 2.1.260 or later.

## Enforcement: the guard hook

Rules are advice, and a strong orchestrator will argue its way past advice — five test runs showed Fable building the deliverable itself whenever the task felt like "analysis." So the plugin ships a `PreToolUse` hook that makes the contract mechanical for the **main session only** (subagents are never restricted — their own tool grants constrain them):

| Main-session call | Result |
|---|---|
| `Agent` with `Explore`, `Plan`, or `general-purpose` | denied — use the five roles |
| `Write` over 40 lines to a project file | denied — brief the builder |
| `Edit` inserting over 10 lines into a project file | denied — brief the builder |
| Bash or PowerShell that writes a project file (heredoc, redirect, `sed -i`, `cp`, `tee`, inline `python -c` / `node -e`, `Set-Content`, `bash -c "…"` wrappers, awk `>`) | denied — brief the builder |
| `git restore`, `checkout -- <path>`, `reset --hard`, `stash pop`, `clean -f` | denied — these overwrite project files |
| Anything in the scratchpad, `HANDOFF.md`, or `~/.claude` | allowed |

**Fable only.** The hook enforces nothing unless the session model is Fable. Hook input carries no model field, so it reads the transcript's newest assistant entry or `/model` switch, falling back to `model` in `settings.json`. Plan on Fable, `/model opus`, and the same session executes with no restrictions. The rule file and output style carry the same scope line.

The denial message tells the orchestrator what to do instead. It is a pattern match on the command text, not a sandbox. Known gaps: a script that lives in the scratchpad but writes into the project, in-place edits wrapped in `find -exec` or `xargs`, wrappers prefixed with `env` or `nohup`, and deletions (`rm`). The output style tells the orchestrator those are the same violation.

## Which model should each Claude Code subagent use?

| Agent | Model | Can edit project files | Job | Never does |
|-------|-------|:---:|-----|------------|
| `scout` | Haiku 4.5 | – | Find files, symbols, call sites. Returns `path:line` + one line of context, never file bodies. | Read whole files, propose fixes |
| `researcher` | Sonnet 5 | – | Establish facts from docs, source, or URLs, with citations. Unverifiable → `UNVERIFIED:`. | Edit project files, recommend unasked |
| `builder` | Opus 5 | **yes** | Implement a clear spec in the listed files, run the verify command, report the diff. | Expand scope, review itself |
| `refuter` | Opus 5 | – | Read the real diff, rerun the verify command itself, return `ACCEPT` / `REWORK`. | Edit anything, trust a summary |
| `debugger` | Opus 5 | – | Root cause with reproduction evidence and a proposed fix. | Apply the fix |
| *session on Fable* | Fable 5.1 | one-liners only | Lean orchestrator: write specs, dispatch, verify, integrate. | Read large code, bulk refactor, write deliverables |
| *session on Opus / Sonnet* | Opus 5 / Sonnet 5 | yes | Hands-on lead: do the work, delegate searches, research, and bulk edits. | Dispatch agents for work it can do in a few calls |

**Only the builder has the `Edit` tool, and only one builder runs at a time.** That single constraint is what makes "never two agents editing the same files" enforceable instead of aspirational.

The orchestrator does trivial things itself — a one-line fix, a single grep, a file under 40 lines. Spawning an agent for those costs more than doing them. The guard hook draws the same line mechanically.

## How delegation works

```mermaid
flowchart LR
    O[Session<br/>Fable] -->|spec + brief| B[builder<br/>Opus]
    B -->|≤25-line report<br/>+ artifact path| O
    O -->|reruns verify itself,<br/>reads the tail| O
    O -.->|only on triggers| R[refuter<br/>Opus]
    O -.->|locate| S[scout<br/>Haiku]
    O -.->|facts| Re[researcher<br/>Sonnet]
    O -.->|root cause| D[debugger<br/>Opus]
```

**On Fable (lean orchestrator):**

1. The session writes the spec into a brief, one brief per feature. `KNOWN FACTS` carries the previous artifact's **path**, not its contents.
2. The builder makes the change, runs the verify command, and returns ≤25 lines.
3. The session reruns the verify command itself in one call and reads the last 20 lines. On failure it re-briefs the same builder once with the output, then intervenes.
4. The refuter runs only for security, auth, payments, or user data; migrations or deletions; changes across more than ~5 files; or on request.
5. The next step never starts while the current one is unverified.

**On Opus or Sonnet (hands-on lead):** the session reads and edits directly. It sends unknown-location searches to the scout, doc or web facts to the researcher, bulk mechanical edits to the builder with `model: "sonnet"`, and hard bugs to the debugger. The refuter triggers are the same.

Earlier versions ran the refuter on every phase. That cost 50–60k tokens per phase on top of the builder, which often made the loop more expensive than plain prompting. Verifying with one command costs one turn.

## How do I keep Fable's context light?

Three mechanisms, all enforced by the agent definitions rather than by hoping:

- **Output caps.** Every agent has a max-lines rule in its definition (scout 40, builder 25, refuter 30). Anything longer goes to a scratch file and the agent returns the path.
- **Artifact paths, not contents.** The next phase's brief references the previous artifact by path. The orchestrator never holds two phases' worth of diff in context.
- **Verify tails, not diffs.** The orchestrator runs the verify command once and reads the last 20 lines. It doesn't read the diff.
- **Few Fable turns.** Every Fable tool call re-reads the whole context. So the plan file is written once, briefs cover a whole feature, and the session never audits its own transcript.

Plus `/handoff`: at milestones and before context runs low, the orchestrator writes `.claude/HANDOFF.md` (goal, decisions with reasons, done, next step, open questions, verify command; ≤60 lines, overwritten not appended). A fresh session reads it and restates the next step in three lines.

## Trim the base context

Every turn re-reads the full system prompt. A fresh session measured about 102k tokens before the first word. That includes every enabled plugin's skill descriptions, every connector's tool names, and any plugin that injects text at session start.

- **Claude Code plugins:** set unused ones to `false` in `enabledPlugins` in `~/.claude/settings.json`, and re-enable per project in `.claude/settings.json`. Plugins with session-start injections cost the most.
- **App plugins** (legal, sales, marketing, …): turn off in the Claude app's plugin settings.
- **claude.ai connectors:** disconnect the ones you don't use in Claude Code at claude.ai → Settings → Connectors.

## What a subagent costs

A subagent starts with a fresh context. Measurements across 1,777 subagents in [anthropics/claude-code#74318](https://github.com/anthropics/claude-code/issues/74318) put the cold start at about 37k tokens, 97% of it static: system prompt, tool schemas, project rules. A same-type sibling dispatched within five minutes hit the cache about 85% of the time. One with no recent sibling hit it about 45% of the time.

So keep single greps and reads inline, and delegate only work that would take more than a handful of tool calls. Send same-type dispatches back to back, and prefer one larger brief over several small ones.

## Does parallel multi-agent work hurt quality?

For **writing**, yes. Parallel builders lose shared context, produce integration seams, and collide on files. The evidence points one way:

- Cognition, [*Don't Build Multi-Agents*](https://cognition.ai/blog/dont-build-multi-agents) — parallel subagents making decisions without shared context produce conflicting work.
- Anthropic, [*How we built our multi-agent research system*](https://www.anthropic.com/engineering/built-multi-agent-research-system) — parallelism paid off for breadth-first *reading*; coding was explicitly harder to parallelize.
- Cemri et al., [*Why Do Multi-Agent LLM Systems Fail?*](https://arxiv.org/abs/2503.13657) (MAST) — a taxonomy where most failures are specification and inter-agent misalignment, not model capability.
- GitHub's [Project HydraFusion](https://github.blog/ai-and-ml/github-copilot/project-hydrafusion-frontier-quality-via-multi-model-orchestration/) — multi-model orchestration beat Opus 5 on one benchmark and regressed 1.5 points on DeepSWE.

So this plugin allows parallelism only for **read-only** agents (scout, researcher, refuter, debugger) and for side work in a separate directory where no conflict is possible. Writing is sequential. If you're not willing to trade quality for cost or wall-clock, this is the setting that matters.

One more thing this gets right that most "spawn a critic" setups get wrong: **a weaker critic reviewing a stronger drafter is a downgrade, not independence.** Genuine critique independence needs a different model family. Within one family, the reviewer must be at least as strong as the writer — so the refuter is Opus, same as the builder.

## The brief template

Every `Agent` call gets a brief in this exact shape. Fill every line; `n/a` is a valid answer, silence is not.

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

The agent definitions each specify their output format, so `OUTPUT` usually just says "your standard format, max 20 lines".

## Claude Code settings that control subagent models

Four layers, most specific wins:

```
Agent tool `model` param  >  agent frontmatter `model:`  >  CLAUDE_CODE_SUBAGENT_MODEL  >  session model
```

| Setting | Where | What it does |
|---------|-------|--------------|
| `model:` in agent frontmatter | `~/.claude/agents/<name>.md` | Pins one agent. Accepts `haiku`, `sonnet`, `opus`, `fable`, `inherit`, or a full model ID. This plugin pins all five. |
| `CLAUDE_CODE_SUBAGENT_MODEL` | `env` block in `settings.json` | Default for every subagent with no `model:` — including built-in `Explore`/`Plan` and other plugins' agents. |
| `model` | `settings.json` | The session model. `opus` in the recommended setup, `claude-fable-5-1` for the Fable-conducted mode. |
| `advisorModel` | `settings.json` | The model the session consults at decision points. `fable` here. It must be at least as capable as the session model. |
| `fallbackModel` | `settings.json` | Availability failover when the session model is overloaded. Not a quality cascade. |
| `availableModels` | `settings.json` | Hard allowlist. An agent pinned to a model outside it inherits the parent model instead. Also trims your `/model` picker. |

The `model` param on the `Agent` tool is for changing a single call — `sonnet` for a trivial, tightly-specified builder phase, or a re-run one tier up. Not for routine dispatch.

## FAQ

**Why is the builder on Opus and not Sonnet?**
Because the refuter no longer runs on every step, the builder's first draft is usually what ships. If you'd rather trade quality for cost, change one line in `agents/builder.md` (`model: sonnet`); the refuter stays Opus either way.

**Doesn't delegation cost more tokens than just prompting?**
It can. Every agent starts cold. The old always-on refuter reread everything the builder wrote. Delegation pays off when it moves many-turn reading and writing off the expensive session model. For a one-file fix, do it inline, which is what both modes say.

**Is Sonnet with an advisor better than Opus alone?**
Not reliably. In Anthropic's measurements an advisor closes at least half the gap to the stronger model when the session keeps consulting it, but a Sonnet session at low effort can stop consulting. The pairing Anthropic measured above Opus alone is Opus with a Fable advisor.

**Can I use this without Fable?**
Yes. On Opus or Sonnet the session runs in hands-on lead mode: it works directly and delegates searches, research, and bulk mechanical edits. The guard hook only enforces on Fable.

**Why Haiku for the scout?**
Scouting is `grep`/`glob` with a strict "locations only" output. It's the one role where the cheapest model is genuinely enough, and it runs often.

**Does this replace `/plan` or the built-in `Explore` and `Plan` agents?**
No. It adds five agents alongside them. `CLAUDE_CODE_SUBAGENT_MODEL=sonnet` also drops `Explore`/`Plan` to Sonnet, which is usually what you want.

**Where do scratch files go?**
The `SCRATCH` line in each brief. Claude Code exposes a per-session scratchpad directory; use that path. Researcher and debugger may only write there; builder writes its artifact there.

**How is this different from HydraFusion or other model routers?**
Those route *per request* with a learned policy. This routes *per role* with a fixed pin, and puts the cost/quality bet in one place (builder + refuter both Opus). No runtime router exists in Claude Code; this is the closest static equivalent.

**Why not ship the rule inside the plugin?**
Plugins can install agents, skills, commands, hooks and MCP servers. They don't install rules files, so `rules/agents.md` is a one-time copy.

## Prior art

Others have built the same idea. Worth reading before you pick:

- [fable-baton](https://github.com/realgarit/fable-baton): Fable orchestrates Haiku, Sonnet, and Opus agents, enforced by a session-start policy, a per-prompt reminder, and a counter that nudges after four inline tool calls. Its own benchmark is honest: total cost came out about the same or higher with orchestration, while Fable's own output tokens dropped 38–44%. Delegation spreads load across quotas more than it cuts total tokens.
- [claude-code-orchestra](https://github.com/DeL-TaiseiOzaki/claude-code-orchestra): Claude Code orchestrating Sonnet and Opus subagents, with Codex CLI for planning and Fable as a rare escalation tier.
- [fable-advisor](https://github.com/DannyMac180/fable-advisor): keeps day-to-day work on other vendors' models and calls Fable at decision points.
- [fable5-opus5-orchestrator](https://github.com/Rylaa/fable5-opus5-orchestrator) and [claude-code-workflow-orchestration](https://github.com/barkain/claude-code-workflow-orchestration): larger agent sets with requirements ledgers and workflow graphs.

What this repo does differently: a hard `PreToolUse` deny on Fable instead of nudges, two session modes keyed to the model, the refuter only on risk triggers, and Anthropic's measured advisor pairing as the default.

## Origin and credits

The role split — Fable orchestrates, Haiku scouts, Sonnet researches, Opus refutes — comes from [*How I use subagents without burning through Fable*](https://www.reddit.com/r/ClaudeCode/comments/1wbc03f/how_i_use_subagents_without_burning_through_fable/) on r/ClaudeCode. This repo turns it into installable agent definitions, adds the strictly-sequential rule and the artifact-path pattern, and makes the refuter rerun verification itself.

## License

MIT
