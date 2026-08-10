'use client';

import { useSubscription, useMutation, gql } from '@apollo/client';
import { useParams } from 'next/navigation';
import { useAuthenticationStatus } from '@nhost/react';

const RUN_SUBSCRIPTION = gql`
  subscription WatchRun($run_id: uuid!) {
    workflow_runs_by_pk(id: $run_id) {
      id
      status
      started_at
      completed_at
      workflow {
        name
      }
      step_runs(order_by: { workflow_step: { step_order: asc } }) {
        id
        status
        error
        output
        attempt_count
        approved_by
        approved_at
        workflow_step {
          type
          step_order
        }
      }
    }
  }
`;

const APPROVE_STEP = gql`
  mutation ApproveStep($step_run_id: uuid!) {
    approveStep(step_run_id: $step_run_id) {
      message
      step_run_id
    }
  }
`;

function statusColor(status) {
  if (status === 'success' || status === 'completed') return '#2e7d32';
  if (status === 'failed') return '#c62828';
  if (status === 'pending' || status === 'running') return '#f9a825';
  if (status === 'paused') return '#6a1b9a';
  return '#888';
}

export default function RunStatusPage() {
  const params = useParams();
  const runId = params.id;
  const { isAuthenticated, isLoading: authLoading } = useAuthenticationStatus();

  const { data, loading, error } = useSubscription(RUN_SUBSCRIPTION, {
    variables: { run_id: runId },
    skip: !isAuthenticated,
  });

  const [approveStep, { loading: approving }] = useMutation(APPROVE_STEP);

  const handleApprove = async (stepRunId) => {
    try {
      await approveStep({ variables: { step_run_id: stepRunId } });
    } catch (err) {
      alert('Approval failed: ' + err.message);
    }
  };

  if (authLoading) return <p style={{ padding: 40 }}>Checking auth...</p>;
  if (!isAuthenticated) return <p style={{ padding: 40 }}>You need to be logged in. <a href="/auth">Sign in</a></p>;
  if (loading) return <p style={{ padding: 40 }}>Connecting to live run...</p>;
  if (error) return <p style={{ padding: 40, color: 'red' }}>Error: {error.message}</p>;

  const run = data?.workflow_runs_by_pk;

  if (!run) {
    return <p style={{ padding: 40 }}>Run not found (or you don't have access to it).</p>;
  }

  return (
    <main style={{ padding: 40, maxWidth: 700 }}>
      <h1>{run.workflow?.name || 'Workflow Run'}</h1>
      <p>
        Run status:{' '}
        <strong style={{ color: statusColor(run.status) }}>{run.status}</strong>
      </p>
      <p style={{ fontSize: 13, color: '#666' }}>
        Started: {run.started_at ? new Date(run.started_at).toLocaleString() : '—'}
        {run.completed_at ? ` · Completed: ${new Date(run.completed_at).toLocaleString()}` : ''}
      </p>

      <h2 style={{ marginTop: 30 }}>Steps</h2>
      {run.step_runs.length === 0 && <p>No steps recorded yet.</p>}

      {run.step_runs.map((step) => (
        <div
          key={step.id}
          style={{
            border: '1px solid #ccc',
            borderLeft: `4px solid ${statusColor(step.status)}`,
            padding: 16,
            marginBottom: 12,
            borderRadius: 6,
          }}
        >
          <p style={{ margin: 0 }}>
            <strong>{step.workflow_step?.type}</strong>{' '}
            <span style={{ color: statusColor(step.status) }}>({step.status})</span>
          </p>

          {step.attempt_count > 0 && (
            <p style={{ fontSize: 12, color: '#666', margin: '4px 0' }}>
              Attempts: {step.attempt_count}
            </p>
          )}

          {step.error && (
            <pre style={{ background: '#fdecea', padding: 8, borderRadius: 4, fontSize: 12, overflowX: 'auto' }}>
              {typeof step.error === 'string' ? step.error : JSON.stringify(step.error, null, 2)}
            </pre>
          )}

          {step.output && (
            <pre style={{ background: '#f5f5f5', padding: 8, borderRadius: 4, fontSize: 12, overflowX: 'auto' }}>
              {JSON.stringify(step.output, null, 2)}
            </pre>
          )}

          {step.status === 'paused' && step.workflow_step?.type === 'approval_gate' && (
            <div style={{ marginTop: 8 }}>
              <p style={{ color: '#6a1b9a', fontWeight: 'bold', margin: '0 0 8px 0' }}>
                ⏸ Waiting for approval
              </p>
              <button
                onClick={() => handleApprove(step.id)}
                disabled={approving}
                style={{
                  padding: '8px 16px',
                  background: '#6a1b9a',
                  color: 'white',
                  border: 'none',
                  borderRadius: 4,
                  cursor: 'pointer',
                }}
              >
                {approving ? 'Approving...' : 'Approve'}
              </button>
            </div>
          )}

          {step.approved_by && (
            <p style={{ fontSize: 12, color: '#666' }}>
              Approved at: {step.approved_at ? new Date(step.approved_at).toLocaleString() : '—'}
            </p>
          )}
        </div>
      ))}
    </main>
  );
}