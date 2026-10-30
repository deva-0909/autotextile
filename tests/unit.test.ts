import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_PERMISSION_CODES, BASELINE_ROLES, gstinCheckChar, gstinProblem, panOfGstin } from '@erp/platform';
import { base32Decode, base32Encode, hashPassword, passwordProblem, totp, verifyPassword, verifyTotp } from '../services/identity/src/security.ts';
import { validateAttributes } from '../services/masters/src/catalog.ts';

test('GSTIN check digit, format and state validation', () => {
  assert.equal(gstinCheckChar('27AAPFU0939F1Z'), 'V'); // published example GSTIN 27AAPFU0939F1ZV
  assert.equal(gstinProblem('27AAPFU0939F1ZV'), null);
  assert.match(gstinProblem('27AAPFU0939F1ZX')!, /check digit/);
  assert.match(gstinProblem('99AAPFU0939F1ZV')!, /state code/);
  assert.match(gstinProblem('27AAPFU0939F1Z')!, /15 characters/);
  assert.equal(panOfGstin('27AAPFU0939F1ZV'), 'AAPFU0939F');
});

test('password hashing and policy', async () => {
  const h = await hashPassword('Correct#Horse9');
  assert.ok(h.startsWith('scrypt$'));
  assert.equal(await verifyPassword('Correct#Horse9', h), true);
  assert.equal(await verifyPassword('wrong', h), false);
  assert.match(passwordProblem('short')!, /10 characters/);
  assert.match(passwordProblem('alllowercase123!')!, /upper and lower/);
  assert.equal(passwordProblem('Textile@2026'), null);
});

test('TOTP matches RFC 6238 test vector and tolerates one step of drift', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.deepEqual(base32Decode(secret), Buffer.from('12345678901234567890'));
  assert.equal(totp(secret, 59_000), '287082'); // RFC 6238 SHA-1, T=59s (last 6 digits of 94287082)
  const now = Date.now();
  assert.equal(verifyTotp(secret, totp(secret, now - 30_000), now), true);
  assert.equal(verifyTotp(secret, totp(secret, now - 90_000), now), false);
});

test('baseline roles only reference catalog permissions', () => {
  for (const r of BASELINE_ROLES) for (const p of r.permissions) assert.ok(ALL_PERMISSION_CODES.includes(p), `${r.code} → ${p}`);
  assert.equal(BASELINE_ROLES.length, 22);
});

test('fabric attribute validation', () => {
  const defs = [
    { key: 'gsm', label: 'GSM', data_type: 'number', options: null, min_value: 60, max_value: 600, required: true, level: 'product' },
    { key: 'knit_type', label: 'Knit type', data_type: 'select', options: ['Single jersey', 'Rib 1x1'], min_value: null, max_value: null, required: true, level: 'product' },
    { key: 'finish', label: 'Finish', data_type: 'multiselect', options: ['Bio-wash', 'Peach'], min_value: null, max_value: null, required: false, level: 'product' },
  ];
  const good = validateAttributes(defs, { gsm: '180', knit_type: 'Single jersey', finish: ['Peach'] });
  assert.deepEqual(good.errors, {});
  assert.deepEqual(good.values, { gsm: 180, knit_type: 'Single jersey', finish: ['Peach'] });
  const bad = validateAttributes(defs, { gsm: 20, knit_type: 'Velvet', finish: ['Glitter'], colour: 'red' });
  assert.match(bad.errors['attributes.gsm']!, /at least 60/);
  assert.match(bad.errors['attributes.knit_type']!, /valid/);
  assert.match(bad.errors['attributes.finish']!, /valid/);
  assert.match(bad.errors['attributes.colour']!, /not defined/);
  assert.match(validateAttributes(defs, {}).errors['attributes.gsm']!, /required/);
});
