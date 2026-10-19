import cds from '@sap/cds';
import { validateCertificate } from './lib/bee-rules.js';
import { analyzeDocument } from './lib/azure-document-intelligence.js';
import { registerCertificateWorkflow, submitForReview } from './lib/certificate-workflow.js';
import { assertCertificateOwnership, hasRole, isProduction, restrictSupplierRead, registerCertificateAttachmentGuard } from './lib/authorization.js';
import { handleRunExpiryJob, handleProcessIntegrationOutbox, handleDispatchNotifications, handleRequeueBlockedNotifications, registerAutomationScheduler } from './lib/automation.js';
import { approveOnboardingRequest, rejectOnboardingRequest } from './supplier-service.js';

const { SELECT, UPDATE } = cds.ql;
const LOG = cds.log('bbbee-ocr');
const MAX_FILE_BYTES = 10 * 1024 * 1024;

function emptyResult(certificateID, ocrStatus, message, fields = {}) {
  return {
    certificateID,
    ocrStatus,
    message,
    extractedEntityName: fields.extractedEntityName ?? null,
    extractedRegistrationNumber:
      fields.extractedRegistrationNumber ?? null,
    certificateNumber: fields.certificateNumber ?? null,
    sanasAgencyNumber: fields.sanasAgencyNumber ?? null,
    enterpriseType: fields.enterpriseType ?? null,
    beeLevel: fields.beeLevel ?? null,
    isNonCompliant: fields.isNonCompliant ?? null,
    recognitionFactor: fields.recognitionFactor ?? null,
    blackOwnership: fields.blackOwnership ?? null,
    blackWomenOwnership: fields.blackWomenOwnership ?? null,
    empoweringSupplier: fields.empoweringSupplier ?? null,
    issueDate: fields.issueDate ?? null,
    expiryDate: fields.expiryDate ?? null
  };
}

async function bytesFrom(value) {
  if (Buffer.isBuffer(value)) return value;

  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }

  if (ArrayBuffer.isView(value)) {
    return Buffer.from(
      value.buffer,
      value.byteOffset,
      value.byteLength
    );
  }

  if (Array.isArray(value)) {
    return Buffer.from(value);
  }

  if (value && typeof value.arrayBuffer === 'function') {
    return Buffer.from(await value.arrayBuffer());
  }

  // support Node.js streams and async-iterable binary streams.
  if (value && typeof value[Symbol.asyncIterator] === 'function') {
    const chunks = [];

    for await (const chunk of value) {
      if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
      } else if (ArrayBuffer.isView(chunk)) {
        chunks.push(
          Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        );
      } else if (chunk instanceof ArrayBuffer) {
        chunks.push(Buffer.from(chunk));
      } else if (typeof chunk === 'string') {
        chunks.push(Buffer.from(chunk));
      } else {
        throw new Error('Attachment stream returned an unsupported chunk.');
      }
    }

    return Buffer.concat(chunks);
  }

  if (typeof value === 'string') {
    return Buffer.from(value, 'base64');
  }

  return Buffer.alloc(0);
}

function hasPdfSignature(bytes) {
  return bytes.length >= 5 && bytes.subarray(0, 5).toString('ascii') === '%PDF-';
}

function hasPngSignature(bytes) {
  return bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
}

function hasJpegSignature(bytes) {
  return bytes.length >= 3 &&
    bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function signatureMatches(bytes, mimeType) {
  switch (mimeType) {
    case 'application/pdf':
      return hasPdfSignature(bytes);
    case 'image/png':
      return hasPngSignature(bytes);
    case 'image/jpeg':
      return hasJpegSignature(bytes);
    default:
      return false;
  }
}

function isBlank(value) {
  return value === null || value === undefined || value === '';
}

function fieldsForUpdate(certificate, fields) {
  const update = {};

  if (fields.extractedEntityName) {
    update.extractedEntityName = fields.extractedEntityName;
  }

  if (fields.extractedRegistrationNumber) {
    update.extractedRegistrationNumber =
      fields.extractedRegistrationNumber;
  }

  const editableFields = [
    'certificateNumber',
    'sanasAgencyNumber',
    'enterpriseType',
    'beeLevel',
    'blackOwnership',
    'blackWomenOwnership',
    'empoweringSupplier',
    'issueDate',
    'expiryDate'
  ];

  for (const key of editableFields) {
    if (fields[key] !== null && fields[key] !== undefined &&
        isBlank(certificate[key])) {
      update[key] = fields[key];
    }
  }

  if (fields.isNonCompliant !== null &&
      fields.isNonCompliant !== undefined &&
      (certificate.ocrStatus === 'NotStarted' ||
       certificate.ocrStatus === 'Failed')) {
    update.isNonCompliant = fields.isNonCompliant;
  }

  return update;
}

async function analyzeCertificateAction(req) {
  const { certificateID, attachmentID } = req.data ?? {};
  if (isProduction() && !hasRole(req.user, 'BEE_Supplier_User', 'BEE_Compliance_Officer', 'BEE_System_Admin', 'ComplianceOfficer')) {
    return req.reject(403, 'A B-BBEE Supplier, Compliance Officer or System Administrator role is required for OCR.');
  }

  if (!certificateID || !attachmentID) {
    return req.reject(
      400,
      'Both certificateID and attachmentID are required.'
    );
  }

  const tx = cds.tx(req);

  const certificate = await tx.run(
    SELECT.one.from('cc.bbbee.Certificates')
      .where({ ID: certificateID })
  );

  if (!certificate) {
    return req.reject(404, 'Certificate not found.');
  }

  await assertCertificateOwnership(req, certificateID, { tx });

  if (certificate.status === 'Approved') {
    return req.reject(
      409,
      'An approved certificate cannot be reprocessed through OCR.'
    );
  }

  if (certificate.ocrStatus === 'Processing') {
    return req.reject(409, 'OCR is already processing this certificate.');
  }

  if (certificate.ocrStatus === 'Succeeded') {
    return req.reject(
      409,
      'OCR has already completed. Review the extracted values before retrying.'
    );
  }

  const attachment = await tx.run(
    SELECT.one.from('cc.bbbee.Certificates.attachments')
      .columns(
        'ID',
        'up__ID',
        'filename',
        'mimeType',
        'status',
        'content'
      )
      .where({
        ID: attachmentID,
        up__ID: certificateID
      })
  );

  if (!attachment) {
    return req.reject(
      404,
      'Attachment not found on the specified certificate.'
    );
  }

  if (attachment.status !== 'Clean') {
    return req.reject(
      409,
      'The attachment must pass malware scanning before OCR.'
    );
  }

  const allowedMimeTypes = [
    'application/pdf',
    'image/png',
    'image/jpeg'
  ];

  if (!allowedMimeTypes.includes(attachment.mimeType)) {
    return req.reject(400, 'The attachment MIME type is not supported for OCR.');
  }

  const bytes = await bytesFrom(attachment.content);

  if (!bytes.length) {
    return req.reject(
      409,
      'Attachment content could not be read from the configured storage.'
    );
  }

  if (bytes.length > MAX_FILE_BYTES) {
    return req.reject(413, 'Attachment exceeds the 10 MB OCR limit.');
  }

  if (!signatureMatches(bytes, attachment.mimeType)) {
    return req.reject(
      400,
      'The file signature does not match its declared MIME type.'
    );
  }

  await tx.run(
    UPDATE('cc.bbbee.Certificates')
      .set({
        ocrStatus: 'Processing',
        ocrCompletedAt: null,
        ocrError: null
      })
      .where({ ID: certificateID })
  );

  try {
    const result = await analyzeDocument(bytes, attachment.mimeType);
    const fields = result.fields ?? {};
    const extractedCount = Object.values(fields).filter(
      value => value !== null && value !== undefined
    ).length;

    const updateFields = fieldsForUpdate(certificate, fields);

    await tx.run(
      UPDATE('cc.bbbee.Certificates')
        .set({
          ...updateFields,
          ocrStatus: 'Succeeded',
          ocrCompletedAt: new Date().toISOString(),
          ocrError: null
        })
        .where({ ID: certificateID })
    );

    const message = extractedCount
      ? 'OCR completed. Review all extracted values before making a compliance decision.'
      : 'OCR completed, but no requested fields were extracted. Check document quality and review it manually.';

    return emptyResult(
      certificateID,
      'Succeeded',
      message,
      fields
    );
  } catch (error) {
    LOG.error(
      `OCR failed for certificate ${certificateID}:`,
      error?.message ?? 'Unknown error'
    );

    const message =
      'OCR failed. Check the AZURE_DOCUMENT_INTELLIGENCE destination and Azure resource configuration, then retry.';

    await tx.run(
      UPDATE('cc.bbbee.Certificates')
        .set({
          ocrStatus: 'Failed',
          ocrCompletedAt: new Date().toISOString(),
          ocrError: message
        })
        .where({ ID: certificateID })
    );

    return emptyResult(certificateID, 'Failed', message);
  }
}

async function validateAndMergeCertificate(req) {
  try {
    const input = req.data ?? {};
    let existing = {};
    if (req.event === 'UPDATE') {
      const id = input.ID ?? req.params?.[0]?.ID ?? req.params?.[0]?.id;
      if (id) existing = await cds.tx(req).run(
        SELECT.one.from('cc.bbbee.Certificates').where({ ID: id })
      ) ?? {};
      if (existing.status === 'Approved') return req.reject(409, 'Approved certificates are immutable; submit a replacement certificate instead.');
      if (existing.status === 'PendingReview') return req.reject(409, 'Certificates in review cannot be edited. Request resubmission first.');
      if (input.supplier_ID && existing.supplier_ID && input.supplier_ID !== existing.supplier_ID) return req.reject(400, 'A certificate cannot be reassigned to another supplier.');
    }
    validateCertificate({ ...existing, ...input });
  } catch (error) {
    if (error?.status || error?.code) throw error;
    req.reject(400, error.message);
  }
}

function isComplianceUser(req) {
  return hasRole(req.user, 'BEE_Compliance_Officer', 'BEE_System_Admin', 'ComplianceOfficer');
}

export default class ComplianceService extends cds.ApplicationService {
  async init() {
    this.before('READ', 'Suppliers', req => restrictSupplierRead(req, 'Suppliers'));
    this.before('READ', 'Certificates', req => restrictSupplierRead(req, 'Certificates'));
    this.before('READ', 'SupplierOnboardingRequests', req => restrictSupplierRead(req, 'SupplierOnboardingRequests'));
    registerCertificateAttachmentGuard(this);

    this.before('READ', 'AuditTrail', req => {
      if (isProduction() && !isComplianceUser(req)) return req.reject(403, 'Only compliance officers and system administrators can access the audit trail.');
    });
    for (const entity of ['IntegrationOutbox', 'NotificationEvents', 'ExpiryJobRuns', 'MockBusinessPartners']) {
      this.before('READ', entity, req => {
        if (isProduction() && !hasRole(req.user, 'BEE_System_Admin')) return req.reject(403, 'Only a B-BBEE System Administrator can access automation operations.');
      });
    }

    this.before('CREATE', 'Certificates', async req => {
      if (isProduction() && !isComplianceUser(req) && !hasRole(req.user, 'BEE_Supplier_User')) return req.reject(403, 'A B-BBEE Supplier role is required to create certificates.');
      if (req.data?.status && req.data.status !== 'Draft') return req.reject(400, 'Certificates must be created as Draft and submitted through the workflow.');
      if (!req.data?.supplier_ID) return req.reject(400, 'supplier_ID is required.');
      const tx = cds.tx(req);
      const supplier = await tx.run(SELECT.one.from('cc.bbbee.Suppliers').where({ ID: req.data.supplier_ID }));
      if (!supplier) return req.reject(404, 'Supplier not found.');
      if (isProduction() && !isComplianceUser(req)) {
        const { assertSupplierOwnership } = await import('./lib/authorization.js');
        await assertSupplierOwnership(req, supplier.ID, { tx });
      }
      await validateAndMergeCertificate(req);
    });

    this.before('UPDATE', 'Certificates', async req => {
      if (isProduction() && !isComplianceUser(req) && !hasRole(req.user, 'BEE_Supplier_User')) return req.reject(403, 'A B-BBEE Supplier role is required to update certificate drafts.');
      if (Object.hasOwn(req.data ?? {}, 'status')) return req.reject(400, 'Direct status changes are forbidden. Use the compliance workflow actions.');
      const id = req.data?.ID ?? req.params?.[0]?.ID ?? req.params?.[0]?.id;
      if (!id) return req.reject(400, 'Certificate ID is required for updates.');
      if (isProduction() && !isComplianceUser(req)) {
        if (!hasRole(req.user, 'BEE_Supplier_User')) return req.reject(403, 'A B-BBEE Supplier role is required to submit certificates.');
        const { assertCertificateOwnership } = await import('./lib/authorization.js');
        await assertCertificateOwnership(req, id);
      }
      await validateAndMergeCertificate(req);
    });
    this.before('UPDATE', 'Suppliers', async req => {
      const allowed = new Set(['ID', 'contactEmail']);
      const unexpected = Object.keys(req.data ?? {}).filter(key => !allowed.has(key));
      if (unexpected.length) return req.reject(403, 'Supplier identity, S/4HANA links and compliance values are maintained by backend workflows.');
      const id = req.data?.ID ?? req.params?.[0]?.ID ?? req.params?.[0]?.id;
      if (!id) return req.reject(400, 'Supplier ID is required.');
      if (isProduction() && !isComplianceUser(req)) {
        const { assertSupplierOwnership } = await import('./lib/authorization.js');
        await assertSupplierOwnership(req, id);
      }
      if (req.data?.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(req.data.contactEmail)) return req.reject(400, 'Enter a valid contact email address.');
    });
    this.before('DELETE', 'Certificates', req => req.reject(405, 'Certificates are audit records and cannot be deleted.'));
    this.before('submitForReview', 'Certificates', async req => {
      if (isProduction() && !isComplianceUser(req)) {
        if (!hasRole(req.user, 'BEE_Supplier_User')) return req.reject(403, 'A B-BBEE Supplier role is required to submit certificates.');
        const { assertCertificateOwnership } = await import('./lib/authorization.js');
        await assertCertificateOwnership(req, req.params?.[0]?.ID ?? req.params?.[0]?.id ?? req.data?.certificateID);
      }
    });

    this.on('analyzeCertificate', analyzeCertificateAction);
    this.on('approveOnboardingRequest', 'SupplierOnboardingRequests', approveOnboardingRequest);
    this.on('rejectOnboardingRequest', 'SupplierOnboardingRequests', rejectOnboardingRequest);
    this.on('runDailyExpiryJob', handleRunExpiryJob);
    this.on('processIntegrationOutbox', handleProcessIntegrationOutbox);
    this.on('dispatchNotifications', handleDispatchNotifications);
    this.on('requeueBlockedNotifications', handleRequeueBlockedNotifications);
    registerCertificateWorkflow(this);
    registerAutomationScheduler();
    return super.init();
  }
}
