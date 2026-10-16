import cds from '@sap/cds';
import { validateCertificate } from './lib/bee-rules.js';
import { submitForReview } from './lib/certificate-workflow.js';
import { findBusinessPartner, verifyBusinessPartnerId } from './lib/s4-business-partner.js';
import {
  assertSupplierOwnership,
  assertCertificateOwnership,
  hasRole,
  isProduction,
  requireAuthenticated,
  requireSystemAdmin,
  restrictSupplierRead,
  registerCertificateAttachmentGuard
} from './lib/authorization.js';

const { SELECT, INSERT, UPDATE } = cds.ql;

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getIdentity(req) {
  const identity = requireAuthenticated(req);
  if (isProduction() && (!identity || identity === 'local-dev')) {
    return req.reject(401, 'A valid SAP identity is required to register a supplier.');
  }
  return identity;
}

function assertSupplierRole(req) {
  if (isProduction() && !hasRole(req.user, 'BEE_Supplier_User', 'BEE_Compliance_Officer', 'BEE_System_Admin', 'ComplianceOfficer')) {
    return req.reject(403, 'The B-BBEE Supplier role is required.');
  }
}

async function findLocalSupplier(tx, { taxNumber, registrationNumber, businessPartnerId }) {
  const found = [];
  if (taxNumber) found.push(...await tx.run(SELECT.from('cc.bbbee.Suppliers').where({ taxNumber }).limit(2)));
  if (registrationNumber) found.push(...await tx.run(SELECT.from('cc.bbbee.Suppliers').where({ registrationNumber }).limit(2)));
  if (businessPartnerId) found.push(...await tx.run(SELECT.from('cc.bbbee.Suppliers').where({ businessPartnerId }).limit(2)));
  const unique = new Map(found.map(supplier => [supplier.ID, supplier]));
  if (unique.size > 1 || found.length > 3) {
    throw new RangeError('The supplied identifiers resolve to different local supplier records. Resolve duplicates before continuing.');
  }
  return unique.size ? [...unique.values()][0] : null;
}

async function linkLocalSupplier(tx, req, supplier, { identity, taxNumber, registrationNumber, contactEmail }) {
  if (isProduction() && supplier.identitySubject && supplier.identitySubject !== identity) {
    return req.reject(409, 'This supplier is already linked to a different signed-in identity. Contact the compliance administrator.');
  }
  const patch = {};
  if (!supplier.identitySubject && identity !== 'local-dev') patch.identitySubject = identity;
  if (!supplier.taxNumber && taxNumber) patch.taxNumber = taxNumber;
  if (!supplier.registrationNumber && registrationNumber) patch.registrationNumber = registrationNumber;
  if (contactEmail && supplier.contactEmail !== contactEmail) patch.contactEmail = contactEmail;
  if (Object.keys(patch).length) {
    await tx.run(UPDATE('cc.bbbee.Suppliers').set(patch).where({ ID: supplier.ID }));
    if (Object.hasOwn(patch, 'contactEmail')) {
      await tx.run(INSERT.into('cc.bbbee.AuditTrail').entries({
        ID: cds.utils.uuid(), supplier_ID: supplier.ID, action: 'SupplierContactUpdated', performedBy: identity,
        remarks: 'Supplier contact email updated for compliance notifications.',
        fieldDeltas: JSON.stringify({ contactEmailChanged: true })
      }));
    }
    supplier = { ...supplier, ...patch };
  }
  return supplier;
}

async function matchSupplier(req) {
  assertSupplierRole(req);
  const identity = getIdentity(req);
  const tx = cds.tx(req);
  const companyName = clean(req.data.companyName);
  const taxNumber = clean(req.data.taxNumber);
  const registrationNumber = clean(req.data.registrationNumber);
  const contactEmail = clean(req.data.contactEmail);

  if (!companyName) return req.reject(400, 'Company name is required.');
  if (companyName.length > 100) return req.reject(400, 'Company name cannot exceed 100 characters.');
  if (!taxNumber && !registrationNumber) return req.reject(400, 'Provide a tax number or a CIPC registration number.');
  if (taxNumber && !/^\d{10}$/.test(taxNumber)) return req.reject(400, 'A South African company tax number must contain 10 digits.');
  if (registrationNumber && !/^[A-Za-z0-9/-]{4,20}$/.test(registrationNumber)) return req.reject(400, 'The CIPC registration number format is invalid.');
  if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) return req.reject(400, 'Enter a valid contact email address.');

  let supplier;
  let s4Match = null;
  try {
    supplier = await findLocalSupplier(tx, { taxNumber, registrationNumber });
  } catch (error) {
    return req.reject(409, error.message);
  }

  // Legacy/local records without a BP ID are reconciled with S/4 before a supplier match is returned.
  // A lookup failure is never treated as a confirmed match.
  if (!supplier || !supplier.businessPartnerId) {
    try {
      s4Match = await findBusinessPartner({ taxNumber, registrationNumber });
    } catch (error) {
      s4Match = { matched: false, source: 'S4_LOOKUP_FAILED', message: error?.message ?? 'Unknown S/4HANA lookup error.' };
    }
  }

  if (supplier) {
    if (taxNumber && supplier.taxNumber && supplier.taxNumber !== taxNumber) return req.reject(409, 'The supplied tax number conflicts with the supplier record.');
    if (registrationNumber && supplier.registrationNumber && supplier.registrationNumber.toUpperCase() !== registrationNumber.toUpperCase()) return req.reject(409, 'The supplied registration number conflicts with the supplier record.');
    if (!supplier.businessPartnerId && s4Match?.matched && s4Match.businessPartnerId) {
      const conflict = await tx.run(SELECT.from('cc.bbbee.Suppliers').where({ businessPartnerId: s4Match.businessPartnerId }).limit(2));
      if (conflict.some(item => item.ID !== supplier.ID)) return req.reject(409, 'The S/4HANA Business Partner is already linked to another local supplier. Resolve the duplicate before continuing.');
      await tx.run(UPDATE('cc.bbbee.Suppliers').set({
        businessPartnerId: s4Match.businessPartnerId,
        s4SyncStatus: 'Linked',
        s4SyncMessage: 'Legacy supplier reconciled against API_BUSINESS_PARTNER.'
      }).where({ ID: supplier.ID }));
      await tx.run(INSERT.into('cc.bbbee.AuditTrail').entries({
        ID: cds.utils.uuid(), supplier_ID: supplier.ID, action: 'SupplierLinkedToS4', performedBy: identity,
        remarks: `Legacy supplier reconciled using ${s4Match.source}.`,
        fieldDeltas: JSON.stringify({ businessPartnerId: { before: null, after: s4Match.businessPartnerId } })
      }));
      supplier = { ...supplier, businessPartnerId: s4Match.businessPartnerId, s4SyncStatus: 'Linked' };
    }
    supplier = await linkLocalSupplier(tx, req, supplier, { identity, taxNumber, registrationNumber, contactEmail });
    return {
      matched: true,
      requiresOnboarding: false,
      source: supplier.businessPartnerId ? (s4Match?.matched ? s4Match.source : 'LOCAL_REGISTRY') : 'LOCAL_REGISTRY',
      supplierID: supplier.ID,
      businessPartnerId: supplier.businessPartnerId ?? null,
      companyName: supplier.companyName,
      onboardingRequestID: null,
      message: supplier.businessPartnerId && s4Match?.matched
        ? 'Your details matched the local supplier and S/4HANA Business Partner records.'
        : 'Your details matched an existing supplier record.'
    };
  }

  // Resolve identifiers against the released S/4HANA Business Partner API.
  // A destination/network/API problem fails closed into the staging queue; it never fabricates a BP ID.
  if (!s4Match) {
    try {
      s4Match = await findBusinessPartner({ taxNumber, registrationNumber });
    } catch (error) {
      s4Match = { matched: false, source: 'S4_LOOKUP_FAILED', message: error?.message ?? 'Unknown S/4HANA lookup error.' };
    }
  }

  if (s4Match.matched && s4Match.businessPartnerId) {
    const existingByBp = await tx.run(SELECT.from('cc.bbbee.Suppliers').where({ businessPartnerId: s4Match.businessPartnerId }).limit(2));
    if (existingByBp.length > 1) return req.reject(409, 'Multiple local suppliers already reference this S/4HANA Business Partner. Resolve the duplicates first.');
    if (existingByBp.length === 1) {
      const linked = await linkLocalSupplier(tx, req, existingByBp[0], { identity, taxNumber, registrationNumber, contactEmail });
      return {
        matched: true,
        requiresOnboarding: false,
        source: s4Match.source,
        supplierID: linked.ID,
        businessPartnerId: linked.businessPartnerId,
        companyName: linked.companyName,
        onboardingRequestID: null,
        message: 'Your identifiers matched an existing S/4HANA Business Partner.'
      };
    }

    const supplierID = cds.utils.uuid();
    const s4CompanyName = clean(s4Match.companyName) || companyName;
    await tx.run(INSERT.into('cc.bbbee.Suppliers').entries({
      ID: supplierID,
      businessPartnerId: s4Match.businessPartnerId,
      identitySubject: identity === 'local-dev' ? null : identity,
      companyName: s4CompanyName,
      taxNumber: taxNumber || null,
      registrationNumber: registrationNumber || null,
      contactEmail: contactEmail || null,
      s4SyncStatus: 'Linked',
      s4SyncMessage: 'Matched against API_BUSINESS_PARTNER.'
    }));
    await tx.run(INSERT.into('cc.bbbee.AuditTrail').entries({
      ID: cds.utils.uuid(), supplier_ID: supplierID, action: 'SupplierLinkedToS4', performedBy: identity,
      remarks: `Matched identifiers using ${s4Match.source}.`, fieldDeltas: JSON.stringify({ businessPartnerId: { before: null, after: s4Match.businessPartnerId } })
    }));
    return {
      matched: true,
      requiresOnboarding: false,
      source: s4Match.source,
      supplierID,
      businessPartnerId: s4Match.businessPartnerId,
      companyName: s4CompanyName,
      onboardingRequestID: null,
      message: 'Your identifiers matched an S/4HANA Business Partner and the local supplier record was linked.'
    };
  }

  const whereTerms = [];
  if (taxNumber) whereTerms.push(await tx.run(SELECT.from('cc.bbbee.SupplierOnboardingRequests').where({ taxNumber, status: 'Pending' }).limit(2)));
  if (registrationNumber) whereTerms.push(await tx.run(SELECT.from('cc.bbbee.SupplierOnboardingRequests').where({ registrationNumber, status: 'Pending' }).limit(2)));
  const requests = new Map(whereTerms.flat().map(item => [item.ID, item]));
  if (requests.size > 1) return req.reject(409, 'The identifiers match different pending onboarding requests. Contact the compliance administrator.');

  let onboardingRequest = requests.size ? [...requests.values()][0] : null;
  if (onboardingRequest && isProduction() && onboardingRequest.requestedByIdentity && onboardingRequest.requestedByIdentity !== identity) {
    return req.reject(409, 'An onboarding request already exists for these identifiers. Contact the compliance administrator if you believe this is your company.');
  }
  if (!onboardingRequest) {
    const onboardingRequestID = cds.utils.uuid();
    await tx.run(INSERT.into('cc.bbbee.SupplierOnboardingRequests').entries({
      ID: onboardingRequestID,
      proposedCompanyName: companyName,
      registrationNumber: registrationNumber || null,
      taxNumber: taxNumber || null,
      contactEmail: contactEmail || null,
      requestedByIdentity: identity === 'local-dev' ? null : identity,
      status: 'Pending',
      reviewNotes: s4Match.message ? `S/4HANA lookup: ${s4Match.message}` : null
    }));
    onboardingRequest = { ID: onboardingRequestID };
  }

  return {
    matched: false,
    requiresOnboarding: true,
    source: s4Match.source || 'ONBOARDING_STAGING',
    supplierID: null,
    businessPartnerId: null,
    companyName,
    onboardingRequestID: onboardingRequest.ID,
    message: s4Match.message
      ? `No confirmed Business Partner match was available. Your request is in the compliance onboarding queue (${s4Match.source}).`
      : 'No Business Partner matched the supplied identifiers. Your request is in the compliance onboarding queue.'
  };
}

export async function approveOnboardingRequest(req) {
  const identity = requireSystemAdmin(req);
  const tx = cds.tx(req);
  const requestID = clean(req.data?.requestID ?? req.params?.[0]?.ID ?? req.params?.[0]?.id);
  const suppliedBP = clean(req.data?.businessPartnerId);
  const remarks = clean(req.data?.remarks);
  if (!requestID) return req.reject(400, 'requestID is required.');
  const request = await tx.run(SELECT.one.from('cc.bbbee.SupplierOnboardingRequests').where({ ID: requestID }));
  if (!request) return req.reject(404, 'Onboarding request not found.');
  if (request.status !== 'Pending') return req.reject(409, 'Only pending onboarding requests can be approved.');

  let businessPartnerId = suppliedBP;
  if (businessPartnerId) {
    if (!remarks) return req.reject(400, "Explain the administrator's manual Business Partner selection in the approval remarks.");
    try {
      const verified = await verifyBusinessPartnerId(businessPartnerId);
      if (!verified) return req.reject(409, 'The entered Business Partner ID does not exist in the connected S/4HANA system.');
    } catch (error) {
      return req.reject(503, `The entered Business Partner could not be verified against S/4HANA: ${error.message}`);
    }
  } else {
    try {
      const match = await findBusinessPartner({ taxNumber: request.taxNumber, registrationNumber: request.registrationNumber });
      if (match.matched) businessPartnerId = match.businessPartnerId;
      else return req.reject(409, `The identifiers do not currently resolve to one confirmed Business Partner (${match.source || 'lookup failed'}). Enter a verified BP ID with an administrator rationale to complete manual resolution.`);
    } catch (error) {
      return req.reject(503, `S/4HANA identifier lookup failed: ${error.message}`);
    }
  }
  if (!/^[A-Za-z0-9]{1,10}$/.test(businessPartnerId || '')) return req.reject(400, 'Enter a valid S/4HANA Business Partner ID, or ensure the S/4HANA destination resolves the supplier identifiers.');

  const conflict = await tx.run(SELECT.from('cc.bbbee.Suppliers').where({ businessPartnerId }).limit(2));
  if (conflict.length) return req.reject(409, 'This Business Partner is already linked to a local supplier. Resolve the duplicate before approving onboarding.');
  if (request.taxNumber && (await tx.run(SELECT.from('cc.bbbee.Suppliers').where({ taxNumber: request.taxNumber }).limit(1))).length) return req.reject(409, 'This tax number is already linked to another supplier.');
  if (request.registrationNumber && (await tx.run(SELECT.from('cc.bbbee.Suppliers').where({ registrationNumber: request.registrationNumber }).limit(1))).length) return req.reject(409, 'This registration number is already linked to another supplier.');

  const supplierID = cds.utils.uuid();
  await tx.run(INSERT.into('cc.bbbee.Suppliers').entries({
    ID: supplierID,
    businessPartnerId,
    identitySubject: request.requestedByIdentity || null,
    companyName: request.proposedCompanyName,
    registrationNumber: request.registrationNumber || null,
    taxNumber: request.taxNumber || null,
    contactEmail: request.contactEmail || null,
    s4SyncStatus: 'Linked',
    s4SyncMessage: 'Linked by compliance administrator during onboarding.'
  }));
  await tx.run(UPDATE('cc.bbbee.SupplierOnboardingRequests').set({
    status: 'Matched', matchedSupplier_ID: supplierID, reviewedBy: identity,
    reviewedAt: new Date().toISOString(), reviewNotes: remarks || 'Onboarding approved.'
  }).where({ ID: requestID }));
  await tx.run(INSERT.into('cc.bbbee.AuditTrail').entries({
    ID: cds.utils.uuid(), supplier_ID: supplierID, onboardingRequest_ID: requestID,
    action: 'ApproveOnboarding', performedBy: identity,
    remarks: remarks || 'Supplier linked to S/4HANA Business Partner.',
    fieldDeltas: JSON.stringify({ businessPartnerId: { before: null, after: businessPartnerId }, status: { before: 'Pending', after: 'Matched' } })
  }));
  return { requestID, supplierID, businessPartnerId, status: 'Matched', message: 'Supplier was linked to S/4HANA and the onboarding request was approved.' };
}

export async function rejectOnboardingRequest(req) {
  const identity = requireSystemAdmin(req);
  const tx = cds.tx(req);
  const requestID = clean(req.data?.requestID ?? req.params?.[0]?.ID ?? req.params?.[0]?.id);
  const remarks = clean(req.data?.remarks);
  if (!requestID) return req.reject(400, 'requestID is required.');
  if (!remarks) return req.reject(400, 'Rejection remarks are mandatory.');
  const request = await tx.run(SELECT.one.from('cc.bbbee.SupplierOnboardingRequests').where({ ID: requestID }));
  if (!request) return req.reject(404, 'Onboarding request not found.');
  if (request.status !== 'Pending') return req.reject(409, 'Only pending onboarding requests can be rejected.');
  await tx.run(UPDATE('cc.bbbee.SupplierOnboardingRequests').set({
    status: 'Rejected', reviewedBy: identity, reviewedAt: new Date().toISOString(), reviewNotes: remarks
  }).where({ ID: requestID }));
  await tx.run(INSERT.into('cc.bbbee.AuditTrail').entries({
    ID: cds.utils.uuid(), onboardingRequest_ID: requestID, action: 'RejectOnboarding', performedBy: identity,
    remarks, fieldDeltas: JSON.stringify({ status: { before: 'Pending', after: 'Rejected' } })
  }));
  return { requestID, supplierID: null, businessPartnerId: null, status: 'Rejected', message: 'Onboarding request rejected with an audit record.' };
}

async function validateAndMergeCertificate(req) {
  try {
    const input = req.data ?? {};
    let existing = {};
    if (req.event === 'UPDATE') {
      const id = input.ID ?? req.params?.[0]?.ID ?? req.params?.[0]?.id;
      if (id) existing = await cds.tx(req).run(SELECT.one.from('cc.bbbee.Certificates').where({ ID: id })) ?? {};
      if (existing.status === 'Approved') return req.reject(409, 'Approved certificates are immutable; submit a replacement certificate instead.');
      if (existing.status === 'PendingReview') return req.reject(409, 'Certificates in review cannot be edited. Request resubmission first.');
      if (input.supplier_ID && existing.supplier_ID && input.supplier_ID !== existing.supplier_ID) return req.reject(400, 'A certificate cannot be reassigned to another supplier.');
    }
    const merged = { ...existing, ...input };
    validateCertificate(merged);
  } catch (error) {
    if (error?.status || error?.code) throw error;
    req.reject(400, error.message);
  }
}

export default class SupplierService extends cds.ApplicationService {
  async init() {
    this.before('READ', 'Suppliers', req => restrictSupplierRead(req, 'Suppliers'));
    this.before('READ', 'Certificates', req => restrictSupplierRead(req, 'Certificates'));
    this.before('READ', 'SupplierOnboardingRequests', req => restrictSupplierRead(req, 'SupplierOnboardingRequests'));
    registerCertificateAttachmentGuard(this);

    this.before('CREATE', 'Suppliers', req => req.reject(405, 'Supplier records are created through matchSupplier or the administrator onboarding workflow.'));
    this.before('UPDATE', 'Suppliers', async req => {
      const allowed = new Set(['ID', 'contactEmail']);
      const unexpected = Object.keys(req.data ?? {}).filter(key => !allowed.has(key));
      if (unexpected.length) return req.reject(403, 'Supplier identity, S/4HANA links and compliance values are maintained by backend workflows.');
      const id = req.data?.ID ?? req.params?.[0]?.ID ?? req.params?.[0]?.id;
      if (!id) return req.reject(400, 'Supplier ID is required.');
      await assertSupplierOwnership(req, id);
      if (req.data?.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(req.data.contactEmail)) return req.reject(400, 'Enter a valid contact email address.');
    });

    this.before('CREATE', 'Certificates', async req => {
      assertSupplierRole(req);
      const identity = getIdentity(req);
      if (req.data?.status && req.data.status !== 'Draft') return req.reject(400, 'Certificates must be created as Draft and submitted through the workflow.');
      if (!req.data?.supplier_ID) return req.reject(400, 'Select a supplier record before creating a certificate.');
      await assertSupplierOwnership(req, req.data.supplier_ID);
      await validateAndMergeCertificate(req);
    });
    this.before('UPDATE', 'Certificates', async req => {
      assertSupplierRole(req);
      if (Object.hasOwn(req.data ?? {}, 'status')) return req.reject(400, 'Direct status changes are forbidden. Use the compliance workflow actions.');
      const id = req.data?.ID ?? req.params?.[0]?.ID ?? req.params?.[0]?.id;
      if (id) await assertCertificateOwnership(req, id);
      await validateAndMergeCertificate(req);
    });
    this.before('submitForReview', 'Certificates', async req => {
      assertSupplierRole(req);
      await assertCertificateOwnership(req, req.params?.[0]?.ID ?? req.params?.[0]?.id ?? req.data?.certificateID);
    });
    this.before('DELETE', 'Certificates', req => req.reject(405, 'Certificates are audit records and cannot be deleted.'));

    this.on('matchSupplier', matchSupplier);
    this.on('submitForReview', 'Certificates', submitForReview);
    this.on('approveOnboardingRequest', approveOnboardingRequest);
    this.on('rejectOnboardingRequest', rejectOnboardingRequest);
    return super.init();
  }
}
