/** Pure helpers for the local S/4 Business Partner simulation. */
export function matchMockBusinessPartner(rows, { taxNumber, registrationNumber }) {
  const tax = String(taxNumber ?? '').trim();
  const registration = String(registrationNumber ?? '').trim().toUpperCase();
  if (!tax && !registration) {
    return { matched: false, source: 'NO_IDENTIFIERS', businessPartnerId: null };
  }

  const byTax = tax ? rows.filter(row => String(row.taxNumber ?? '').trim() === tax) : null;
  const byRegistration = registration
    ? rows.filter(row => String(row.registrationNumber ?? '').trim().toUpperCase() === registration)
    : null;

  if (byTax && byTax.length > 1 || byRegistration && byRegistration.length > 1) {
    return { matched: false, ambiguous: true, source: 'MOCK_AMBIGUOUS', businessPartnerId: null };
  }
  if (byTax && byTax.length === 0 || byRegistration && byRegistration.length === 0) {
    return { matched: false, source: 'MOCK_NOT_FOUND', businessPartnerId: null };
  }

  const candidates = [byTax?.[0], byRegistration?.[0]].filter(Boolean);
  const ids = [...new Set(candidates.map(row => String(row.businessPartnerId)))];
  if (ids.length !== 1) {
    return { matched: false, ambiguous: true, source: 'MOCK_IDENTIFIER_CONFLICT', businessPartnerId: null };
  }
  return {
    matched: true,
    source: 'MOCK_BUSINESS_PARTNER_REGISTRY',
    businessPartnerId: ids[0],
    companyName: candidates[0].companyName
  };
}

export function buildMockComplianceUpdate(supplier, certificate) {
  const nonCompliant = supplier.currentComplianceState === 'NonCompliant' || Boolean(certificate?.isNonCompliant);
  return {
    beeLevel: nonCompliant ? null : (supplier.currentBEELevel ?? certificate?.beeLevel ?? null),
    recognitionFactor: nonCompliant ? 0 : (supplier.recognitionFactor == null ? null : Number(supplier.recognitionFactor)),
    certificateExpiry: certificate?.expiryDate ?? null,
    enterpriseType: certificate?.enterpriseType ?? null,
    complianceStatus: nonCompliant ? 'NonCompliant' : (supplier.currentComplianceState ?? 'Unknown'),
    blackOwnership: certificate?.blackOwnership == null ? null : Number(certificate.blackOwnership),
    blackWomenOwnership: certificate?.blackWomenOwnership == null ? null : Number(certificate.blackWomenOwnership)
  };
}
