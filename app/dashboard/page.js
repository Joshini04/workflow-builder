'use client';
import { useUserData, useAuthenticationStatus } from '@nhost/react';
import { useQuery, useMutation, gql } from '@apollo/client';
import { useState } from 'react';
import Link from 'next/link';
const GET_MY_WORKFLOWS = gql`
  query GetMyWorkflows($user_id: uuid!) {
    org_members(where: { user_id: { _eq: $user_id } }) {
      role
      organization {
        id
        name
        quota_used
        quota_limit
        workflows {
          id
          name
          workflow_steps(order_by: { step_order: asc }) {
            id
            step_order
            type
          }
        }
      }
    }
  }
`;

const TRIGGER_RUN = gql`
  mutation TriggerRun($workflow_id: uuid!) {
    triggerWorkflowRun(workflow_id: $workflow_id) {
      run_id
      status
      message
    }
  }
`;

export default function Dashboard() {
  const user = useUserData();
  const { isAuthenticated, isLoading: authLoading } = useAuthenticationStatus();
  console.log('USER:', user);
  const [runResults, setRunResults] = useState({});

  const { data, loading, error, refetch } = useQuery(GET_MY_WORKFLOWS, {
    variables: { user_id: user?.id },
    skip: !isAuthenticated,
  });

  const [triggerRun, { loading: triggering }] = useMutation(TRIGGER_RUN);

  const handleRun = async (workflowId) => {
    try {
      const result = await triggerRun({ variables: { workflow_id: workflowId } });
      setRunResults((prev) => ({ ...prev, [workflowId]: result.data.triggerWorkflowRun }));
    } catch (err) {
  console.log('RUN ERROR:', err);
  setRunResults((prev) => ({ ...prev, [workflowId]: { status: 'error', message: err.message } }));
}
  };

if (authLoading || loading) return <p style={{ padding: 40 }}>Loading...</p>;
  if (error) return <p style={{ padding: 40, color: 'red' }}>Error: {error.message}</p>;

  const membership = data?.org_members?.[0];
  const org = membership?.organization;

  if (!org) {
    return <p style={{ padding: 40 }}>You're not a member of any organization yet.</p>;
  }

  return (
    <main style={{ padding: 40 }}>
      <h1>{org.name}</h1>
      <p>Your role: {membership.role}</p>
      <p>Quota: {org.quota_used} / {org.quota_limit}</p>

      <h2 style={{ marginTop: 30 }}>Workflows</h2>
      {org.workflows.length === 0 && <p>No workflows yet.</p>}

      {org.workflows.map((wf) => {
        const result = runResults[wf.id];
        return (
          <div key={wf.id} style={{ border: '1px solid #ccc', padding: 16, marginBottom: 16, borderRadius: 8 }}>
            <h3>{wf.name}</h3>
            <p>{wf.workflow_steps.length} steps: {wf.workflow_steps.map((s) => s.type).join(' → ')}</p>
            <Link href={`/workflows/${wf.id}`}>Edit workflow →</Link>

            {membership.role !== 'viewer' && (
              <button onClick={() => handleRun(wf.id)} disabled={triggering}>
                {triggering ? 'Running...' : 'Run'}
              </button>
            )}

            {result && (
              <div style={{ marginTop: 10 }}>
                <p>Run ID: {result.run_id}</p>
                <p>Status: <strong>{result.status}</strong></p>
                <Link href={`/runs/${result.run_id}`}>View live status →</Link>
              </div>
            )}
          </div>
        );
      })}
    </main>
  );
}