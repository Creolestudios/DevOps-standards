'use strict';

// ============================================================================
// Config + upstream-credential store for the broker.
//
// All privileged secrets (SonarQube admin token, DefectDojo API key) live
// ONLY in memory here. Nothing in this module is ever serialized into an HTTP
// response or logged. See onprem/BROKER_DESIGN.md §5 and §8.
// ============================================================================

const crypto = require('crypto');

// Name of the admin user-token the broker mints for itself at startup.
const SONAR_BROKER_TOKEN_NAME = 'cs-devtest-broker';

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function loadConfig() {
  return {
    port: parseInt(env('BROKER_PORT', '8900'), 10),
    // SonarQube: internal (service name) for the broker, public URL handed to clients.
    sonarInternalUrl: env('SONAR_INTERNAL_URL', 'http://sonarqube:9000'),
    sonarPublicUrl: env('SONAR_PUBLIC_URL', 'http://localhost:9000'),
    sonarAdminPassword: env('SONARQUBE_ADMIN_PASSWORD', ''),
    sonarAdminToken: env('SONAR_ADMIN_TOKEN', ''),
    // DefectDojo
    defectDojoUrl: env('DEFECTDOJO_URL', 'http://defectdojo:8080'),
    ddAdminUser: env('DD_ADMIN_USER', 'admin'),
    ddAdminPassword: env('DD_ADMIN_PASSWORD', ''),
    defectDojoApiKey: env('DEFECTDOJO_API_KEY', ''),
    ddProductTypeName: env('DD_PRODUCT_TYPE_NAME', 'cs-devtest'),
    // Upstream request timeout (ms).
    upstreamTimeoutMs: parseInt(env('BROKER_UPSTREAM_TIMEOUT_MS', '15000'), 10),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sonarBasicAuth(token) {
  // SonarQube accepts a token as the basic-auth username with an empty password.
  return 'Basic ' + Buffer.from(`${token}:`).toString('base64');
}

// Build a credential store bound to a config + fetch implementation. `fetchImpl`
// is injectable so unit tests can stub all upstream calls.
function createCredentialStore(cfg, { fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch.bind(globalThis);
  let sonarToken = null;
  let ddApiKey = null;

  function sonarSignal() {
    return AbortSignal.timeout(cfg.upstreamTimeoutMs);
  }

  async function sonarApiPost(adminPassword, apiPath, params) {
    const body = new URLSearchParams(params).toString();
    return doFetch(`${cfg.sonarInternalUrl}${apiPath}`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`admin:${adminPassword}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: sonarSignal(),
    });
  }

  async function sonarIsUp() {
    try {
      const res = await doFetch(`${cfg.sonarInternalUrl}/api/system/status`, {
        signal: sonarSignal(),
      });
      if (!res.ok) return false;
      const data = await res.json();
      return data && data.status === 'UP';
    } catch {
      return false;
    }
  }

  async function mintSonarAdminToken() {
    // Clean up any prior broker token so a restart is deterministic.
    try {
      await sonarApiPost(cfg.sonarAdminPassword, '/api/user_tokens/revoke', {
        name: SONAR_BROKER_TOKEN_NAME,
      });
    } catch {
      /* "not found" / transient — ignore, generate will surface real failures */
    }
    const res = await sonarApiPost(cfg.sonarAdminPassword, '/api/user_tokens/generate', {
      name: SONAR_BROKER_TOKEN_NAME,
    });
    if (res.status === 401 || res.status === 403) {
      const e = new Error('sonar_auth_rejected');
      e.authRejected = true;
      throw e;
    }
    if (!res.ok) {
      const e = new Error('sonar_token_mint_failed');
      e.retryable = true;
      throw e;
    }
    const data = await res.json();
    if (!data || !data.token) {
      const e = new Error('sonar_token_missing');
      e.retryable = true;
      throw e;
    }
    return data.token;
  }

  // Startup: obtain the admin token. Retries while SonarQube is "not up yet" or
  // auth is transiently invalid; becomes FATAL only when SonarQube is UP and the
  // password is genuinely rejected, or no credential is configured at all.
  async function initSonarToken({ attempts = 10, delayMs = 10000, sleepFn = sleep } = {}) {
    if (sonarToken) return sonarToken;
    if (cfg.sonarAdminToken) {
      sonarToken = cfg.sonarAdminToken;
      return sonarToken;
    }
    if (!cfg.sonarAdminPassword) {
      const e = new Error(
        'SonarQube admin credential missing: set SONARQUBE_ADMIN_PASSWORD (or SONAR_ADMIN_TOKEN) in onprem/.env'
      );
      e.fatal = true;
      throw e;
    }
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
      const up = await sonarIsUp();
      if (up) {
        try {
          sonarToken = await mintSonarAdminToken();
          return sonarToken;
        } catch (e) {
          if (e.authRejected) {
            const f = new Error(
              'SonarQube rejected the admin password (check SONARQUBE_ADMIN_PASSWORD in onprem/.env)'
            );
            f.fatal = true;
            throw f;
          }
          lastErr = e;
        }
      } else {
        lastErr = new Error('SonarQube not UP yet');
      }
      if (i < attempts) await sleepFn(delayMs);
    }
    const f = new Error(
      `SonarQube did not become ready after ${attempts} attempts${lastErr ? ': ' + lastErr.message : ''}`
    );
    f.fatal = true;
    throw f;
  }

  function getSonarToken() {
    if (!sonarToken) {
      const e = new Error('sonar_token_unavailable');
      e.code = 'sonar_unavailable';
      throw e;
    }
    return sonarToken;
  }

  // Lazy: DefectDojo failures never block startup. Caches the key once obtained.
  async function getDefectDojoApiKey() {
    if (ddApiKey) return ddApiKey;
    if (cfg.defectDojoApiKey) {
      ddApiKey = cfg.defectDojoApiKey;
      return ddApiKey;
    }
    if (!cfg.ddAdminPassword) {
      const e = new Error('defectdojo credentials not configured');
      e.code = 'defectdojo_unconfigured';
      throw e;
    }
    let res;
    try {
      res = await doFetch(`${cfg.defectDojoUrl}/api/v2/api-token-auth/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: cfg.ddAdminUser, password: cfg.ddAdminPassword }),
        signal: sonarSignal(),
      });
    } catch {
      const e = new Error('defectdojo auth unreachable');
      e.code = 'defectdojo_unconfigured';
      throw e;
    }
    if (!res.ok) {
      const e = new Error('defectdojo auth failed');
      e.code = 'defectdojo_unconfigured';
      throw e;
    }
    const data = await res.json();
    if (!data || !data.token) {
      const e = new Error('defectdojo token missing');
      e.code = 'defectdojo_unconfigured';
      throw e;
    }
    ddApiKey = data.token;
    return ddApiKey;
  }

  // Test-only: lets the leak-invariant test assert that response bodies never
  // contain these exact in-memory secret values.
  function peekSecrets() {
    return { sonarToken, ddApiKey };
  }

  return {
    initSonarToken,
    getSonarToken,
    getDefectDojoApiKey,
    sonarIsUp,
    peekSecrets,
  };
}

module.exports = {
  SONAR_BROKER_TOKEN_NAME,
  loadConfig,
  createCredentialStore,
  sonarBasicAuth,
  sleep,
};
