'use strict';

// ============================================================================
// cs-devtest credential broker — HTTP entrypoint.
//
// Holds the SonarQube admin token and DefectDojo API key server-side and
// exposes least-privilege operations to LAN clients (§1-§5 of
// onprem/BROKER_DESIGN.md). Network access control lives in the DOCKER-USER
// iptables rules applied by onprem/setup.sh, NOT in this process (§4).
// ============================================================================

const express = require('express');
const { loadConfig, createCredentialStore } = require('./lib/config');
const { createSonarRouter } = require('./routes/sonar');
const { createDefectDojoRouter } = require('./routes/defectdojo');

function buildApp(ctx) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.use('/sonar', createSonarRouter(ctx));
  app.use('/defectdojo', createDefectDojoRouter(ctx));

  // Liveness + upstream readiness (§3.4).
  app.get('/healthz', async (req, res) => {
    const [sonar, defectdojo] = await Promise.all([checkSonar(ctx), checkDefectDojo(ctx)]);
    const ok = sonar && defectdojo;
    res.status(ok ? 200 : 503).json({
      status: ok ? 'ok' : 'degraded',
      sonar: sonar ? 'up' : 'down',
      defectdojo: defectdojo ? 'up' : 'down',
    });
  });

  // Non-secret config discovery (§3.5) — never returns tokens/keys/DD URL.
  app.get('/config', (req, res) => {
    res.status(200).json({ sonarHostUrl: ctx.config.sonarPublicUrl });
  });

  // Consistent error envelope for anything unhandled.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    res.status(500).json({ error: { code: 'internal_error', message: 'unexpected error' } });
  });

  return app;
}

async function checkSonar(ctx) {
  try {
    return await ctx.credentials.sonarIsUp();
  } catch {
    return false;
  }
}

async function checkDefectDojo(ctx) {
  const doFetch = ctx.fetchImpl || globalThis.fetch.bind(globalThis);
  try {
    const res = await doFetch(`${ctx.config.defectDojoUrl}/api/v2/`, {
      signal: AbortSignal.timeout(ctx.config.upstreamTimeoutMs),
    });
    return res.status > 0;
  } catch {
    return false;
  }
}

async function main() {
  const config = loadConfig();
  const fetchImpl = globalThis.fetch.bind(globalThis);
  const credentials = createCredentialStore(config, { fetchImpl });
  const ctx = { config, credentials, fetchImpl };

  // Obtain the admin token before serving. Fatal (exit non-zero) only on a
  // genuine misconfiguration (§5, §8); transient "SonarQube not up yet" retries.
  try {
    await credentials.initSonarToken();
    console.log('[broker] SonarQube admin token acquired.');
  } catch (err) {
    console.error(`[broker] FATAL: ${err.message}`);
    process.exit(1);
    return;
  }

  const app = buildApp(ctx);
  app.listen(config.port, () => {
    console.log(`[broker] listening on port ${config.port}`);
  });
}

if (require.main === module) {
  main();
}

module.exports = { buildApp, checkSonar, checkDefectDojo, main };
