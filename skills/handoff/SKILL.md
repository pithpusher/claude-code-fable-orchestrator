---
name: handoff
description: Use when ending a session, before context compaction, at a plan milestone, or when the user says "handoff", "save progress", or "resume". Writes or reads the project handoff doc so a fresh session can continue from the file instead of rebuilding context.
---

# Handoff

Path: `<project root>/.claude/HANDOFF.md`. Overwrite it; do not append.

## Writing (end of session, milestone, or before compaction)

Write these sections, max 60 lines total. The orchestrator writes this directly — do not spawn an agent for it.

```
# Handoff — <project> — <date>

## Goal
One or two lines.

## Decisions (with why)
- decision — reason

## Done
- item (verified how)

## Not done / next step
- the single next action, concrete enough to start without reading anything else
- remaining items after that

## Open questions
- anything blocked on a person or an unverified assumption

## Verify
<the command that proves the current state is green>
```

## Reading (start of session, or user says "resume")

Read the file, run the Verify command, and restate the next step in at most 3 lines. Do not re-derive what the file already settles.
