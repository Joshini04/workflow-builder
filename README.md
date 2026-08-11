# AI Agent Workflow Builder

A mini n8n-style workflow builder for chaining AI agent steps, built on nhost (Postgres + Hasura + Auth + Functions) and Next.js.

## Live App
https://workflow-builder-amber-one.vercel.app/

## Tech Stack
- nhost (Postgres, Hasura GraphQL Engine, Auth, Serverless Functions)
- Next.js (App Router, no TypeScript, Tailwind)
- Apollo Client for GraphQL queries/mutations/subscriptions
- OpenRouter (nvidia/nemotron-nano-9b-v2:free) for real LLM calls in `llm_call` steps

## Setup / Run Locally

1. Clone the repo:
git clone https://github.com/Joshini04/workflow-builder.git
cd workflow-builder

2. Install dependencies:
npm install

3. This project connects to a live nhost backend (subdomain `jkuorcpxuwjzxfxsnuri`, region `ap-south-1`) — the subdomain/region are hardcoded in `lib/nhost.js`, so no local environment variables are needed for the frontend to run.

4. Run the dev server:
npm run dev

5. Open `localhost:3000` and sign in (see test credentials below).

## Backend Functions (nhost)

Located in `/functions`:
- `triggerWorkflowRun.js` — Hasura Action handler; checks caller's org role (owner/editor) and org quota before starting a run
- `processWorkflowRun.js` — processes one workflow step per invocation (works around nhost's 10-second function execution limit); chained via a Hasura Event Trigger (`process_next_step`) that fires on `step_runs` status updates
- `approveStep.js` — Hasura Action handler; checks the approver's role before resuming a paused run

These require environment variables set in the nhost dashboard: `MY_HASURA_GRAPHQL_URL`, `MY_HASURA_ADMIN_SECRET`, `MY_OPENROUTER_API_KEY`. If `MY_OPENROUTER_API_KEY` is not set, `llm_call` steps fall back to a stubbed response with an artificial delay.

## Hasura Metadata

Full exported metadata (schema, relationships, both permission layers) is in `/hasura/metadata.json`.

## Test Accounts

| Org | Email | Password | Role |
|---|---|---|---|
| TestOrg | joshifinal@testorg.com | TestPass123! | owner |
| OrgB | ownerb@orgb.com | TestPass123! | owner |

## Known Limitations / Scope Decisions

- Workflow creation itself is currently done via seed data / directly in Hasura; the frontend's workflow builder (`/workflows/[id]`) supports adding, reordering, and deleting steps on an existing workflow, but not creating a brand-new workflow from scratch.
- The `workflow_triggers` table exists with full permission rules, but isn't yet exposed in the frontend UI for attaching/configuring triggers visually — trigger *execution* itself is fully proven via manual (dashboard button) and webhook (direct Action call) triggers.
- Scheduled/cron and database-event trigger types are not implemented — manual and webhook satisfy "at least one trigger type beyond manual."
- The `notify` step type is currently a stubbed response rather than a dedicated Hasura Event Trigger.
- Occasionally, the free-tier OpenRouter LLM API response time exceeds the function's 10-second execution limit on a single step, causing that specific run to stall with no retry recorded; retrying with a new run resolves it. This is an external API latency constraint, not a logic bug.
