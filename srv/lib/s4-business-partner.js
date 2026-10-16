import { getDestination } from '@sap-cloud-sdk/connectivity';
import { executeHttpRequest } from '@sap-cloud-sdk/http-client';

const DESTINATION_NAME =
  process.env.S4_BP_DESTINATION || 'S4HANA_BUSINESS_PARTNER';

const SERVICE_PATH =
  process.env.S4_BP_SERVICE_PATH ||
  '/sap/opu/odata/SAP/API_BUSINESS_PARTNER';

const REQUIRED_MAPPINGS = [
  'S4_FIELD_BBEE_LEVEL',
  'S4_FIELD_RECOGNITION_FACTOR',
  'S4_FIELD_CERTIFICATE_EXPIRY',
  'S4_FIELD_ENTERPRISE_TYPE',
  'S4_FIELD_COMPLIANCE_STATUS'
];

function mappedField(payload, envName, value) {
  const property = process.env[envName]?.trim();

  if (property) {
    // Prevent malformed property names from becoming arbitrary payload keys.
    if (!/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(property)) {
      throw new Error(`Invalid S/4 field mapping configured in ${envName}.`);
    }

    payload[property] = value;
  }
}

export function buildBusinessPartnerPatch(supplier, certificate) {
  const payload = {};

  mappedField(payload, 'S4_FIELD_BBEE_LEVEL',
    supplier.currentComplianceState === 'NonCompliant'
      ? null
      : supplier.currentBEELevel);

  mappedField(payload, 'S4_FIELD_RECOGNITION_FACTOR',
    supplier.recognitionFactor == null
      ? null
      : Number(supplier.recognitionFactor));

  mappedField(payload, 'S4_FIELD_CERTIFICATE_EXPIRY',
    certificate.expiryDate ?? null);

  mappedField(payload, 'S4_FIELD_ENTERPRISE_TYPE',
    certificate.enterpriseType ?? null);

  mappedField(payload, 'S4_FIELD_COMPLIANCE_STATUS',
    supplier.currentComplianceState ?? 'Unknown');

  mappedField(payload, 'S4_FIELD_BLACK_OWNERSHIP',
    certificate.blackOwnership == null
      ? null
      : Number(certificate.blackOwnership));

  mappedField(payload, 'S4_FIELD_BLACK_WOMEN_OWNERSHIP',
    certificate.blackWomenOwnership == null
      ? null
      : Number(certificate.blackWomenOwnership));

  // Do not write the standard BusinessPartnerIsBlocked flag. That flag can
  // block unrelated purchasing/payment processes, whereas B-BBEE status must
  // be maintained in the explicitly configured compliance extension field.
  const shouldBlock = false;

  return {
    payload,
    shouldBlock,
    missingMappings: REQUIRED_MAPPINGS.filter(
      name => !process.env[name]?.trim()
    )
  };
}

function businessPartnerPath(businessPartnerId) {
  const id = String(businessPartnerId ?? '').trim();

  // BP numbers are identifiers, not arbitrary OData expressions.
  if (!/^[A-Za-z0-9]{1,10}$/.test(id)) {
    throw new Error(
      'Business Partner ID must contain 1–10 alphanumeric characters.'
    );
  }

  return `${SERVICE_PATH}/A_BusinessPartner(BusinessPartner='${id}')`;
}

function getHeader(headers, name) {
  const key = Object.keys(headers ?? {}).find(
    candidate => candidate.toLowerCase() === name.toLowerCase()
  );

  return key ? headers[key] : undefined;
}

export async function syncSupplierCompliance(supplier, certificate, options = {}) {
  if (!supplier.businessPartnerId) {
    return {
      status: 'NotLinked',
      message: 'Supplier has no linked S/4HANA Business Partner ID.'
    };
  }

  const { payload, missingMappings } =
    buildBusinessPartnerPatch(supplier, certificate);

  const mode = (process.env.S4_SYNC_MODE || 'dry-run').toLowerCase();

  if (mode === 'dry-run') {
    return {
      status: 'DryRun',
      message: 'Dry run only; no S/4HANA request was sent.',
      payload,
      missingMappings
    };
  }

  if (mode !== 'live') {
    throw new Error('S4_SYNC_MODE must be dry-run or live.');
  }

  if (missingMappings.length) {
    throw new Error(
      `S/4HANA custom field mappings are missing: ${missingMappings.join(', ')}`
    );
  }

  if (Object.keys(payload).length === 0) {
    throw new Error('There are no mapped fields to send to S/4HANA.');
  }

  const destination = await getDestination({
    destinationName: DESTINATION_NAME
  });

  if (!destination?.url) {
    throw new Error(`Destination ${DESTINATION_NAME} is unavailable.`);
  }

  if (new URL(destination.url).protocol !== 'https:') {
    throw new Error('The S/4HANA destination must use HTTPS.');
  }

  const url = businessPartnerPath(supplier.businessPartnerId);

  // SAP Gateway OData V2 systems commonly require a CSRF token for PATCH.
  const tokenResponse = await executeHttpRequest(
    destination,
    {
      method: 'GET',
      url,
      headers: {
        Accept: 'application/json',
        'x-csrf-token': 'Fetch'
      },
      timeout: 15000
    },
    { fetchCsrfToken: false }
  );

  const token = getHeader(tokenResponse.headers, 'x-csrf-token');

  if (!token || token.toLowerCase() === 'required') {
    throw new Error('S/4HANA did not return a usable CSRF token.');
  }

  const setCookies = getHeader(tokenResponse.headers, 'set-cookie');
  const cookieHeader = Array.isArray(setCookies)
    ? setCookies.map(cookie => cookie.split(';')[0]).join('; ')
    : typeof setCookies === 'string'
      ? setCookies.split(',').map(cookie => cookie.split(';')[0]).join('; ')
      : undefined;

  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'x-csrf-token': token,
    'If-Match': '*',
    ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {})
  };

  if (cookieHeader) headers.Cookie = cookieHeader;

  const response = await executeHttpRequest(
    destination,
    {
      method: 'PATCH',
      url,
      headers,
      data: payload,
      timeout: 20000
    },
    { fetchCsrfToken: false }
  );

  return {
    status: 'Succeeded',
    message: `S/4HANA accepted the Business Partner update (HTTP ${response.status}).`
  };
}


function odataQuote(value) {
  return String(value).replace(/'/g, "''");
}

function resultRows(data) {
  if (Array.isArray(data?.value)) return data.value;
  if (Array.isArray(data?.d?.results)) return data.d.results;
  if (data?.d && typeof data.d === 'object') return [data.d];
  return [];
}

async function searchBusinessPartnerEntity(destination, entity, filter, select) {
  const path = `${SERVICE_PATH}/${entity}`;
  const response = await executeHttpRequest(destination, {
    method: 'GET',
    url: `${path}?$select=${encodeURIComponent(select)}&$filter=${encodeURIComponent(filter)}&$top=20`,
    headers: { Accept: 'application/json' },
    timeout: 15000
  }, { fetchCsrfToken: false });
  return resultRows(response.data);
}

/**
 * Finds a Business Partner by the official identifiers exposed by
 * API_BUSINESS_PARTNER. Ambiguous identifiers are not guessed: the caller
 * should create an onboarding item for an administrator to resolve.
 */
export async function findBusinessPartner({ taxNumber, registrationNumber }) {
  const tax = String(taxNumber ?? '').trim();
  const registration = String(registrationNumber ?? '').trim();
  if (!tax && !registration) {
    return { matched: false, source: 'NO_IDENTIFIERS', businessPartnerId: null };
  }

  const destination = await getDestination({ destinationName: DESTINATION_NAME });
  if (!destination?.url) {
    return {
      matched: false,
      source: 'S4_DESTINATION_UNAVAILABLE',
      businessPartnerId: null,
      message: `Destination ${DESTINATION_NAME} is unavailable.`
    };
  }
  if (new URL(destination.url).protocol !== 'https:') {
    throw new Error('The S/4HANA destination must use HTTPS.');
  }

  const matches = [];
  const errors = [];
  if (tax) {
    try {
      const rows = await searchBusinessPartnerEntity(
        destination,
        'A_BusinessPartnerTaxNumber',
        `BPTaxNumber eq '${odataQuote(tax)}'`,
        'BusinessPartner,BPTaxNumber,BPTaxType'
      );
      matches.push({ kind: 'tax', ids: [...new Set(rows.map(row => String(row.BusinessPartner ?? '').trim()).filter(Boolean))] });
    } catch (error) {
      errors.push(`tax-number lookup failed: ${error.message}`);
    }
  }
  if (registration) {
    try {
      const rows = await searchBusinessPartnerEntity(
        destination,
        'A_BusinessPartnerIdentification',
        `BPIdentificationNumber eq '${odataQuote(registration)}'`,
        'BusinessPartner,BPIdentificationNumber,BPIdentificationType'
      );
      matches.push({ kind: 'registration', ids: [...new Set(rows.map(row => String(row.BusinessPartner ?? '').trim()).filter(Boolean))] });
    } catch (error) {
      errors.push(`registration-number lookup failed: ${error.message}`);
    }
  }

  if (errors.length && matches.every(item => item.ids.length === 0)) {
    return {
      matched: false,
      source: 'S4_LOOKUP_FAILED',
      businessPartnerId: null,
      message: errors.join('; ')
    };
  }
  // When the user supplies both identifiers, require both lookups to succeed
  // and resolve to the same BP. Never silently trust only one identifier.
  if (tax && registration && (matches.length !== 2 || matches.some(item => item.ids.length !== 1))) {
    return {
      matched: false,
      ambiguous: true,
      source: matches.some(item => item.ids.length > 1) ? 'S4_AMBIGUOUS' : 'S4_IDENTIFIER_CONFLICT',
      businessPartnerId: null,
      message: errors.length ? errors.join('; ') : 'Both supplied identifiers must independently resolve to one matching Business Partner.'
    };
  }
  const populated = matches.filter(item => item.ids.length > 0);
  if (matches.some(item => item.ids.length > 1)) {
    return { matched: false, ambiguous: true, source: 'S4_AMBIGUOUS', businessPartnerId: null };
  }
  if (populated.length === 0) {
    return { matched: false, source: 'S4_NOT_FOUND', businessPartnerId: null, message: errors.join('; ') || undefined };
  }
  const candidateIds = [...new Set(populated.flatMap(item => item.ids))];
  // If both identifiers were supplied they must independently resolve to the same BP.
  if (candidateIds.length !== 1 || (populated.length > 1 && populated.some(item => !item.ids.includes(candidateIds[0])))) {
    return { matched: false, ambiguous: true, source: 'S4_IDENTIFIER_CONFLICT', businessPartnerId: null };
  }

  const businessPartnerId = candidateIds[0];
  let companyName = null;
  try {
    const rows = await searchBusinessPartnerEntity(
      destination,
      'A_BusinessPartner',
      `BusinessPartner eq '${odataQuote(businessPartnerId)}'`,
      'BusinessPartner,BusinessPartnerFullName,BusinessPartnerName'
    );
    const row = rows[0];
    companyName = row?.BusinessPartnerFullName ?? row?.BusinessPartnerName ?? null;
  } catch {
    // The identifier match remains valid even if the optional name enrichment fails.
  }
  return {
    matched: true,
    source: 'S4HANA_API_BUSINESS_PARTNER',
    businessPartnerId,
    companyName
  };
}


/** Verifies that a system-admin-entered BP number exists in the connected S/4 system. */
export async function verifyBusinessPartnerId(businessPartnerId) {
  const path = businessPartnerPath(businessPartnerId);
  const destination = await getDestination({ destinationName: DESTINATION_NAME });
  if (!destination?.url) throw new Error(`Destination ${DESTINATION_NAME} is unavailable.`);
  if (new URL(destination.url).protocol !== 'https:') throw new Error('The S/4HANA destination must use HTTPS.');
  const response = await executeHttpRequest(destination, {
    method: 'GET',
    url: `${path}?$select=BusinessPartner,BusinessPartnerFullName,BusinessPartnerName`,
    headers: { Accept: 'application/json' },
    timeout: 15000
  }, { fetchCsrfToken: false });
  const data = response.data;
  const bp = data?.BusinessPartner ?? data?.d?.BusinessPartner ?? data?.value?.[0]?.BusinessPartner;
  if (!bp) return null;
  return {
    businessPartnerId: String(bp),
    companyName: data?.BusinessPartnerFullName ?? data?.BusinessPartnerName ?? data?.d?.BusinessPartnerFullName ?? data?.d?.BusinessPartnerName ?? null
  };
}
