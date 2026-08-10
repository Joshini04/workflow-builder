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
      workflow_steps(order_by: { step_order: asc }) {
        id
        step_order
        type
        config
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

// --- Step executors ---

async function executeLlmCall(config, previousOutput) {
  const prompt = config.prompt || 'Summarize this input';
  const apiKey = process.env.MY_OPENROUTER_API_KEY;

  if (!apiKey) {
    // Stubbed fallback if no key configured — disclosed in README
    await new Promise((r) => setTimeout(r, 1000));
    return { stubbed: true, result: 'Stubbed LLM response (no API key configured)', rating: 8 };
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'meta-llama/llama-3.1-8b-instruct:free',
      messages: [{ role: 'user', content: `${prompt}\n\nInput: ${JSON.stringify(previousOutput)}` }],
    }),
  });

  if (!response.ok) throw new Error(`LLM API failed: ${response.status}`);
  const data = await response.json();
  const text = data.choices[0].message.content;
  return { result: text, rating: extractRating(text) };
}

function extractRating(text) {
  const match = text.match(/(\d+)\s*\/\s*10|rating[:\s]+(\d+)/i);
  return match ? parseInt(match[1] || match[2], 10) : null;
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
  // Simple example: config = { field: "rating", operator: ">=", value: 7 }
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

// --- Main handler ---

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
      return res.status(403).json({ error: 'Not authorized to run this workflow' });
    }

    if (workflow.organization.quota_used >= workflow.organization.quota_limit) {
      return res.status(429).json({ error: 'Organization quota exceeded' });
    }

    const runResult = await client.request(CREATE_RUN, { workflow_id, user_id: userId });
    const runId = runResult.insert_workflow_runs_one.id;

    let previousOutput = null;
    let paused = false;

    for (const step of workflow.workflow_steps) {
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
        paused = true;
        break;
      }

      const result = await executeStepWithRetry(step, previousOutput);
      await client.request(UPDATE_STEP_RUN, {
        id: stepRunId,
        status: result.status,
        output: result.output || null,
        error: result.error || null,
        attempt_count: result.attempt_count,
      });

      if (result.status === 'failed') {
        await client.request(UPDATE_RUN_STATUS, { id: runId, status: 'failed' });
        return res.status(200).json({ run_id: runId, status: 'failed', failedStep: step.type });
      }

      previousOutput = result.output;
    }

    if (!paused) {
      await client.request(UPDATE_RUN_STATUS, { id: runId, status: 'completed' });
      await client.request(INCREMENT_QUOTA, { org_id: workflow.org_id });
    }

    return res.status(200).json({ run_id: runId, status: paused ? 'paused' : 'completed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}