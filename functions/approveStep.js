import { GraphQLClient, gql } from 'graphql-request';

const client = new GraphQLClient(process.env.MY_HASURA_GRAPHQL_URL, {
  headers: { 'x-hasura-admin-secret': process.env.MY_HASURA_ADMIN_SECRET },
});

const GET_STEP_RUN = gql`
  query GetStepRun($step_run_id: uuid!) {
    step_runs_by_pk(id: $step_run_id) {
      id
      status
      workflow_run_id
      workflow_run {
        workflow_id
        workflow {
          org_id
        }
      }
    }
  }
`;

const CHECK_ROLE = gql`
  query CheckRole($org_id: uuid!, $user_id: uuid!) {
    org_members(where: { org_id: { _eq: $org_id }, user_id: { _eq: $user_id } }) {
      role
    }
  }
`;

const APPROVE_STEP_RUN = gql`
  mutation ApproveStepRun($id: uuid!, $approved_by: uuid!) {
    update_step_runs_by_pk(pk_columns: { id: $id }, _set: {
      status: "success", approved_by: $approved_by, approved_at: "now()"
    }) { id }
  }
`;

const RESUME_RUN = gql`
  mutation ResumeRun($id: uuid!) {
    update_workflow_runs_by_pk(pk_columns: { id: $id }, _set: { status: "completed" }) { id }
  }
`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const step_run_id = req.body.input?.step_run_id;
  const userId = req.body.session_variables?.['x-hasura-user-id'];

  if (!step_run_id || !userId) return res.status(400).json({ error: 'Missing step_run_id or user' });

  try {
    const stepRunResult = await client.request(GET_STEP_RUN, { step_run_id });
    const stepRun = stepRunResult.step_runs_by_pk;

    if (!stepRun) return res.status(404).json({ error: 'Step run not found' });
    if (stepRun.status !== 'paused') return res.status(400).json({ error: 'This step is not awaiting approval' });

    const orgId = stepRun.workflow_run.workflow.org_id;
    const roleResult = await client.request(CHECK_ROLE, { org_id: orgId, user_id: userId });
    const membership = roleResult.org_members[0];

    // Explicit role check in code — not just relying on a DB permission
    if (!membership || (membership.role !== 'owner' && membership.role !== 'editor')) {
      return res.status(403).json({ error: 'Not authorized to approve this step' });
    }

    await client.request(APPROVE_STEP_RUN, { id: step_run_id, approved_by: userId });
    await client.request(RESUME_RUN, { id: stepRun.workflow_run_id });

    return res.status(200).json({ message: 'Step approved, run resumed', step_run_id });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}