import cds from '@sap/cds';

const { SELECT } = cds.ql;

export function isProduction() {
  const profiles = Array.isArray(cds.env.profiles) ? cds.env.profiles : [];
  const auth = cds.env.requires?.auth;
  // Cloud Foundry sets VCAP_* independently of NODE_ENV. Security must never
  // silently fall back to local/mock authorization simply because NODE_ENV is unset.
  return process.env.NODE_ENV === 'production' ||
    profiles.includes('production') ||
    auth === 'xsuaa' || auth?.kind === 'xsuaa' ||
    Boolean(process.env.VCAP_APPLICATION || process.env.VCAP_SERVICES);
}

export function hasRole(user, ...roles) {
  return roles.some(role => typeof user?.is === 'function' && user.is(role));
}

export function requireAuthenticated(req) {
  if (isProduction() && (!req.user?.id || req.user.id === 'anonymous')) {
    return req.reject(401, 'Sign in with your SAP identity before continuing.');
  }
  return req.user?.id && req.user.id !== 'anonymous'
    ? String(req.user.id)
    : 'local-dev';
}

export function requireComplianceOfficer(req) {
  const identity = requireAuthenticated(req);
  if (identity && isProduction() && !hasRole(req.user, 'BEE_Compliance_Officer', 'BEE_System_Admin', 'ComplianceOfficer')) {
    return req.reject(403, 'A B-BBEE Compliance Officer or System Administrator role is required.');
  }
  return identity;
}

export function requireSystemAdmin(req) {
  const identity = requireAuthenticated(req);
  if (identity && isProduction() && !hasRole(req.user, 'BEE_System_Admin')) {
    return req.reject(403, 'The B-BBEE System Administrator role is required.');
  }
  return identity;
}

function appendWhere(req, expression) {
  const select = req.query?.SELECT;
  if (!select) return;
  if (select.where?.length) {
    select.where = [{ xpr: select.where }, 'and', { xpr: expression }];
  } else {
    select.where = expression;
  }
}

/** Adds a CQN predicate rather than relying on the UI to hide other suppliers. */
export async function restrictSupplierRead(req, entityKind) {
  if (!isProduction()) return;
  const privileged = hasRole(req.user, 'BEE_Compliance_Officer', 'BEE_System_Admin', 'ComplianceOfficer');
  if (!privileged && !hasRole(req.user, 'BEE_Supplier_User')) {
    return req.reject(403, 'A B-BBEE Supplier, Compliance Officer or System Administrator role is required.');
  }
  if (privileged) return;
  const identity = requireAuthenticated(req);
  if (!identity) return;
  if (identity === 'local-dev') return; // mock auth only outside production

  const tx = cds.tx(req);
  const suppliers = await tx.run(
    SELECT.from('cc.bbbee.Suppliers').columns('ID')
      .where({ identitySubject: identity })
  );
  const ids = suppliers.map(row => row.ID).filter(Boolean);
  if (entityKind === 'Suppliers') {
    if (!ids.length) {
      appendWhere(req, [{ ref: ['ID'] }, '=', { val: '__no_supplier_for_this_identity__' }]);
    } else {
      appendWhere(req, [{ ref: ['ID'] }, 'in', { list: ids.map(ID => ({ val: ID })) }]);
    }
    return;
  }
  if (entityKind === 'Certificates') {
    if (!ids.length) {
      appendWhere(req, [{ ref: ['supplier_ID'] }, '=', { val: '__no_supplier_for_this_identity__' }]);
    } else {
      appendWhere(req, [{ ref: ['supplier_ID'] }, 'in', { list: ids.map(ID => ({ val: ID })) }]);
    }
  }
  if (entityKind === 'SupplierOnboardingRequests') {
    const requests = await tx.run(
      SELECT.from('cc.bbbee.SupplierOnboardingRequests').columns('ID')
        .where({ requestedByIdentity: identity })
    );
    const requestIDs = requests.map(row => row.ID).filter(Boolean);
    appendWhere(req, requestIDs.length
      ? [{ ref: ['ID'] }, 'in', { list: requestIDs.map(ID => ({ val: ID })) }]
      : [{ ref: ['ID'] }, '=', { val: '__no_onboarding_request_for_this_identity__' }]);
  }
}

export async function assertSupplierOwnership(req, supplierID, { tx = cds.tx(req), allowUnclaimed = false } = {}) {
  const identity = requireAuthenticated(req);
  if (isProduction() && !hasRole(req.user, 'BEE_Supplier_User', 'BEE_Compliance_Officer', 'BEE_System_Admin', 'ComplianceOfficer')) {
    return req.reject(403, 'A B-BBEE Supplier role is required to access supplier records.');
  }
  if (!identity) return false;
  if (!isProduction() || hasRole(req.user, 'BEE_Compliance_Officer', 'BEE_System_Admin', 'ComplianceOfficer')) return true;
  if (!supplierID) return req.reject(400, 'supplier_ID is required.');

  const supplier = await tx.run(
    SELECT.one.from('cc.bbbee.Suppliers').columns('ID', 'identitySubject')
      .where({ ID: supplierID })
  );
  if (!supplier) return req.reject(404, 'Supplier not found.');
  if (supplier.identitySubject === identity) return true;
  if (allowUnclaimed && !supplier.identitySubject) return true;
  return req.reject(403, 'This supplier record is not linked to your signed-in identity.');
}

export async function assertCertificateOwnership(req, certificateID, { tx = cds.tx(req) } = {}) {
  const identity = requireAuthenticated(req);
  if (isProduction() && !hasRole(req.user, 'BEE_Supplier_User', 'BEE_Compliance_Officer', 'BEE_System_Admin', 'ComplianceOfficer')) {
    return req.reject(403, 'A B-BBEE Supplier role is required to access certificate records.');
  }
  if (!identity) return false;
  if (!isProduction() || hasRole(req.user, 'BEE_Compliance_Officer', 'BEE_System_Admin', 'ComplianceOfficer')) return true;
  const { SELECT } = cds.ql;
  const cert = await tx.run(
    SELECT.one.from('cc.bbbee.Certificates').columns('ID', 'supplier_ID')
      .where({ ID: certificateID })
  );
  if (!cert) return req.reject(404, 'Certificate not found.');
  return assertSupplierOwnership(req, cert.supplier_ID, { tx });
}

export function registerCertificateAttachmentGuard(service) {
  service.before(['READ', 'CREATE', 'UPDATE', 'DELETE'], 'Certificates.attachments', async req => {
    if (isProduction() && !hasRole(req.user, 'BEE_Supplier_User', 'BEE_Compliance_Officer', 'BEE_System_Admin', 'ComplianceOfficer')) {
      return req.reject(403, 'A B-BBEE Supplier, Compliance Officer or System Administrator role is required for certificate attachments.');
    }
    const requestPath =
      req.http?.req?.originalUrl ??
      req.http?.req?.url ??
      req.path ??
      '';

    const pathMatch = String(requestPath).match(
      /\/Certificates\((?:ID=)?([^)]*)\)\/attachments(?:\/|$|\()/i
    );

    const pathParentID = pathMatch?.[1]?.replace(/^['"]|['"]$/g, '');

    const parentKey =
      req.data?.up__ID ??
      req.params?.find?.(param => param?.up__ID)?.up__ID ??
      pathParentID ??
      req.params?.[0]?.ID ??
      req.params?.[0]?.id;
    if (!parentKey) return req.reject(400, 'The certificate parent ID is required for attachment operations.');
    const tx = cds.tx(req);
    const certificate = await tx.run(
      SELECT.one.from('cc.bbbee.Certificates').columns('ID', 'supplier_ID', 'status')
        .where({ ID: parentKey })
    );
    if (!certificate) return req.reject(404, 'Certificate not found.');
    if (req.event !== 'READ' && !['Draft', 'Rejected'].includes(certificate.status)) {
      return req.reject(409, 'Documents can only be added or changed on Draft or Rejected certificates.');
    }
    if (isProduction() && !hasRole(req.user, 'BEE_Compliance_Officer', 'BEE_System_Admin', 'ComplianceOfficer')) {
      await assertSupplierOwnership(req, certificate.supplier_ID, { tx });
    }
  });
}
