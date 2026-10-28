'use strict';

// ============================================================================
// POST /defectdojo/import  — resolve-or-create product+engagement and import a
//                            scan report using the server-side API key (§3.2).
// GET  /defectdojo/findings — read-only resolve product/engagement by name and
//                             return the engagement's findings JSON (§3.3).
//
// The DefectDojo API key is held by the credential store and never returned.
// ============================================================================

const express = require('express');
const multer = require('multer');
const { ValidationError, validateImportInput, validateFindingsQuery } = require('../lib/validate');

const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB (§7)

function ddFetch(ctx) {
  return ctx.fetchImpl || globalThis.fetch.bind(globalThis);
}

function signal(ctx) {
  return AbortSignal.timeout(ctx.config.upstreamTimeoutMs);
}

// --- import -------------------------------------------------------------------
async function importScan(ctx, fields, file) {
  const input = validateImportInput(fields, file);
  const cfg = ctx.config;

  let apiKey;
  try {
    apiKey = await ctx.credentials.getDefectDojoApiKey();
  } catch (err) {
    const e = new Error('defectdojo_unconfigured');
    e.status = 503;
    e.code = 'defectdojo_unconfigured';
    throw e;
  }

  const form = new FormData();
  form.append('scan_type', input.scanType);
  form.append('auto_create_context', 'true');
  form.append('product_name', input.repo);
  form.append('engagement_name', input.branch);
  form.append('product_type_name', cfg.ddProductTypeName);
  form.append('scan_date', input.scanDate);
  form.append('close_old_findings', 'true');
  form.append('minimum_severity', 'Low');
  form.append('tags', `git-sha:${input.commit}`);
  form.append('tags', `branch:${input.branch}`);
  form.append('tags', `date:${input.scanDate}`);
  form.append('file', new Blob([file.buffer]), file.originalname || 'report');

  let res;
  try {
    res = await ddFetch(ctx)(`${cfg.defectDojoUrl}/api/v2/import-scan/`, {
      method: 'POST',
      headers: { Authorization: `Token ${apiKey}` },
      body: form,
      signal: signal(ctx),
    });
  } catch (err) {
    throw upstreamError(err, 'defectdojo_unavailable');
  }

  if (res.status >= 400 && res.status < 500) {
    const detail = await safeJson(res);
    const e = new Error('import_rejected');
    e.status = 422;
    e.code = 'import_rejected';
    e.detail = detail;
    throw e;
  }
  if (!res.ok) {
    const e = new Error('defectdojo_unavailable');
    e.status = 502;
    e.code = 'defectdojo_unavailable';
    throw e;
  }

  const data = (await safeJson(res)) || {};
  const stats = extractSeverity(data);
  return {
    status: 200,
    body: {
      productId: data.product_id ?? null,
      engagementId: data.engagement_id ?? null,
      importId: data.test ?? data.test_id ?? null,
      scanType: input.scanType,
      findingsCount: stats.total,
      severity: stats.severity,
    },
  };
}

// --- findings -----------------------------------------------------------------
async function getFindings(ctx, query) {
  const input = validateFindingsQuery(query);
  const cfg = ctx.config;

  let apiKey;
  try {
    apiKey = await ctx.credentials.getDefectDojoApiKey();
  } catch (err) {
    const e = new Error('defectdojo_unconfigured');
    e.status = 503;
    e.code = 'defectdojo_unconfigured';
    throw e;
  }

  const authHeaders = { Authorization: `Token ${apiKey}` };

  const productId = await resolveId(
    ctx,
    `${cfg.defectDojoUrl}/api/v2/products/?name=${encodeURIComponent(input.repo)}`,
    authHeaders
  );
  if (productId === null) return notFound();

  const engagementId = await resolveId(
    ctx,
    `${cfg.defectDojoUrl}/api/v2/engagements/?product=${productId}&name=${encodeURIComponent(input.branch)}`,
    authHeaders
  );
  if (engagementId === null) return notFound();

  let res;
  try {
    res = await ddFetch(ctx)(
      `${cfg.defectDojoUrl}/api/v2/findings/?engagement=${engagementId}&limit=${input.limit}`,
      { headers: authHeaders, signal: signal(ctx) }
    );
  } catch (err) {
    throw upstreamError(err, 'defectdojo_unavailable');
  }
  if (!res.ok) {
    const e = new Error('defectdojo_unavailable');
    e.status = 502;
    e.code = 'defectdojo_unavailable';
    throw e;
  }
  const data = await safeJson(res);
  return { status: 200, body: data };
}

async function resolveId(ctx, url, headers) {
  let res;
  try {
    res = await ddFetch(ctx)(url, { headers, signal: signal(ctx) });
  } catch (err) {
    throw upstreamError(err, 'defectdojo_unavailable');
  }
  if (!res.ok) {
    const e = new Error('defectdojo_unavailable');
    e.status = 502;
    e.code = 'defectdojo_unavailable';
    throw e;
  }
  const data = await safeJson(res);
  if (data && Array.isArray(data.results) && data.results.length > 0) {
    return data.results[0].id;
  }
  return null;
}

function notFound() {
  const e = new Error('not_found');
  e.status = 404;
  e.code = 'not_found';
  throw e;
}

function extractSeverity(data) {
  const severity = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  // DefectDojo import-scan returns a `statistics` block on recent versions.
  const after = data && data.statistics && data.statistics.after;
  if (after) {
    for (const key of Object.keys(severity)) {
      const bucket = after[key.toLowerCase()] || after[key];
      if (bucket && typeof bucket.total === 'number') severity[key] = bucket.total;
    }
  }
  const total = Object.values(severity).reduce((a, b) => a + b, 0);
  return { severity, total };
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function upstreamError(err, code) {
  if (err && err.name === 'TimeoutError') {
    const e = new Error('upstream_timeout');
    e.status = 504;
    e.code = 'upstream_timeout';
    return e;
  }
  const e = new Error(code);
  e.status = 502;
  e.code = code;
  return e;
}

function createDefectDojoRouter(ctx) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES } });

  router.post('/import', (req, res) => {
    upload.single('file')(req, res, async (uploadErr) => {
      if (uploadErr) {
        if (uploadErr.code === 'LIMIT_FILE_SIZE') {
          return res
            .status(413)
            .json({ error: { code: 'file_too_large', message: 'file exceeds 20 MB' } });
        }
        return res
          .status(400)
          .json({ error: { code: 'invalid_request', message: 'invalid multipart upload' } });
      }
      try {
        const result = await importScan(ctx, req.body, req.file);
        res.status(result.status).json(result.body);
      } catch (err) {
        sendError(res, err);
      }
    });
  });

  router.get('/findings', async (req, res) => {
    try {
      const result = await getFindings(ctx, req.query);
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
  const status = err && err.status ? err.status : 502;
  const code = err && err.code ? err.code : 'defectdojo_unavailable';
  const payload = { error: { code, message: err.message || 'DefectDojo operation failed' } };
  if (err && err.detail !== undefined) payload.error.detail = err.detail;
  return res.status(status).json(payload);
}

module.exports = {
  MAX_FILE_BYTES,
  importScan,
  getFindings,
  createDefectDojoRouter,
};
