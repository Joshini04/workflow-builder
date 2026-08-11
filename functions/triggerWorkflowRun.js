// redeploy trigger

import { GraphQLClient, gql } from 'graphql-request';

const client = new GraphQLClient(process.env.MY_HASURA_GRAPHQL_URL, {
  headers: { 'x-hasura-admin-secret': process.env.MY_HASURA_ADMIN_SECRET },
});

const CHECK_QUERY = gql`
  query CheckPermission($workflow_id: uuid!, $user_id: uuid!) {
    workflows_by_pk(id: $workflow_id) {
      id
      org_id
      organization {
        quota_used
        quota_limit
        org_members(where: { user_id: { _eq: $user_id } }) { role }
      }
    }
  }
`;

const CREATE_RUN = gql`
  mutation CreateRun($workflow_id: uuid!, $user_id: uuid!) {
    insert_workflow_runs_one(object: {
      workflow_id: $workflow_id,
      status: "running",
      triggered_by: $user_id,
      started_at: "now()"
    }) { id }
  }
`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const workflow_id = req.body.input?.workflow_id;
  const userId = req.body.session_variables?.['x-hasura-user-id'];

  if (!workflow_id || !userId) {
    return res.status(400).json({ error: 'Missing workflow_id or user' });
  }

  try {
    const checkResult = await client.request(CHECK_QUERY, { workflow_id, user_id: userId });
    const workflow = checkResult.workflows_by_pk;

    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });

    const membership = workflow.organization.org_members[0];
    if (!membership || (membership.role !== 'owner' && membership.role !== 'editor')) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    if (workflow.organization.quota_used >= workflow.organization.quota_limit) {
      return res.status(429).json({ error: 'Quota exceeded' });
    }

    const runResult = await client.request(CREATE_RUN, { workflow_id, user_id: userId });
    const runId = runResult.insert_workflow_runs_one.id;

    // Event trigger on workflow_runs INSERT will automatically call processWorkflowRun
    return res.status(200).json({ run_id: runId, status: 'running', message: 'Workflow started' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}