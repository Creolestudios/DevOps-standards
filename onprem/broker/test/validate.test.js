'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  normalizeProjectKey,
  deriveCid,
  scannerTokenName,
  validateProvisionInput,
  validateImportInput,
  validateFindingsQuery,
  ValidationError,
} = require('../lib/validate');

test('normalizeProjectKey — canonical §3.0 transform', () => {
  const cases = [
    ['My App', 'my-app'],
    ['My_App', 'my_app'],
    ['Acme/Repo', 'acme-repo'],
    ['weird name!@#', 'weird-name---'],
    ['keep.dots:and-colons_ok', 'keep.dots:and-colons_ok'],
    ['UPPER123', 'upper123'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeProjectKey(input), expected, `input=${input}`);
  }
});

test('deriveCid — precedence consumerId > gitEmail > anon', () => {
  const byConsumer = deriveCid({ consumerId: 'ci', gitEmail: 'dev@x.com' });
  const byConsumerOnly = deriveCid({ consumerId: 'ci' });
  assert.equal(byConsumer, byConsumerOnly, 'consumerId wins over gitEmail');

  const byEmail = deriveCid({ gitEmail: 'dev@x.com' });
  const byAnon = deriveCid({});
  assert.notEqual(byEmail, byAnon);
  assert.equal(byAnon, deriveCid({ consumerId: '', gitEmail: '' }));
});

test('deriveCid — deterministic and 12 hex chars', () => {
  const a = deriveCid({ gitEmail: 'dev@creole.com' });
  const b = deriveCid({ gitEmail: 'dev@creole.com' });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{12}$/);
});

test('scannerTokenName — distinct identities never collide (no-clobber)', () => {
  const key = 'my-app';
  const devA = scannerTokenName(key, deriveCid({ gitEmail: 'a@x.com' }));
  const devB = scannerTokenName(key, deriveCid({ gitEmail: 'b@x.com' }));
  const ci = scannerTokenName(key, deriveCid({ consumerId: 'ci' }));
  assert.notEqual(devA, devB);
  assert.notEqual(devA, ci);
  assert.match(devA, /^cs-devtest-my-app-[0-9a-f]{12}$/);
});

test('validateProvisionInput — requires projectKey and projectName', () => {
  assert.throws(() => validateProvisionInput({}), ValidationError);
  assert.throws(() => validateProvisionInput({ projectKey: 'x' }), ValidationError);
  // all-digit key rejected (SonarQube requires a non-digit)
  assert.throws(() => validateProvisionInput({ projectKey: '123', projectName: 'n' }), ValidationError);

  const ok = validateProvisionInput({ projectKey: 'My App', projectName: 'My App' });
  assert.equal(ok.projectKey, 'my-app');
  assert.equal(ok.gitEmailValid, false);
});

test('validateProvisionInput — invalid gitEmail is non-fatal', () => {
  const r = validateProvisionInput({ projectKey: 'app', projectName: 'App', gitEmail: 'not-an-email' });
  assert.equal(r.gitEmailValid, false);
  assert.equal(r.gitEmail, 'not-an-email');

  const good = validateProvisionInput({ projectKey: 'app', projectName: 'App', gitEmail: 'dev@creole.com' });
  assert.equal(good.gitEmailValid, true);
});

test('validateProvisionInput — consumerId charset enforced', () => {
  assert.throws(
    () => validateProvisionInput({ projectKey: 'app', projectName: 'App', consumerId: 'bad id!' }),
    ValidationError
  );
  const ok = validateProvisionInput({ projectKey: 'app', projectName: 'App', consumerId: 'ci-runner-1' });
  assert.equal(ok.consumerId, 'ci-runner-1');
});

test('validateImportInput — required fields + scanType allowlist', () => {
  const file = { buffer: Buffer.from('x'), originalname: 'r.json' };
  assert.throws(() => validateImportInput({}, file), ValidationError);
  assert.throws(() => validateImportInput({ repo: 'r', branch: 'main', commit: 'zzzzzzz' }, file), ValidationError);
  assert.throws(
    () => validateImportInput({ repo: 'r', branch: 'main', commit: 'abc1234', scanType: 'Bogus' }, file),
    ValidationError
  );
  assert.throws(() => validateImportInput({ repo: 'r', branch: 'main', commit: 'abc1234' }, null), ValidationError);

  const ok = validateImportInput({ repo: 'owner/repo', branch: 'main', commit: 'ABC1234' }, file);
  assert.equal(ok.scanType, 'SonarQube Scan');
  assert.equal(ok.commit, 'abc1234');
  assert.match(ok.scanDate, /^\d{4}-\d{2}-\d{2}$/);
});

test('validateFindingsQuery — limit clamped to 1-500', () => {
  assert.equal(validateFindingsQuery({ repo: 'r', branch: 'main', limit: '9000' }).limit, 500);
  assert.equal(validateFindingsQuery({ repo: 'r', branch: 'main', limit: '0' }).limit, 1);
  assert.equal(validateFindingsQuery({ repo: 'r', branch: 'main' }).limit, 500);
  assert.throws(() => validateFindingsQuery({ branch: 'main' }), ValidationError);
});
