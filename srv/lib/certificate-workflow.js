import cds from '@sap/cds';
import { enqueueIntegrationEvent } from './automation.js';
import { hasRole, isProduction } from './authorization.js';
import {
  calculateRecognitionFactor,
  deriveOwnershipFlags,
  validateCertificateDates
} from './bee-rules.js';

const { SELECT, INSERT, UPDATE } = cds.ql;

const CERTIFICATE_AUDIT_FIELDS = [
  'certificateNumber',
  'documentType',
  'extractedEntityName',
  'extractedRegistrationNumber',
  'sanasAgencyNumber',
  'enterpriseType',
  'beeLevel',
  'isNonCompliant',
  'blackOwnership',
  'blackWomenOwnership',
  'empoweringSupplier',
  'issueDate',
  'expiryDate',
  'status',
  'rejectionReason'
];

const SUPPLIER_AUDIT_FIELDS = [
  'currentBEELevel',
  'currentComplianceState',
  'recognitionFactor',
  'isBlackOwned',
  'isBlackWomenOwned',
  'activeCertificate_ID'
];

function certificateIDFromRequest(req) {
  return req.data?.certificateID ??
    req.params?.[0]?.ID ??
    req.params?.[0]?.id ??
    null;
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function required(value, label) {
  if (value === null || value === undefined || clean(String(value)) === '') {
    throw new RangeError(`${label} is required before submission or approval.`);
  }
}

function dateString(value, label) {
  if (!value) {
    throw new RangeError(`${label} is required.`);
  }

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  return String(value).slice(0, 10);
}

function actorId(req, requireOfficer = false) {
  const user = req.user;
  const production = isProduction();

  if (production && (!user?.id || user.id === 'anonymous')) {
    return req.reject(401, 'Authentication is required for this action.');
  }

  if (production && requireOfficer &&
      !hasRole(user, 'BEE_Compliance_Officer', 'BEE_System_Admin', 'ComplianceOfficer')) {
    return req.reject(403, 'The ComplianceOfficer role is required.');
  }

  // Local CAP mocked authentication only. Production never records
  // an anonymous/local-development actor.
  return user?.id && user.id !== 'anonymous' ? user.id : 'local-dev';
}

async function loadCertificate(tx, req, certificateID) {
  const certificate = await tx.run(
    SELECT.one.from('cc.bbbee.Certificates')
      .where({ ID: certificateID })
  );

  if (!certificate) {
    req.reject(404, 'Certificate not found.');
  }

  return certificate;
}

async function loadSupplier(tx, req, supplierID) {
  const supplier = await tx.run(
    SELECT.one.from('cc.bbbee.Suppliers')
      .where({ ID: supplierID })
  );

  if (!supplier) {
    req.reject(409, 'The certificate has no valid supplier record.');
  }

  return supplier;
}

async function requireCleanEvidence(tx, req, certificateID) {
  const attachments = await tx.run(
    SELECT.from('cc.bbbee.Certificates.attachments')
      .columns('ID', 'filename', 'mimeType', 'status')
      .where({ up__ID: certificateID })
  );
  if (!attachments.length) {
    return req.reject(400, 'Upload the certificate or affidavit evidence before submission or approval.');
  }
  const cleanAttachment = attachments.find(attachment => attachment.status === 'Clean');
  if (!cleanAttachment) {
    const statuses = [...new Set(attachments.map(attachment => attachment.status || 'Unknown'))].join(', ');
    return req.reject(409, `The evidence must pass malware scanning before submission or approval. Current attachment status: ${statuses}.`);
  }
  const allowedMimeTypes = ['application/pdf', 'image/png', 'image/jpeg'];
  if (!allowedMimeTypes.includes(cleanAttachment.mimeType)) {
    return req.reject(400, 'The uploaded evidence must be PDF, PNG or JPEG.');
  }
  return cleanAttachment;
}

function validateForReview(certificate, supplier) {
  required(certificate.certificateNumber, 'Certificate number');
  required(certificate.extractedEntityName, 'Certificate entity name');
  required(certificate.extractedRegistrationNumber, 'Certificate registration number');
  required(certificate.enterpriseType, 'Enterprise type');

  if (!['EME', 'QSE', 'GEN'].includes(certificate.enterpriseType)) {
    throw new RangeError('Enterprise type must be EME, QSE, or GEN.');
  }

  // Infer the only valid category for EME and Generic documents to retain
  // compatibility with existing drafts. QSE can be an affidavit or scorecard,
  // so the supplier must explicitly identify which document was uploaded.
  let documentType = certificate.documentType;
  if (!documentType && certificate.enterpriseType === 'EME') documentType = 'EME_AFFIDAVIT';
  if (!documentType && certificate.enterpriseType === 'GEN') documentType = 'GENERIC_SANAS_CERTIFICATE';
  if (!documentType) throw new RangeError('Select whether the QSE evidence is an affidavit or a scorecard.');
  const allowedTypes = {
    EME: ['EME_AFFIDAVIT'],
    QSE: ['QSE_AFFIDAVIT', 'QSE_SCORECARD'],
    GEN: ['GENERIC_SANAS_CERTIFICATE']
  };
  if (!allowedTypes[certificate.enterpriseType].includes(documentType)) {
    throw new RangeError(`Document type ${documentType} does not match enterprise type ${certificate.enterpriseType}.`);
  }

  if (['QSE_SCORECARD', 'GENERIC_SANAS_CERTIFICATE'].includes(documentType) && !clean(certificate.sanasAgencyNumber)) {
    throw new RangeError('A SANAS agency number is required for QSE scorecards and Generic SANAS certificates.');
  }

  const issueDate = dateString(certificate.issueDate, 'Issue date');
  const expiryDate = dateString(certificate.expiryDate, 'Expiry date');

  validateCertificateDates(issueDate, expiryDate);

  if (certificate.isNonCompliant === true) {
    if (certificate.beeLevel !== null &&
        certificate.beeLevel !== undefined) {
      throw new RangeError(
        'A Non-Compliant certificate must not also have a B-BBEE level.'
      );
    }
  } else {
    calculateRecognitionFactor(Number(certificate.beeLevel));
  }

  if (
    certificate.blackOwnership === null ||
    certificate.blackOwnership === undefined ||
    certificate.blackWomenOwnership === null ||
    certificate.blackWomenOwnership === undefined
  ) {
    throw new RangeError(
      'Black ownership and black women ownership percentages are required.'
    );
  }

  const ownershipFlags = deriveOwnershipFlags(
    Number(certificate.blackOwnership),
    Number(certificate.blackWomenOwnership)
  );

  const supplierRegistration = clean(supplier.registrationNumber);
  const certificateRegistration = clean(
    certificate.extractedRegistrationNumber
  );

  if (
    supplierRegistration &&
    certificateRegistration &&
    supplierRegistration.toUpperCase() !== certificateRegistration.toUpperCase()
  ) {
    throw new RangeError(
      'The certificate registration number does not match the supplier record.'
    );
  }

  const recognitionFactor = certificate.isNonCompliant === true
    ? 0
    : calculateRecognitionFactor(Number(certificate.beeLevel));

  return {
    documentType,
    beeLevel: certificate.isNonCompliant === true
      ? null
      : Number(certificate.beeLevel),
    isNonCompliant: certificate.isNonCompliant === true,
    recognitionFactor,
    complianceState: certificate.isNonCompliant === true
      ? 'NonCompliant'
      : 'Compliant',
    ...ownershipFlags
  };
}

function pickFields(record, fields) {
  return Object.fromEntries(
    fields.map(field => [field, record[field] ?? null])
  );
}

function diffFields(before, after, fields) {
  const changes = {};

  for (const field of fields) {
    const oldValue = before[field] ?? null;
    const newValue = after[field] ?? null;

    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      changes[field] = {
        before: oldValue,
        after: newValue
      };
    }
  }

  return changes;
}

async function writeAudit(
  tx,
  certificateID,
  action,
  performedBy,
  previousStatus,
  newStatus,
  remarks,
  beforeCertificate,
  afterCertificate,
  beforeSupplier = null,
  afterSupplier = null
) {
  const auditID = cds.utils.uuid();

  const fieldDeltas = {
    certificate: diffFields(
      beforeCertificate,
      afterCertificate,
      CERTIFICATE_AUDIT_FIELDS
    )
  };

  if (beforeSupplier && afterSupplier) {
    fieldDeltas.supplier = diffFields(
      beforeSupplier,
      afterSupplier,
      SUPPLIER_AUDIT_FIELDS
    );
  }

  await tx.run(
    INSERT.into('cc.bbbee.AuditTrail').entries({
      ID: auditID,
      certificate_ID: certificateID,
      action,
      performedBy,
      previousStatus,
      newStatus,
      remarks: clean(remarks) || null,
      fieldDeltas: JSON.stringify(fieldDeltas)
    })
  );

  return auditID;
}

function workflowResult(certificate, auditID, message, recognitionFactor = null) {
  return {
    certificateID: certificate.ID,
    supplierID: certificate.supplier_ID,
    status: certificate.status,
    recognitionFactor,
    auditID,
    message
  };
}

export async function submitForReview(req) {
  const certificateID = certificateIDFromRequest(req);
  if (!certificateID) {
    return req.reject(400, 'certificateID is required.');
  }

  const performedBy = actorId(req, false);
  const tx = cds.tx(req);

  const certificate = await loadCertificate(tx, req, certificateID);

  if (!['Draft', 'Rejected'].includes(certificate.status)) {
    return req.reject(
      409,
      'Only Draft or Rejected certificates can be submitted for review.'
    );
  }

  const supplier = await loadSupplier(tx, req, certificate.supplier_ID);
  await requireCleanEvidence(tx, req, certificateID);

  let assessment;
  try {
    assessment = validateForReview(certificate, supplier);
  } catch (error) {
    return req.reject(400, error.message);
  }

  const beforeCertificate = { ...certificate };
  const afterCertificate = {
    ...certificate,
    status: 'PendingReview',
    documentType: assessment.documentType,
    rejectionReason: null
  };

  await tx.run(
    UPDATE('cc.bbbee.Certificates')
      .set({
        status: 'PendingReview',
        documentType: assessment.documentType,
        rejectionReason: null
      })
      .where({ ID: certificateID })
  );

  const auditID = await writeAudit(
    tx,
    certificateID,
    'SubmitForReview',
    performedBy,
    certificate.status,
    'PendingReview',
    null,
    beforeCertificate,
    afterCertificate
  );

  return workflowResult(
    afterCertificate,
    auditID,
    'Certificate submitted for compliance review.',
    assessment.recognitionFactor
  );
}

async function approveCertificate(req) {
  const certificateID = certificateIDFromRequest(req);
  const { remarks } = req.data ?? {};
  if (!certificateID) {
    return req.reject(400, 'certificateID is required.');
  }

  const performedBy = actorId(req, true);
  const tx = cds.tx(req);
  const certificate = await loadCertificate(tx, req, certificateID);

  if (certificate.status !== 'PendingReview') {
    return req.reject(
      409,
      'Only certificates in PendingReview can be approved.'
    );
  }

  const supplier = await loadSupplier(tx, req, certificate.supplier_ID);
  await requireCleanEvidence(tx, req, certificateID);

  let assessment;
  try {
    assessment = validateForReview(certificate, supplier);
  } catch (error) {
    return req.reject(400, error.message);
  }

  const beforeCertificate = { ...certificate };
  const beforeSupplier = { ...supplier };

  const afterCertificate = {
    ...certificate,
    status: 'Approved',
    documentType: assessment.documentType,
    beeLevel: assessment.beeLevel,
    isNonCompliant: assessment.isNonCompliant,
    rejectionReason: null
  };

  const afterSupplier = {
    ...supplier,
    currentBEELevel: assessment.beeLevel,
    currentComplianceState: assessment.complianceState,
    recognitionFactor: assessment.recognitionFactor,
    isBlackOwned: assessment.isBlackOwned,
    isBlackWomenOwned: assessment.isBlackWomenOwned,
    activeCertificate_ID: certificate.ID
  };

  // These writes and the audit insert run in the same CAP request transaction.
  await tx.run(
    UPDATE('cc.bbbee.Certificates')
      .set({
        status: 'Approved',
        documentType: assessment.documentType,
        beeLevel: assessment.beeLevel,
        isNonCompliant: assessment.isNonCompliant,
        rejectionReason: null
      })
      .where({ ID: certificateID })
  );

  await tx.run(
    UPDATE('cc.bbbee.Suppliers')
      .set({
        currentBEELevel: assessment.beeLevel,
        currentComplianceState: assessment.complianceState,
        recognitionFactor: assessment.recognitionFactor,
        isBlackOwned: assessment.isBlackOwned,
        isBlackWomenOwned: assessment.isBlackWomenOwned,
        activeCertificate_ID: certificate.ID,
        s4SyncStatus: supplier.businessPartnerId ? 'Pending' : 'NotLinked',
        s4SyncMessage: supplier.businessPartnerId
          ? 'Compliance change queued for idempotent S/4HANA write-back.'
          : 'No S/4HANA Business Partner is linked; resolve onboarding before write-back.'
      })
      .where({ ID: supplier.ID })
  );

  const afterSupplierWithSync = {
    ...afterSupplier,
    s4SyncStatus: supplier.businessPartnerId ? 'Pending' : 'NotLinked'
  };
  await enqueueIntegrationEvent(
    tx,
    afterSupplierWithSync,
    afterCertificate,
    'APPROVE_CERTIFICATE'
  );

  const auditID = await writeAudit(
    tx,
    certificateID,
    'Approve',
    performedBy,
    certificate.status,
    'Approved',
    remarks,
    beforeCertificate,
    afterCertificate,
    beforeSupplier,
    afterSupplier
  );

  return workflowResult(
    afterCertificate,
    auditID,
    'Certificate approved, supplier compliance updated, and an idempotent S/4HANA write-back queued.',
    assessment.recognitionFactor
  );
}

async function rejectCertificate(req) {
  const certificateID = certificateIDFromRequest(req);
  const { remarks } = req.data ?? {};
  if (!certificateID) {
    return req.reject(400, 'certificateID is required.');
  }

  const notes = clean(remarks);
  if (!notes) {
    return req.reject(400, 'Rejection remarks are mandatory.');
  }

  const performedBy = actorId(req, true);
  const tx = cds.tx(req);
  const certificate = await loadCertificate(tx, req, certificateID);

  if (certificate.status !== 'PendingReview') {
    return req.reject(
      409,
      'Only certificates in PendingReview can be rejected.'
    );
  }

  const beforeCertificate = { ...certificate };
  const afterCertificate = {
    ...certificate,
    status: 'Rejected',
    rejectionReason: notes
  };

  await tx.run(
    UPDATE('cc.bbbee.Certificates')
      .set({
        status: 'Rejected',
        rejectionReason: notes
      })
      .where({ ID: certificateID })
  );

  const auditID = await writeAudit(
    tx,
    certificateID,
    'Reject',
    performedBy,
    certificate.status,
    'Rejected',
    notes,
    beforeCertificate,
    afterCertificate
  );

  return workflowResult(
    afterCertificate,
    auditID,
    'Certificate rejected.'
  );
}

async function requestResubmission(req) {
  const certificateID = certificateIDFromRequest(req);
  const { remarks } = req.data ?? {};
  if (!certificateID) {
    return req.reject(400, 'certificateID is required.');
  }

  const notes = clean(remarks);
  if (!notes) {
    return req.reject(400, 'Resubmission remarks are mandatory.');
  }

  const performedBy = actorId(req, true);
  const tx = cds.tx(req);
  const certificate = await loadCertificate(tx, req, certificateID);

  if (certificate.status !== 'PendingReview') {
    return req.reject(
      409,
      'Only certificates in PendingReview can be returned for resubmission.'
    );
  }

  const beforeCertificate = { ...certificate };
  const afterCertificate = {
    ...certificate,
    status: 'Draft',
    rejectionReason: notes
  };

  await tx.run(
    UPDATE('cc.bbbee.Certificates')
      .set({
        status: 'Draft',
        rejectionReason: notes
      })
      .where({ ID: certificateID })
  );

  const auditID = await writeAudit(
    tx,
    certificateID,
    'RequestResubmission',
    performedBy,
    certificate.status,
    'Draft',
    notes,
    beforeCertificate,
    afterCertificate
  );

  return workflowResult(
    afterCertificate,
    auditID,
    'Certificate returned to Draft for supplier corrections.'
  );
}

export function registerCertificateWorkflow(service) {
  service.on('submitForReview', 'Certificates', submitForReview);
  service.on('approveCertificate', 'Certificates', approveCertificate);
  service.on('rejectCertificate', 'Certificates', rejectCertificate);
  service.on('requestResubmission', 'Certificates', requestResubmission);
}
