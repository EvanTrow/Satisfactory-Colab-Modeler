# Job 026: Blueprints (duplicable outposts)

**Phase:** 7 · Polish & deploy
**Status:** Not started
**Depends on:** 025 (end of Phase 6)

## Context

Read [`PLAN.md`](../PLAN.md) section **2. The Interaction Model to Reproduce → Outposts** row's blueprint description ("An outpost whose contents are *duplicable*. Put a limit on something inside to define one copy; the blueprint's calculated value is how many copies to build") and the **open question §10.3**: *"Confirm the copy count should participate in the same solve rather than being a post-multiply — it changes whether the container needs a variable in the solver."* This open question must be resolved (with the user, if still genuinely ambiguous after re-reading the docs) before implementation, since it changes the solver's architecture, not just this job's UI.

## Scope

In scope:
- Resolve the open question first: does the blueprint's copy count act as a solved variable inside `packages/solver` (Job 017/023), or as a post-hoc multiplier applied to a single-copy solve? Check whether an earlier job's Handoff notes already settled this (Job 013 built the `containers.kind: 'blueprint'` field and copiesLimit per the Job 007 schema, and may have left a note); if genuinely still open, use `AskUserQuestion`-equivalent judgement — for a worker sub-agent, this likely means flagging it clearly and picking the more conservative/correct option (participating in the same solve, since PLAN.md's phrasing leans that direction — "the blueprint's calculated value is how many copies to build" implies it's an *output* of solving, not an *input* multiplier) while documenting the decision loudly in Handoff notes.
- Blueprint creation: an outpost can be marked/converted to `kind: 'blueprint'`, using the `copiesLimit` field already in the Job 007 schema.
- "Define one copy" semantics: a limit placed on a node inside the blueprint defines the single-copy quantities; the solver computes the copy count needed to satisfy external demand.
- Solver integration in `packages/solver`: extend Basic/Full modes (and Manual, if applicable to its semantics) to treat a blueprint's copy count as a computed value, feeding it back into the per-copy internal quantities correctly (i.e. if 3 copies are needed, the blueprint's boundary ports carry 3× the single-copy rates).
- UI: visual distinction for blueprint containers (vs plain outposts) on canvas, and displaying the computed copy count on the blueprint node from the parent view.

Out of scope:
- Any further changes to non-blueprint outpost behavior (Job 013's plain-outpost behavior is untouched).

## Deliverables

- Blueprint creation/conversion UI.
- Solver changes in `packages/solver` implementing whichever copy-count semantics were resolved above, with tests proving the chosen behavior.
- Blueprint node visual + copy-count display.
- A clear, prominent note in this file's Handoff notes documenting how the §10.3 open question was resolved and why, since it's an architectural decision later work may need to revisit.

## Acceptance criteria

- Building a blueprint with an internal limit, connecting its boundary ports to external demand, and solving (Basic or Full) correctly computes and displays the required copy count, with internal per-copy quantities consistent with that count.
- The copy-count-as-solved-variable (or documented alternative) behavior is covered by a solver test in `packages/solver`.
- `pnpm --filter solver --filter web test` pass.

## Notes for the worker

- If the open question genuinely cannot be resolved confidently from the docs and prior job notes, stop and flag it rather than guessing silently — this is exactly the kind of architectural fork PLAN.md's open-questions section warns is "awkward to retrofit."
- When done, update this file's Status line and the row in [`INDEX.md`](../jobs/INDEX.md).
