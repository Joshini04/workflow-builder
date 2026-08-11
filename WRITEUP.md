# Write-up: AI Agent Workflow Builder

## Schema Reasoning

The schema follows the org → members → workflows → steps/triggers, workflow → runs → step_runs relationship chain described in the spec. `organizations` holds quota tracking (`quota_used` / `quota_limit`) at the org level since quota is a shared resource across all workflows in that org, not per-workflow. `org_members` is a join table between `auth.users` and `organizations` carrying the `role` column (owner/editor/viewer) — this is the single source of truth for both permission layers, since every permission check (Hasura row-level or in-code) traces back to this table.

`workflow_steps` stores step `type` and `config` as JSONB, keeping step definitions flexible without needing a new column per step type. `step_runs` is the execution record — one row per step per run, carrying `status`, `input`, `output`, `error`, `attempt_count`, plus `approved_by`/`approved_at` specifically for approval-gate steps. Separating `workflow_steps` (the definition) from `step_runs` (the execution history) lets a workflow be run many times while keeping each run's step-by-step history intact and independently queryable — this is also what the live subscription queries against.

An `org_usage_summary` Postgres view aggregates run counts and average run duration per org, satisfying the aggregation requirement without needing to denormalize that data onto `organizations` itself.

## Two Permission Layers

**Layer 1 (org + role scoping)** is enforced entirely through Hasura row-level permissions. Every select/insert/update/delete permission on every table includes a check that traces through relationships back to `org_members`, filtering on both `role` and `user_id = X-Hasura-User-Id`. This means an `editor` in Org A literally cannot construct a query that returns Org B's data — the check happens at the database layer, not in application code, so it can't be bypassed by hitting the GraphQL API directly or guessing IDs.

**Layer 2 (step-level gating)** is enforced two ways depending on whether the action is a simple row mutation or a stateful process:
- For `workflow_steps` inserts/updates and `workflow_triggers` inserts/updates, Hasura's permission `check` conditions include an additional clause beyond org/role scoping — e.g. `editor` role is blocked from inserting rows where `type` is `db_write` or `notify`, and from `workflow_triggers` rows where `trigger_type` is `webhook`. This is still declarative (a Hasura permission), but adds a business-rule condition on top of the org check.
- For the approval-gate resume, a database permission alone isn't sufficient because approving is a *decision*, not just a row write — it requires checking the approver's specific role against the org at that moment, tied to the state of a specific `step_runs` row (`status = 'paused'`). This logic lives in the `approveStep` Action handler itself: it looks up the step's org via relationships, checks the caller's `org_members` role explicitly in code, and only then updates the row and resumes the run. This satisfies the requirement that step-level gating be "enforced in the Action handler, not just assumed."

## Approval-Gate Pause/Resume Implementation

When `processWorkflowRun` reaches a step of type `approval_gate`, it creates a `step_runs` row with `status: 'paused'` and sets the parent `workflow_runs.status` to `'paused'`, then stops — no further steps execute. The frontend's live subscription on `step_runs` (filtered by `workflow_run_id`) picks up this paused state immediately and renders a "Waiting for approval" UI with an Approve button.

Clicking Approve calls the `approveStep` Action, which (after the role check described above) updates the step's status to `'success'` and sets `workflow_runs.status` back to `'running'`. That status update on `step_runs` is what a Hasura Event Trigger (`process_next_step`) listens for — it fires automatically, invoking `processWorkflowRun` again, which detects the newly-succeeded step and continues to the next one in the workflow (or marks the run `'completed'` if it was the last step). This chaining approach — one step per function invocation, continued via event triggers rather than an in-memory loop — was necessary because nhost serverless functions have a hard 10-second execution limit regardless of trigger type; the original implementation tried to process an entire workflow synchronously in one call and would be killed mid-run whenever the LLM API responded slowly.
