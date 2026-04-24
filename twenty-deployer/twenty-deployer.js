// Twenty Deployer — deploys Twenty CRM (https://twenty.com) to the caller's
// Railway account using their Railway API token from the Flows vault.
//
// First flow in the repo to declare a `manifest` with `userSecrets`.
// The caller (or their agent) grants this flow access to a vault-stored
// RAILWAY_API_KEY; at runtime the TEE auto-decrypts it into
// `params.secrets.RAILWAY_API_KEY` just like a publisher secret.
//
// What this flow automates so the user doesn't have to:
//   1. Provisions Twenty's Railway template (postgres + server + worker + volume)
//   2. Renames the Railway project to `projectName`
//   3. Generates a cryptographically random APP_SECRET inside the TEE and
//      sets it as an env var on the Twenty server service so first-login works
//   4. Returns the generated *.up.railway.app URL to open Twenty in a browser
//
// Input:
//   params.projectName (string, required) — display name for the new Railway project.
//   params.teamId      (string, optional) — Railway team ID. Defaults to personal workspace.
//
// Output: { projectId, workflowId, dashboardUrl, twentyUrl, services, appSecretSet, message }

export const manifest = {
  userSecrets: [
    {
      name: 'RAILWAY_API_KEY',
      type: 'railway_api_key',
      purpose: 'Deploy Twenty CRM into your Railway account',
      required: true,
    },
  ],
};

// Twenty's official Railway template (see https://railway.com/deploy/nAL3hA).
// If Twenty's template moves, bump this constant; everything else is generic.
const TWENTY_TEMPLATE_CODE = 'nAL3hA';
const RAILWAY_API = 'https://backboard.railway.app/graphql/v2';

async function railwayGraphQL(apiKey, query, variables) {
  const res = await fetch(RAILWAY_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (!res.ok || data.errors) {
    throw new Error(
      `Railway API error (${res.status}): ${JSON.stringify(data.errors || data)}`,
    );
  }
  return data.data;
}

function hexRandom(byteLength) {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function pickTwentyService(services) {
  // Prefer a service explicitly named "twenty" / "server", avoid postgres/redis/worker.
  const notInfra = (name) => !/postgres|redis|worker|database|pgbouncer/i.test(name || '');
  const explicit = services.find((s) => /twenty|server/i.test(s.name || '') && notInfra(s.name));
  if (explicit) return explicit;
  // Otherwise: first service that has a public domain and isn't obviously infra.
  return services.find((s) => notInfra(s.name) && s.domains.length > 0) || null;
}

const apiKey = params.secrets && params.secrets.RAILWAY_API_KEY;
if (!apiKey) {
  Lit.Actions.setResponse({
    response: JSON.stringify({
      error: 'Missing RAILWAY_API_KEY. Grant this flow access to your Railway token via POST /api/flows/<flowVersionId>/grants.',
    }),
  });
  throw new Error('Missing RAILWAY_API_KEY');
}

const projectName = params.projectName;
if (!projectName || typeof projectName !== 'string' || projectName.length > 80) {
  Lit.Actions.setResponse({
    response: JSON.stringify({
      error: 'projectName is required (string, ≤ 80 chars).',
    }),
  });
  throw new Error('Invalid projectName');
}

try {
  // 1. Deploy Twenty's Railway template. Railway creates the project + all
  //    services synchronously; only the build runs async.
  const deployData = await railwayGraphQL(
    apiKey,
    `mutation TemplateDeploy($input: TemplateDeployInput!) {
      templateDeploy(input: $input) {
        projectId
        workflowId
      }
    }`,
    {
      input: {
        templateCode: TWENTY_TEMPLATE_CODE,
        ...(params.teamId ? { teamId: params.teamId } : {}),
      },
    },
  );
  const { projectId, workflowId } = deployData.templateDeploy || {};
  if (!projectId) {
    throw new Error('Railway did not return a projectId');
  }

  // 2. Rename the project (best-effort).
  await railwayGraphQL(
    apiKey,
    `mutation ProjectUpdate($id: String!, $input: ProjectUpdateInput!) {
      projectUpdate(id: $id, input: $input) { id name }
    }`,
    { id: projectId, input: { name: projectName } },
  ).catch(() => null);

  // 3. Query the project for services + environments. This gives us the IDs
  //    we need to set APP_SECRET on the right service in the right env, and
  //    to surface the auto-generated *.up.railway.app URL to the user.
  let services = [];
  let productionEnvironmentId = null;
  let queryErr = null;
  try {
    const projectData = await railwayGraphQL(
      apiKey,
      `query Project($id: String!) {
        project(id: $id) {
          environments { edges { node { id name } } }
          services {
            edges {
              node {
                id
                name
                serviceInstances {
                  edges {
                    node {
                      environmentId
                      domains {
                        serviceDomains { domain }
                        customDomains { domain }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }`,
      { id: projectId },
    );
    const envEdges = ((projectData.project || {}).environments || {}).edges || [];
    const prodEnv = envEdges.find((e) => (e.node.name || '').toLowerCase() === 'production') || envEdges[0];
    productionEnvironmentId = prodEnv ? prodEnv.node.id : null;

    const svcEdges = ((projectData.project || {}).services || {}).edges || [];
    for (const edge of svcEdges) {
      const node = edge.node || {};
      const instEdges = (node.serviceInstances && node.serviceInstances.edges) || [];
      const domains = [];
      for (const ie of instEdges) {
        const d = (ie.node && ie.node.domains) || {};
        for (const sd of d.serviceDomains || []) if (sd.domain) domains.push(`https://${sd.domain}`);
        for (const cd of d.customDomains || []) if (cd.domain) domains.push(`https://${cd.domain}`);
      }
      services.push({ id: node.id, name: node.name, domains });
    }
  } catch (e) {
    queryErr = e instanceof Error ? e.message : String(e);
  }

  // 4. Generate APP_SECRET inside the TEE and set it on the Twenty service.
  //    Randomness comes from Web Crypto (`crypto.getRandomValues`) which is
  //    available in the Lit Action runtime. The plaintext never leaves the TEE
  //    — Railway receives it over TLS and stores it as an encrypted env var.
  const appSecret = hexRandom(32);
  const twentyService = pickTwentyService(services);
  let appSecretSet = false;
  let appSecretErr = null;

  if (twentyService && productionEnvironmentId) {
    try {
      await railwayGraphQL(
        apiKey,
        `mutation VariableUpsert($input: VariableUpsertInput!) {
          variableUpsert(input: $input)
        }`,
        {
          input: {
            projectId,
            environmentId: productionEnvironmentId,
            serviceId: twentyService.id,
            name: 'APP_SECRET',
            value: appSecret,
          },
        },
      );
      appSecretSet = true;
    } catch (e) {
      appSecretErr = e instanceof Error ? e.message : String(e);
    }
  } else {
    appSecretErr = queryErr || 'Could not resolve Twenty service + production environment';
  }

  const twentyUrl = twentyService && twentyService.domains.length > 0
    ? twentyService.domains[0]
    : null;

  const nextSteps = appSecretSet
    ? `Twenty is building. Once Railway finishes (~5–10 min), open twentyUrl in your browser. APP_SECRET has been set for you — no manual config needed to log in.`
    : `Twenty is building. Once Railway finishes (~5–10 min), open twentyUrl. We could not auto-set APP_SECRET (${appSecretErr || 'unknown error'}) — set it manually on the Twenty service: \`openssl rand -hex 32\`.`;

  Lit.Actions.setResponse({
    response: JSON.stringify({
      projectId,
      workflowId,
      dashboardUrl: `https://railway.com/project/${projectId}`,
      twentyUrl,
      services,
      appSecretSet,
      ...(appSecretErr ? { appSecretError: appSecretErr } : {}),
      message: nextSteps,
    }),
  });
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  Lit.Actions.setResponse({
    response: JSON.stringify({ error: message }),
  });
  throw err;
}
