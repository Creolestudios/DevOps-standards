'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { importScan, getFindings } = require('../routes/defectdojo');
const { loadConfig, createCredentialStore } = require('../lib/config');

const DD_KEY = 'DD_API_KEY_SECRET_VALUE';

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

function baseCtx(fetchImpl) {
  return {
    config: {
      defectDojoUrl: 'http://host.docker.internal:8080',
      ddProductTypeName: 'cs-devtest',
      upstreamTimeoutMs: 5000,
    },
    credentials: {
      getDefectDojoApiKey: async () => DD_KEY,
    },
    fetchImpl,
  };
}

test('importScan — imports and returns a severity summary without leaking the API key', async () => {
  const record = [];
  const ctx = baseCtx(async (url, opts = {}) => {
    record.push({ url, headers: opts.headers });
    return jsonRes(201, {
      product_id: 12,
      engagement_id: 34,
      test: 56,
      statistics: {
        after: { critical: { total: 0 }, high: { total: 1 }, medium: { total: 3 }, low: { total: 3 } },
      },
    });
  });

  const file = { buffer: Buffer.from('{"issues":[]}'), originalname: 'sonarqube-report.json' };
  const result = await importScan(
    ctx,
    { repo: 'owner/repo', branch: 'main', commit: 'abc1234', scanType: 'SonarQube Scan' },
    file
  );

  assert.equal(result.status, 200);
  assert.equal(result.body.findingsCount, 7);
  assert.deepEqual(result.body.severity, { Critical: 0, High: 1, Medium: 3, Low: 3 });
  assert.ok(record[0].url.endsWith('/api/v2/import-scan/'));
  assert.equal(record[0].headers.Authorization, `Token ${DD_KEY}`);

  // §9 leak invariant — API key value never appears in the response body.
  assert.ok(!JSON.stringify(result.body).includes(DD_KEY));
});

test('importScan — DefectDojo 4xx maps to 422 import_rejected', async () => {
  const ctx = baseCtx(async () => jsonRes(400, { message: 'bad report' }));
  const file = { buffer: Buffer.from('x'), originalname: 'r.json' };
  await assert.rejects(
    () => importScan(ctx, { repo: 'r', branch: 'main', commit: 'abc1234' }, file),
    (err) => err.status === 422 && err.code === 'import_rejected'
  );
});

test('getFindings — resolves product+engagement by name then returns findings JSON', async () => {
  const findings = { count: 2, results: [{ id: 1 }, { id: 2 }] };
  const ctx = baseCtx(async (url) => {
    if (url.includes('/api/v2/products/')) return jsonRes(200, { results: [{ id: 12 }] });
    if (url.includes('/api/v2/engagements/')) return jsonRes(200, { results: [{ id: 34 }] });
    if (url.includes('/api/v2/findings/')) return jsonRes(200, findings);
    return jsonRes(404, {});
  });

  const result = await getFindings(ctx, { repo: 'owner/repo', branch: 'main', limit: '500' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, findings);
});

test('getFindings — 404 when no product exists yet', async () => {
  const ctx = baseCtx(async (url) => {
    if (url.includes('/api/v2/products/')) return jsonRes(200, { results: [] });
    return jsonRes(200, { results: [] });
  });
  await assert.rejects(
    () => getFindings(ctx, { repo: 'owner/repo', branch: 'main' }),
    (err) => err.status === 404 && err.code === 'not_found'
  );
});

test('credential store — explicit keys short-circuit upstream auth/mint', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonRes(200, {});
  };

  const sonarStore = createCredentialStore(
    { sonarAdminToken: 'squ_PROVIDED', sonarAdminPassword: '', upstreamTimeoutMs: 1000 },
    { fetchImpl }
  );
  const sonarTok = await sonarStore.initSonarToken();
  assert.equal(sonarTok, 'squ_PROVIDED');

  const ddStore = createCredentialStore(
    { defectDojoApiKey: 'DD_PROVIDED', ddAdminPassword: '', upstreamTimeoutMs: 1000 },
    { fetchImpl }
  );
  const ddKey = await ddStore.getDefectDojoApiKey();
  assert.equal(ddKey, 'DD_PROVIDED');

  assert.equal(calls, 0, 'no upstream calls when explicit credentials are provided');
});

// loadConfig is exercised to ensure defaults resolve without throwing.
test('loadConfig — resolves defaults', () => {
  const cfg = loadConfig();
  assert.equal(typeof cfg.port, 'number');
  assert.ok(cfg.sonarInternalUrl.startsWith('http'));
  assert.equal(cfg.ddProductTypeName.length > 0, true);
});
