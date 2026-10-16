import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateRecognitionFactor,
  deriveOwnershipFlags,
  validateCertificateDates,
  validateCertificate
} from '../srv/lib/bee-rules.js';

test('calculates every recognition factor', () => {
  const expected = [135, 125, 110, 100, 80, 60, 50, 10];

  for (let level = 1; level <= 8; level++) {
    assert.equal(calculateRecognitionFactor(level), expected[level - 1]);
  }

  assert.equal(calculateRecognitionFactor(undefined, true), 0);
});

test('rejects invalid B-BBEE levels', () => {
  for (const level of [0, 9, 1.5, '1', null]) {
    assert.throws(() => calculateRecognitionFactor(level), RangeError);
  }
});

test('derives ownership flags at the exact thresholds', () => {
  assert.deepEqual(deriveOwnershipFlags(51, 30), {
    isBlackOwned: true,
    isBlackWomenOwned: true
  });

  assert.deepEqual(deriveOwnershipFlags(50.99, 29.99), {
    isBlackOwned: false,
    isBlackWomenOwned: false
  });
});

test('rejects impossible ownership percentages', () => {
  assert.throws(() => deriveOwnershipFlags(-1, 0), RangeError);
  assert.throws(() => deriveOwnershipFlags(101, 30), RangeError);
  assert.throws(() => deriveOwnershipFlags(40, 45), RangeError);
});

test('accepts a valid certificate lasting 365 days', () => {
  assert.deepEqual(
    validateCertificateDates('2025-01-01', '2026-01-01', '2025-06-01'),
    { validityDays: 365 }
  );
});

test('rejects certificates valid for more than 365 days', () => {
  assert.throws(
    () => validateCertificateDates('2025-01-01', '2026-01-02', '2025-06-01'),
    /cannot exceed 365/
  );
});

test('rejects expired certificates', () => {
  assert.throws(
    () => validateCertificateDates('2024-01-01', '2024-12-31', '2025-01-01'),
    /expired/
  );
});

test('rejects invalid calendar dates and reversed date ranges', () => {
  assert.throws(
    () => validateCertificateDates('2025-02-30', '2025-12-01', '2025-03-01'),
    /valid calendar date/
  );

  assert.throws(
    () => validateCertificateDates('2025-06-01', '2025-05-31', '2025-06-01'),
    /cannot precede/
  );
});

test('requires dates when a certificate enters review', () => {
  assert.throws(
    () => validateCertificate({ status: 'PendingReview' }, { today: '2025-06-01' }),
    /required/
  );
});

test('allows an incomplete draft', () => {
  assert.equal(
    validateCertificate({ status: 'Draft' }, { today: '2025-06-01' }),
    true
  );
});

test('rejects a non-compliant certificate with a B-BBEE level', () => {
  assert.throws(
    () => validateCertificate({
      status: 'Draft',
      isNonCompliant: true,
      beeLevel: 4
    }),
    /must not have a B-BBEE level/
  );
});
