# Codex working agreement

## Model routing

Use the repository-scoped agents in `.codex/agents/` for every non-trivial code
implementation task.

1. If architecture, interfaces, or acceptance criteria are unresolved, delegate
   a bounded read-only design task to `architect` (`gpt-5.6-sol`, high).
2. Once the plan is settled, delegate implementation and verification to
   `implementer` (`gpt-5.6-terra`, medium).
3. After verification passes, delegate a bounded read-only diff review to
   `reviewer` (`gpt-5.6-sol`, high).
4. Send mechanical review fixes back to `implementer`. Escalate to `architect`
   only when a finding requires changing the approved design.

Do these stages sequentially. Do not run multiple write-capable agents against
the same worktree at once. The user may override this routing for a specific
task.

Do not invoke `architect` when an accepted plan already defines scope,
interfaces, acceptance criteria, and tests. For VS Code Phase 5 work, treat
`docs/vscode-migration-plan.md` as the accepted plan once it is present.

Documentation-only changes, typo fixes, status checks, and user questions do
not require the three-stage workflow unless the user explicitly requests it.

## Token discipline

- Keep Sol tasks read-only and narrowly scoped.
- Return concise handoffs instead of full exploration logs.
- Use Terra for repository search, implementation, routine test execution, and
  mechanical fixes.
- Avoid parallel subagents when the goal is cost reduction rather than elapsed
  time.
