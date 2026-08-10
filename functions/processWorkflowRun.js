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

// NEW: lets us figure out how far a run has already progressed
const GET_STEP_RUNS = gql`
  query GetStepRuns($run_id: uuid!) {
    step_runs(
      where: { workflow_run_id: { _eq: $run_id } }
      order_by: { step: { step_order: asc } }
    ) {
      id
      status
      output
      step {
        step_order
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

  const tableName = req.body?.table?.name;
  const eventData = req.body?.event?.data;
  let runId;

  // This function now gets called from TWO different triggers, so first figure out which one fired
  if (tableName === 'workflow_runs') {
    // A brand new run was created (manual button or webhook curl) -> process step 1
    runId = eventData?.new?.id;
  } else if (tableName === 'step_runs') {
    // A step finished -> only continue if it just became 'success'
    const newRow = eventData?.new;
    const oldRow = eventData?.old;
    if (!newRow || newRow.status !== 'success') {
      return res.status(200).json({ message: 'Ignored - not a success transition' });
    }
    if (oldRow && oldRow.status === 'success') {
      return res.status(200).json({ message: 'Ignored - already processed' });
    }
    runId = newRow.workflow_run_id;
  } else {
    return res.status(400).json({ error: 'Unknown source table' });
  }

  if (!runId) return res.status(400).json({ error: 'Missing run id' });

  try {
    const result = await client.request(GET_RUN, { run_id: runId });
    const run = result.workflow_runs_by_pk;
    if (!run) return res.status(404).json({ error: 'Run not found' });

    const steps = run.workflow.workflow_steps;
    const orgId = run.workflow.org_id;

    // Figure out how many steps have already succeeded, so we know which one is next
    const progress = await client.request(GET_STEP_RUNS, { run_id: runId });
    const completedStepRuns = progress.step_runs.filter((sr) => sr.status === 'success');
    const nextIndex = completedStepRuns.length;

    if (nextIndex >= steps.length) {
      // Every step is done
      await client.request(UPDATE_RUN_STATUS, { id: runId, status: 'completed' });
      await client.request(INCREMENT_QUOTA, { org_id: orgId });
      return res.status(200).json({ message: 'Completed' });
    }

    const step = steps[nextIndex];
    const previousOutput =
      completedStepRuns.length > 0
        ? completedStepRuns[completedStepRuns.length - 1].output
        : null;

    if (step.type === 'approval_gate') {
      await client.request(CREATE_STEP_RUN, {
        workflow_run_id: runId,
        step_id: step.id,
        status: 'paused',
        input: previousOutput,
      });
      await client.request(UPDATE_RUN_STATUS, { id: runId, status: 'paused' });
      return res.status(200).json({ message: 'Paused at approval_gate' });
    }

    // Process just this ONE step
    const stepRunResult = await client.request(CREATE_STEP_RUN, {
      workflow_run_id: runId,
      step_id: step.id,
      status: 'running',
      input: previousOutput,
    });
    const stepRunId = stepRunResult.insert_step_runs_one.id;

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
      return res.status(200).json({ message: 'Step failed, run marked failed' });
    }

    // Success! The UPDATE_STEP_RUN call above just fired the step_runs event trigger,
    // which will call this same function again for the NEXT step automatically.
    return res.status(200).json({ message: `Step ${step.type} done, next step triggered` });
  } catch (err) {
    console.error('processWorkflowRun error:', err);
    await client.request(UPDATE_RUN_STATUS, { id: runId, status: 'failed' }).catch(() => {});
    return res.status(500).json({ error: err.message });
  }
}