'use client';
import { useUserData, useAuthenticationStatus } from '@nhost/react';
import { useQuery, useMutation, gql } from '@apollo/client';
import { useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

const GET_WORKFLOW = gql`
  query GetWorkflow($id: uuid!) {
    workflows_by_pk(id: $id) {
      id
      name
      org_id
      workflow_steps(order_by: { step_order: asc }) {
        id
        step_order
        type
        config
      }
    }
  }
`;

const ADD_STEP = gql`
  mutation AddStep($workflow_id: uuid!, $step_order: Int!, $type: String!, $config: jsonb) {
    insert_workflow_steps_one(object: {
      workflow_id: $workflow_id, step_order: $step_order, type: $type, config: $config
    }) { id }
  }
`;

const DELETE_STEP = gql`
  mutation DeleteStep($id: uuid!) {
    delete_workflow_steps_by_pk(id: $id) { id }
  }
`;

const UPDATE_STEP_ORDER = gql`
  mutation UpdateStepOrder($id: uuid!, $step_order: Int!) {
    update_workflow_steps_by_pk(pk_columns: { id: $id }, _set: { step_order: $step_order }) { id }
  }
`;

const STEP_TYPES = ['llm_call', 'http_request', 'conditional_branch', 'approval_gate', 'db_write', 'notify'];

export default function WorkflowBuilder() {
  const { id } = useParams();
  const user = useUserData();
  const { isAuthenticated, isLoading: authLoading } = useAuthenticationStatus();

  const [newType, setNewType] = useState('llm_call');
  const [newConfig, setNewConfig] = useState('{}');
  const [configError, setConfigError] = useState('');

  const { data, loading, error, refetch } = useQuery(GET_WORKFLOW, {
    variables: { id },
    skip: !isAuthenticated,
  });

  const [addStep, { loading: adding }] = useMutation(ADD_STEP);
  const [deleteStep] = useMutation(DELETE_STEP);
  const [updateStepOrder] = useMutation(UPDATE_STEP_ORDER);

  if (authLoading || loading) return <p style={{ padding: 40 }}>Loading...</p>;
  if (error) return <p style={{ padding: 40, color: 'red' }}>Error: {error.message}</p>;

  const workflow = data?.workflows_by_pk;
  if (!workflow) return <p style={{ padding: 40 }}>Workflow not found.</p>;

  const steps = workflow.workflow_steps;

  const handleAddStep = async () => {
    let parsedConfig;
    try {
      parsedConfig = JSON.parse(newConfig);
      setConfigError('');
    } catch (err) {
      setConfigError('Config must be valid JSON, e.g. {}');
      return;
    }
    const nextOrder = steps.length > 0 ? Math.max(...steps.map((s) => s.step_order)) + 1 : 1;
    await addStep({
      variables: { workflow_id: id, step_order: nextOrder, type: newType, config: parsedConfig },
    });
    setNewConfig('{}');
    refetch();
  };

  const handleDelete = async (stepId) => {
    await deleteStep({ variables: { id: stepId } });
    refetch();
  };

  const handleMove = async (index, direction) => {
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= steps.length) return;

    const current = steps[index];
    const target = steps[targetIndex];

    // Swap their step_order values
    await updateStepOrder({ variables: { id: current.id, step_order: target.step_order } });
    await updateStepOrder({ variables: { id: target.id, step_order: current.step_order } });
    refetch();
  };

  return (
    <main style={{ padding: 40 }}>
      <Link href="/dashboard">← Back to dashboard</Link>
      <h1 style={{ marginTop: 10 }}>{workflow.name}</h1>
      <p>{steps.length} steps</p>

      <div style={{ marginTop: 20 }}>
        {steps.map((step, index) => (
          <div
            key={step.id}
            style={{ border: '1px solid #ccc', padding: 16, marginBottom: 10, borderRadius: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
          >
            <div>
              <strong>{index + 1}. {step.type}</strong>
              <pre style={{ margin: '6px 0 0', fontSize: 12, color: '#666' }}>
                {JSON.stringify(step.config)}
              </pre>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => handleMove(index, 'up')} disabled={index === 0}>↑</button>
              <button onClick={() => handleMove(index, 'down')} disabled={index === steps.length - 1}>↓</button>
              <button onClick={() => handleDelete(step.id)} style={{ color: 'red' }}>Delete</button>
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 30, borderTop: '1px solid #ccc', paddingTop: 20 }}>
        <h3>Add a step</h3>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 10 }}>
          <select value={newType} onChange={(e) => setNewType(e.target.value)}>
            {STEP_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <div>
            <textarea
              value={newConfig}
              onChange={(e) => setNewConfig(e.target.value)}
              placeholder='Config as JSON, e.g. {"prompt": "Rate this"}'
              rows={3}
              cols={40}
            />
            {configError && <p style={{ color: 'red', fontSize: 12, margin: '4px 0' }}>{configError}</p>}
          </div>
          <button onClick={handleAddStep} disabled={adding}>
            {adding ? 'Adding...' : 'Add step'}
          </button>
        </div>
      </div>
    </main>
  );
}