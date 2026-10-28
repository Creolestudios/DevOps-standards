'use strict';

// ============================================================================
// Shared helpers: canonical project-key transform, consumer-identity (cid)
// derivation, scanner-token naming, and per-field input validation (§3.0,
// §3.1, §7 of onprem/BROKER_DESIGN.md).
//
// The broker trusts no caller to normalize or validate on its behalf; every
// input is re-checked here server-side.
// ============================================================================

const crypto = require('crypto');

const SCAN_TYPES = ['SonarQube Scan', 'ZAP Scan'];
const DEFAULT_SCAN_TYPE = 'SonarQube Scan';

class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ValidationError';
    this.status = status;
    this.code = status === 413 ? 'file_too_large' : 'invalid_request';
  }
}

// §3.0 canonical transform — authoritative, re-applied server-side.
function normalizeProjectKey(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9._:-]/g, '-');
}

// §3.1 consumer-identity → cid: consumerId, else gitEmail, else "anon",
// hashed so raw emails never appear in SonarQube token names.
function deriveCid({ consumerId, gitEmail } = {}) {
  const identity =
    (consumerId && String(consumerId).trim()) ||
    (gitEmail && String(gitEmail).trim()) ||
    'anon';
  return crypto.createHash('sha256').update(identity).digest('hex').slice(0, 12);
}

function scannerTokenName(projectKey, cid) {
  return `cs-devtest-${projectKey}-${cid}`;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email.trim());
}

// --- /sonar/provision input ---------------------------------------------------
function validateProvisionInput(body) {
  body = body || {};

  if (typeof body.projectKey !== 'string' || body.projectKey.trim() === '') {
    throw new ValidationError('projectKey is required');
  }
  if (body.projectKey.length > 400) {
    throw new ValidationError('projectKey exceeds 400 chars');
  }
  const projectKey = normalizeProjectKey(body.projectKey.trim());
  if (!/^[a-z0-9._:-]+$/.test(projectKey) || !/[^0-9]/.test(projectKey)) {
    throw new ValidationError('projectKey is not a valid SonarQube key after normalization');
  }

  if (typeof body.projectName !== 'string' || body.projectName.trim() === '') {
    throw new ValidationError('projectName is required');
  }
  const projectName = body.projectName.trim();
  if (projectName.length > 255) {
    throw new ValidationError('projectName exceeds 255 chars');
  }

  // consumerId — optional, used only for token scoping.
  let consumerId;
  if (body.consumerId !== undefined && body.consumerId !== null && body.consumerId !== '') {
    if (typeof body.consumerId !== 'string' || body.consumerId.length > 128) {
      throw new ValidationError('consumerId must be a string up to 128 chars');
    }
    consumerId = body.consumerId.trim();
    if (!/^[A-Za-z0-9._@:-]+$/.test(consumerId)) {
      throw new ValidationError('consumerId contains illegal characters');
    }
  }

  // gitEmail — optional; invalid-but-present is NOT fatal (user setup skipped).
  let gitEmail = null;
  let gitEmailValid = false;
  if (body.gitEmail !== undefined && body.gitEmail !== null && body.gitEmail !== '') {
    gitEmail = String(body.gitEmail).trim();
    gitEmailValid = isValidEmail(gitEmail);
  }

  const cid = deriveCid({ consumerId, gitEmail });

  return { projectKey, projectName, consumerId, gitEmail, gitEmailValid, cid };
}

// --- /defectdojo/import input -------------------------------------------------
function validateImportInput(fields, file) {
  fields = fields || {};

  if (!file || !file.buffer) {
    throw new ValidationError('file is required');
  }

  if (typeof fields.repo !== 'string' || fields.repo.trim() === '') {
    throw new ValidationError('repo is required');
  }
  const repo = fields.repo.trim();
  if (repo.length > 255 || !/^[A-Za-z0-9._/-]+$/.test(repo)) {
    throw new ValidationError('repo is invalid');
  }

  if (typeof fields.branch !== 'string' || fields.branch.trim() === '') {
    throw new ValidationError('branch is required');
  }
  const branch = fields.branch.trim();
  if (branch.length > 255) {
    throw new ValidationError('branch exceeds 255 chars');
  }

  if (typeof fields.commit !== 'string' || !/^[0-9a-fA-F]{7,40}$/.test(fields.commit.trim())) {
    throw new ValidationError('commit must be a 7-40 char hex sha');
  }
  const commit = fields.commit.trim().toLowerCase();

  let scanType = DEFAULT_SCAN_TYPE;
  if (fields.scanType !== undefined && fields.scanType !== null && fields.scanType !== '') {
    if (!SCAN_TYPES.includes(fields.scanType)) {
      throw new ValidationError(`scanType must be one of: ${SCAN_TYPES.join(', ')}`);
    }
    scanType = fields.scanType;
  }

  const scanDate = normalizeScanDate(fields.scanDate);

  return { repo, branch, commit, scanType, scanDate };
}

// --- /defectdojo/findings query -----------------------------------------------
function validateFindingsQuery(query) {
  query = query || {};

  if (typeof query.repo !== 'string' || query.repo.trim() === '') {
    throw new ValidationError('repo is required');
  }
  const repo = query.repo.trim();
  if (repo.length > 255 || !/^[A-Za-z0-9._/-]+$/.test(repo)) {
    throw new ValidationError('repo is invalid');
  }

  if (typeof query.branch !== 'string' || query.branch.trim() === '') {
    throw new ValidationError('branch is required');
  }
  const branch = query.branch.trim();
  if (branch.length > 255) {
    throw new ValidationError('branch exceeds 255 chars');
  }

  let limit = 500;
  if (query.limit !== undefined && query.limit !== '') {
    const n = parseInt(query.limit, 10);
    if (Number.isNaN(n)) {
      throw new ValidationError('limit must be an integer');
    }
    limit = Math.min(500, Math.max(1, n));
  }

  return { repo, branch, limit };
}

function normalizeScanDate(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return value.trim();
  }
  return new Date().toISOString().slice(0, 10);
}

module.exports = {
  SCAN_TYPES,
  DEFAULT_SCAN_TYPE,
  ValidationError,
  normalizeProjectKey,
  deriveCid,
  scannerTokenName,
  isValidEmail,
  validateProvisionInput,
  validateImportInput,
  validateFindingsQuery,
  normalizeScanDate,
};
