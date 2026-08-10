import { GraphQLClient, gql } from 'graphql-request';

const client = new GraphQLClient(process.env.MY_HASURA_GRAPHQL_URL, {
  headers: { 'x-hasura-admin-secret': process.env.MY_HASURA_ADMIN_SECRET },
});

const GET_RUN = gql`
  query GetRun($run_id: uuid!) {
    workflow_runs_by_pk(id: $run_id) {
      id
      workflow_id
      triggered_by
      workflow {
        org_id
        workflow_steps(order_by: { step_order: asc }) {
          id
          step_order
          type
          config
        }
      }
    }
  }
`;

const CREATE_STEP_RUN = gql`
  mutation CreateStepRun($workflow_run_id: uuid!, $step_id: uuid!, $status: String!, $input: jsonb) {
    insert_step_runs_one(object: {
      workflow_run_id: $workflow_run_id,
      step_id: $step_id,
      status: $status,
      input: $input,
      attempt_count: 0
    }) { id }
  }
`;

const UPDATE_STEP_RUN = gql`
  mutation UpdateStepRun($id: uuid!, $status: String!, $output: jsonb, $error: String, $attempt_count: Int) {
    update_step_runs_by_pk(pk_columns: { id: $id }, _set: {
      status: $status, output: $output, error: $error, attempt_count: $attempt_count
    }) { id }
  }
`;

const UPDATE_RUN_STATUS = gql`
  mutation UpdateRunStatus($id: uuid!, $status: String!) {
    update_workflow_runs_by_pk(pk_columns: { id: $id }, _set: { status: $status }) { id }
  }
`;

const INCREMENT_QUOTA = gql`
  mutation IncrementQuota($org_id: uuid!) {
    update_organizations_by_pk(pk_columns: { id: $org_id }, _inc: { quota_used: 1 }) { id }
  }
`;

async function executeLlmCall(config, previousOutput) {
  const prompt = config.prompt || 'Summarize this input';
  const apiKey = process.env.MY_OPENROUTER_API_KEY;

  if (!apiKey) {
    await new Promise((r) => setTimeout(r, 500));
    return { stubbed: true, result: 'Stubbed LLM response', rating: 8 };
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'nvidia/nemotron-nano-9b-v2:free',
      messages: [{ role: 'user', content: `${prompt}\n\nInput: ${JSON.stringify(previousOutput)}` }],
    }),
  });

  if (!response.ok) throw new Error(`LLM API failed: ${response.status}`);
  const data = await response.json();
  const text = data.choices[0].message.content;
  const match = text.match(/(\d+)\s*\/\s*10|rating[:\s]+(\d+)/i);
  const rating = match ? parseInt(match[1] || match[2], 10) : null;
  return { result: text, rating };
}

async function executeHttpRequest(config) {
  const response = await fetch(config.url, {
    method: config.method || 'GET',
    headers: config.headers || {},
    body: config.body ? JSON.stringify(config.body) : undefined,
  });
  if (!response.ok) throw new Error(`HTTP request failed: ${response.status}`);
  return await response.json().catch(() => ({ status: response.status }));
}

function executeConditionalBranch(config, previousOutput) {
  const value = previousOutput?.[config.field];
  let result = false;
  if (config.operator === '>=') result = value >= config.value;
  if (config.operator === '<=') result = value <= config.value;
  if (config.operator === '==') result = value === config.value;
  return { branch: result ? 'then' : 'else', value };
}

async function executeStepWithRetry(step, previousOutput) {
  let attempt = 0;
  let lastError = null;
  while (attempt < 2) {
    try {
      attempt++;
      let output;
      if (step.type === 'llm_call') output = await executeLlmCall(step.config, previousOutput);
      else if (step.type === 'http_request') output = await executeHttpRequest(step.config);
      else if (step.type === 'conditional_branch') output = executeConditionalBranch(step.config, previousOutput);
      else if (step.type === 'db_write') output = { saved: true, data: previousOutput };
      else if (step.type === 'notify') output = { notified: true };
      else output = { skipped: true };
      return { status: 'success', output, attempt_count: attempt };
    } catch (err) {
      lastError = err.message;
      if (attempt >= 2) break;
    }
  }
  return { status: 'failed', error: lastError, attempt_count: attempt };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Event trigger payload: req.body.event.data.new
  const runId = req.body?.event?.data?.new?.id;

  if (!runId) return res.status(400).json({ error: 'Missing run id' });

  // Acknowledge immediately so Hasura doesn't retry
  res.status(200).json({ message: 'Processing started' });

  try {
    const result = await client.request(GET_RUN, { run_id: runId });
    const run = result.workflow_runs_by_pk;
    if (!run) return;

    const steps = run.workflow.workflow_steps;
    const orgId = run.workflow.org_id;
    let previousOutput = null;

    for (const step of steps) {
      const stepRunResult = await client.request(CREATE_STEP_RUN, {
        workflow_run_id: runId,
        step_id: step.id,
        status: 'running',
        input: previousOutput,
      });
      const stepRunId = stepRunResult.insert_step_runs_one.id;

      if (step.type === 'approval_gate') {
        await client.request(UPDATE_STEP_RUN, {
          id: stepRunId, status: 'paused', output: null, error: null, attempt_count: 0,
        });
        await client.request(UPDATE_RUN_STATUS, { id: runId, status: 'paused' });
        return;
      }

      const stepResult = await executeStepWithRetry(step, previousOutput);
      await client.request(UPDATE_STEP_RUN, {
        id: stepRunId,
        status: stepResult.status,
        output: stepResult.output || null,
        error: stepResult.error || null,
        attempt_count: stepResult.attempt_count,
      });

      if (stepResult.status === 'failed') {
        await client.request(UPDATE_RUN_STATUS, { id: runId, status: 'failed' });
        return;
      }

      previousOutput = stepResult.output;
    }

    await client.request(UPDATE_RUN_STATUS, { id: runId, status: 'completed' });
    await client.request(INCREMENT_QUOTA, { org_id: orgId });
  } catch (err) {
    console.error('processWorkflowRun error:', err);
    await client.request(UPDATE_RUN_STATUS, { id: runId, status: 'failed' }).catch(() => {});
  }
}