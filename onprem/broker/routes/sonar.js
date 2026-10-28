'use strict';

// ============================================================================
// POST /sonar/provision — moves the admin-level SonarQube logic that used to
// live in lib/sonarqube.js server-side (§3.1 of onprem/BROKER_DESIGN.md).
//
// The admin token is held by the credential store and is NEVER returned. The
// only token in a response is a project-scoped scanner token.
// ============================================================================

const crypto = require('crypto');
const express = require('express');
const { sonarBasicAuth } = require('../lib/config');
const { ValidationError, validateProvisionInput, scannerTokenName } = require('../lib/validate');

// Single-point constant: if a PROJECT_ANALYSIS_TOKEN cannot poll the CE /
// quality-gate endpoints on this SonarQube, switch this to a project-scoped
// user token per §3.1's documented fallback (one-line change).
const SONAR_SCANNER_TOKEN_TYPE = 'PROJECT_ANALYSIS_TOKEN';

// Per-project permissions a developer needs to scan + view. `admin` is
// deliberately dropped (least privilege, §3.1 step 3).
const PROJECT_PERMISSIONS = ['user', 'codeviewer', 'scan', 'issueadmin', 'securityhotspotadmin'];

function makeApi(ctx) {
  const cfg = ctx.config;
  const doFetch = ctx.fetchImpl || globalThis.fetch.bind(globalThis);

  async function post(adminToken, apiPath, params) {
    return doFetch(`${cfg.sonarInternalUrl}${apiPath}`, {
      method: 'POST',
      headers: {
        Authorization: sonarBasicAuth(adminToken),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(cfg.upstreamTimeoutMs),
    });
  }
  return { post };
}

async function readText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

// Business logic, independent of Express so it is directly unit-testable.
async function provision(ctx, body) {
  const input = validateProvisionInput(body);
  const { projectKey, projectName, gitEmail, gitEmailValid, cid } = input;
  const cfg = ctx.config;
  const api = makeApi(ctx);

  const adminToken = ctx.credentials.getSonarToken();

  // 1) Ensure the project exists + is private (idempotent).
  const createRes = await api.post(adminToken, '/api/projects/create', {
    name: projectName,
    project: projectKey,
    visibility: 'private',
  });
  if (!createRes.ok) {
    const text = await readText(createRes);
    if (!/already exists/i.test(text)) {
      const e = new Error('sonar_unavailable');
      e.status = 502;
      e.code = 'sonar_unavailable';
      throw e;
    }
  }
  // Best-effort: make sure a pre-existing project is private too.
  try {
    await api.post(adminToken, '/api/projects/update_visibility', {
      project: projectKey,
      visibility: 'private',
    });
  } catch {
    /* non-fatal */
  }

  // 2) User + permissions — laptop-only concern; skipped for CI (no gitEmail).
  //    The dashboard password is returned ONLY in the call that created the
  //    account; the CLI saves it locally and the pre-commit hook prints it.
  let userSetup = 'skipped';
  let dashboardLogin = null;
  let dashboardPassword = null;
  if (gitEmail && gitEmailValid) {
    const user = await ensureUser(api, adminToken, gitEmail, projectKey);
    userSetup = user.status;
    dashboardLogin = gitEmail;
    dashboardPassword = user.password;
  } else if (gitEmail && !gitEmailValid) {
    userSetup = 'skipped: invalid email';
  }

  // 3) Mint a fresh project-scoped scanner token, revoking ONLY this
  //    consumer's own same-named token first (no cross-consumer clobber).
  const tokenName = scannerTokenName(projectKey, cid);
  const scannerToken = await mintScannerToken(api, adminToken, tokenName, projectKey);

  return {
    status: 200,
    body: {
      hostUrl: cfg.sonarPublicUrl,
      projectKey,
      scannerToken,
      dashboardUrl: `${cfg.sonarPublicUrl}/dashboard?id=${encodeURIComponent(projectKey)}`,
      userSetup,
      dashboardLogin,
      dashboardPassword,
    },
  };
}

// Random dashboard password that always satisfies SonarQube's policy (12+
// chars, upper, lower, digit, special) and is safe to print/copy in a shell.
function generateDashboardPassword() {
  return `Sq9@${crypto.randomBytes(18).toString('base64url')}`;
}

// Returns { status: 'ok' | 'failed', password: string | null }. `password` is
// set only when this call created the account (existing accounts keep theirs).
async function ensureUser(api, adminToken, gitEmail, projectKey) {
  let password = null;
  try {
    const login = gitEmail;
    const name = gitEmail.split('@')[0];
    const newPassword = generateDashboardPassword();
    const createRes = await api.post(adminToken, '/api/users/create', {
      login,
      name,
      email: gitEmail,
      password: newPassword,
    });
    if (createRes.ok) {
      password = newPassword;
    } else {
      const text = await readText(createRes);
      // "already exists" → leave the account alone; any other failure is partial.
      if (!/already exists/i.test(text)) {
        return { status: 'failed', password: null };
      }
    }
    for (const permission of PROJECT_PERMISSIONS) {
      const permRes = await api.post(adminToken, '/api/permissions/add_user', {
        login,
        projectKey,
        permission,
      });
      if (!permRes.ok) {
        return { status: 'failed', password };
      }
    }
    return { status: 'ok', password };
  } catch {
    return { status: 'failed', password };
  }
}

async function mintScannerToken(api, adminToken, tokenName, projectKey) {
  async function revokeThenGenerate() {
    // Revoke only the exact same-named token ("not found" is fine).
    await api.post(adminToken, '/api/user_tokens/revoke', { name: tokenName });
    return api.post(adminToken, '/api/user_tokens/generate', {
      name: tokenName,
      type: SONAR_SCANNER_TOKEN_TYPE,
      projectKey,
    });
  }

  let res = await revokeThenGenerate();
  if (!res.ok) {
    // One retry (revoke may have lagged), then give up.
    res = await revokeThenGenerate();
  }
  if (!res.ok) {
    const e = new Error('sonar_token_mint_failed');
    e.status = 502;
    e.code = 'sonar_unavailable';
    throw e;
  }
  const data = await res.json();
  if (!data || !data.token) {
    const e = new Error('sonar_token_missing');
    e.status = 502;
    e.code = 'sonar_unavailable';
    throw e;
  }
  return data.token;
}

function createSonarRouter(ctx) {
  const router = express.Router();

  router.post('/provision', async (req, res) => {
    try {
      const result = await provision(ctx, req.body);
      res.status(result.status).json(result.body);
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}

function sendError(res, err) {
  if (err instanceof ValidationError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
  if (err && err.name === 'TimeoutError') {
    return res.status(504).json({ error: { code: 'upstream_timeout', message: 'SonarQube timed out' } });
  }
  const status = err && err.status ? err.status : 502;
  const code = err && err.code ? err.code : 'sonar_unavailable';
  return res.status(status).json({ error: { code, message: 'SonarQube provisioning failed' } });
}

module.exports = {
  SONAR_SCANNER_TOKEN_TYPE,
  PROJECT_PERMISSIONS,
  provision,
  createSonarRouter,
};
