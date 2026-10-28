'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { provision } = require('../routes/sonar');
const { deriveCid, scannerTokenName } = require('../lib/validate');

const ADMIN_TOKEN = 'squ_ADMIN_SECRET_VALUE';
const SCOPED_TOKEN = 'sqp_SCOPED_SCANNER_TOKEN';

function jsonRes(status, obj) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return obj;
    },
    async text() {
      return JSON.stringify(obj);
    },
  };
}

function textRes(status, text) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return JSON.parse(text);
    },
    async text() {
      return text;
    },
  };
}

function makeCtx(record) {
  return {
    config: {
      sonarInternalUrl: 'http://sonarqube:9000',
      sonarPublicUrl: 'http://192.168.1.50:9000',
      upstreamTimeoutMs: 5000,
    },
    credentials: {
      getSonarToken: () => ADMIN_TOKEN,
    },
    fetchImpl: async (url, opts = {}) => {
      const params = opts.body ? Object.fromEntries(new URLSearchParams(opts.body)) : {};
      record.push({ url, params });
      if (url.endsWith('/api/user_tokens/generate')) return jsonRes(200, { token: SCOPED_TOKEN });
      if (url.endsWith('/api/user_tokens/revoke')) return jsonRes(200, {});
      if (url.endsWith('/api/projects/create')) return textRes(200, '{}');
      if (url.endsWith('/api/projects/update_visibility')) return textRes(200, '{}');
      if (url.endsWith('/api/users/create')) return textRes(200, '{}');
      if (url.endsWith('/api/permissions/add_user')) return textRes(200, '{}');
      return textRes(404, 'not found');
    },
  };
}

test('provision — returns scoped token + host, never the admin token', async () => {
  const record = [];
  const ctx = makeCtx(record);
  const result = await provision(ctx, {
    projectKey: 'My App',
    projectName: 'My App',
    gitEmail: 'dev@creole.com',
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.scannerToken, SCOPED_TOKEN);
  assert.equal(result.body.hostUrl, 'http://192.168.1.50:9000');
  assert.equal(result.body.projectKey, 'my-app');

  // §9 leak invariant — admin token value never appears in the response body.
  assert.ok(!JSON.stringify(result.body).includes(ADMIN_TOKEN));
});

test('provision — revokes ONLY the same-named token (no wildcard/revoke-all)', async () => {
  const record = [];
  const ctx = makeCtx(record);
  await provision(ctx, { projectKey: 'my-app', projectName: 'My App', gitEmail: 'dev@creole.com' });

  const expectedName = scannerTokenName('my-app', deriveCid({ gitEmail: 'dev@creole.com' }));

  const revoke = record.find((c) => c.url.endsWith('/api/user_tokens/revoke'));
  const generate = record.find((c) => c.url.endsWith('/api/user_tokens/generate'));
  assert.ok(revoke, 'a revoke call was made');
  assert.equal(revoke.params.name, expectedName);
  assert.ok(!revoke.params.name.includes('*'), 'revoke is not a wildcard');
  assert.equal(generate.params.name, expectedName);
  assert.equal(generate.params.type, 'PROJECT_ANALYSIS_TOKEN');
  assert.equal(generate.params.projectKey, 'my-app');
});

test('provision — CI case (no gitEmail) skips user setup', async () => {
  const record = [];
  const ctx = makeCtx(record);
  const result = await provision(ctx, { projectKey: 'my-app', projectName: 'My App', consumerId: 'ci' });

  assert.equal(result.body.userSetup, 'skipped');
  assert.ok(!record.some((c) => c.url.endsWith('/api/users/create')), 'no user created for CI');

  const expectedName = scannerTokenName('my-app', deriveCid({ consumerId: 'ci' }));
  const generate = record.find((c) => c.url.endsWith('/api/user_tokens/generate'));
  assert.equal(generate.params.name, expectedName);
});

test('provision — project create failure maps to 502', async () => {
  const record = [];
  const ctx = makeCtx(record);
  ctx.fetchImpl = async (url) => {
    if (url.endsWith('/api/projects/create')) return textRes(500, 'boom');
    return textRes(200, '{}');
  };
  await assert.rejects(
    () => provision(ctx, { projectKey: 'my-app', projectName: 'My App' }),
    (err) => err.status === 502
  );
});

test('provision — new user gets a policy-compliant dashboard password', async () => {
  const record = [];
  const ctx = makeCtx(record);
  const result = await provision(ctx, { projectKey: 'my-app', projectName: 'My App', gitEmail: 'dev@creole.com' });

  const create = record.find((c) => c.url.endsWith('/api/users/create'));
  assert.equal(result.body.dashboardLogin, 'dev@creole.com');
  assert.equal(result.body.dashboardPassword, create.params.password);
  const pw = result.body.dashboardPassword;
  assert.ok(pw.length >= 12 && /[A-Z]/.test(pw) && /[a-z]/.test(pw) && /[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw));
});

test('provision — existing user: no password returned, account left alone', async () => {
  const record = [];
  const ctx = makeCtx(record);
  const baseFetch = ctx.fetchImpl;
  ctx.fetchImpl = async (url, opts) => {
    if (url.endsWith('/api/users/create')) {
      await baseFetch(url, opts);
      return textRes(400, '{"errors":[{"msg":"An active user with login \'dev@creole.com\' already exists"}]}');
    }
    return baseFetch(url, opts);
  };
  const result = await provision(ctx, { projectKey: 'my-app', projectName: 'My App', gitEmail: 'dev@creole.com' });

  assert.equal(result.body.userSetup, 'ok');
  assert.equal(result.body.dashboardLogin, 'dev@creole.com');
  assert.equal(result.body.dashboardPassword, null);
  assert.ok(!record.some((c) => c.url.endsWith('/api/users/change_password')));
});
