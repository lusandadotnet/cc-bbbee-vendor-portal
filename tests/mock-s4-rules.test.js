import test from 'node:test';
import assert from 'node:assert/strict';
import { matchMockBusinessPartner, buildMockComplianceUpdate } from '../srv/lib/mock-s4-rules.js';

const partners = [
  { businessPartnerId: '7000000001', companyName: 'Ubuntu Industrial Supplies (Pty) Ltd', taxNumber: '9123456789', registrationNumber: '2015/123456/07' },
  { businessPartnerId: '7000000002', companyName: 'Sakhile Plant Services (Pty) Ltd', taxNumber: '9876543210', registrationNumber: '2018/654321/07' }
];

test('mock Business Partner matches by tax number', () => {
  const result = matchMockBusinessPartner(partners, { taxNumber: '9123456789' });
  assert.equal(result.matched, true);
  assert.equal(result.businessPartnerId, '7000000001');
  assert.equal(result.source, 'MOCK_BUSINESS_PARTNER_REGISTRY');
});

test('mock Business Partner matches registration number case-insensitively', () => {
  const result = matchMockBusinessPartner(partners, { registrationNumber: '2015/123456/07' });
  assert.equal(result.matched, true);
  assert.equal(result.companyName, 'Ubuntu Industrial Supplies (Pty) Ltd');
});

test('when both identifiers are supplied they must point to the same partner', () => {
  const result = matchMockBusinessPartner(partners, { taxNumber: '9123456789', registrationNumber: '2018/654321/07' });
  assert.equal(result.matched, false);
  assert.equal(result.ambiguous, true);
  assert.equal(result.source, 'MOCK_IDENTIFIER_CONFLICT');
});

test('unknown mock partner is not fabricated', () => {
  const result = matchMockBusinessPartner(partners, { taxNumber: '9999999999' });
  assert.equal(result.matched, false);
  assert.equal(result.source, 'MOCK_NOT_FOUND');
});

test('ambiguous mock identifiers are rejected instead of choosing the first row', () => {
  const result = matchMockBusinessPartner([
    ...partners,
    { businessPartnerId: '7000000003', companyName: 'Duplicate tax record', taxNumber: '9123456789' }
  ], { taxNumber: '9123456789' });
  assert.equal(result.matched, false);
  assert.equal(result.ambiguous, true);
});

test('approved compliant certificate sync produces mock compliance values', () => {
  const result = buildMockComplianceUpdate({ currentComplianceState: 'Compliant', currentBEELevel: 4, recognitionFactor: 100 }, {
    expiryDate: '2027-10-10', enterpriseType: 'GEN', blackOwnership: 51, blackWomenOwnership: 30, isNonCompliant: false
  });
  assert.deepEqual(result, {
    beeLevel: 4, recognitionFactor: 100, certificateExpiry: '2027-10-10', enterpriseType: 'GEN',
    complianceStatus: 'Compliant', blackOwnership: 51, blackWomenOwnership: 30
  });
});

test('expired/non-compliant supplier sync clears level and sets recognition factor to zero', () => {
  const result = buildMockComplianceUpdate({ currentComplianceState: 'NonCompliant', currentBEELevel: 4, recognitionFactor: 0 }, {
    expiryDate: '2025-01-01', enterpriseType: 'GEN', isNonCompliant: true
  });
  assert.equal(result.beeLevel, null);
  assert.equal(result.recognitionFactor, 0);
  assert.equal(result.complianceStatus, 'NonCompliant');
});
