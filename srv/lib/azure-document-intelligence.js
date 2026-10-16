import cds from '@sap/cds';
import { getDestination } from '@sap-cloud-sdk/connectivity';
import { executeHttpRequest } from '@sap-cloud-sdk/http-client';
import { calculateRecognitionFactor } from './bee-rules.js';

const DESTINATION_NAME = 'AZURE_DOCUMENT_INTELLIGENCE';
const API_VERSION = '2024-11-30';

const QUERY_FIELDS = [
  'EntityName',
  'RegistrationNumber',
  'CertificateNumber',
  'SANASAgencyNumber',
  'EnterpriseType',
  'BEELevel',
  'NonCompliant',
  'BlackOwnershipPercentage',
  'BlackWomenOwnershipPercentage',
  'EmpoweringSupplier',
  'IssueDate',
  'ExpiryDate'
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function normalizeKey(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function rawFieldValue(fields, requestedName) {
  if (!fields) return null;

  const wanted = normalizeKey(requestedName);
  const entry = Object.entries(fields).find(
    ([key]) => normalizeKey(key) === wanted
  );

  if (!entry) return null;

  const field = entry[1];
  if (field == null || typeof field !== 'object') return field ?? null;

  for (const key of [
    'valueString',
    'valueDate',
    'valueNumber',
    'valueInteger',
    'valueBoolean',
    'valueSelectionMark',
    'value'
  ]) {
    if (field[key] !== undefined && field[key] !== null) {
      return field[key];
    }
  }

  return field.content ?? null;
}

function toText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length ? text : null;
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  const text = toText(value);
  if (!text) return null;

  const match = text.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;

  const number = Number(match[0]);
  return Number.isFinite(number) ? number : null;
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && (value === 0 || value === 1)) {
    return value === 1;
  }

  const text = toText(value)?.toLowerCase();
  if (!text) return null;

  if (['true', 'yes', 'y', '1', 'empowering supplier'].includes(text)) {
    return true;
  }

  if (['false', 'no', 'n', '0', 'not empowering supplier'].includes(text)) {
    return false;
  }

  return null;
}

function toBeeLevel(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 1 && value <= 8
      ? value
      : null;
  }

  const text = toText(value);
  if (!text || /non[\s-]*compliant/i.test(text)) return null;

  const match = text.match(/\b(?:level\s*)?([1-8])\b/i);
  return match ? Number(match[1]) : null;
}

function toEnterpriseType(value) {
  const text = toText(value)?.toUpperCase();
  if (!text) return null;

  if (/\bEME\b/.test(text)) return 'EME';
  if (/\bQSE\b/.test(text)) return 'QSE';
  if (/\bGEN(?:ERIC)?\b/.test(text)) return 'GEN';

  return null;
}

function toDate(value) {
  const text = toText(value);
  if (!text) return null;

  const dateMatch = text.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (dateMatch) {
    const date = new Date(`${dateMatch[0]}T00:00:00.000Z`);

    if (
      !Number.isNaN(date.getTime()) &&
      date.toISOString().slice(0, 10) === dateMatch[0]
    ) {
      return dateMatch[0];
    }

    return null;
  }

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;

  return date.toISOString().slice(0, 10);
}

function mapExtractedFields(fields) {
  const rawLevel = rawFieldValue(fields, 'BEELevel');
  const rawNonCompliant = rawFieldValue(fields, 'NonCompliant');

  let isNonCompliant = toBoolean(rawNonCompliant);

  if (
    isNonCompliant === null &&
    /non[\s-]*compliant/i.test(toText(rawLevel) ?? '')
  ) {
    isNonCompliant = true;
  }

  const beeLevel = isNonCompliant === true ? null : toBeeLevel(rawLevel);

  let recognitionFactor = null;
  if (isNonCompliant === true) {
    recognitionFactor = 0;
  } else if (beeLevel !== null) {
    recognitionFactor = calculateRecognitionFactor(beeLevel);
  }

  return {
    extractedEntityName: toText(rawFieldValue(fields, 'EntityName')),
    extractedRegistrationNumber: toText(
      rawFieldValue(fields, 'RegistrationNumber')
    ),
    certificateNumber: toText(
      rawFieldValue(fields, 'CertificateNumber')
    ),
    sanasAgencyNumber: toText(
      rawFieldValue(fields, 'SANASAgencyNumber')
    ),
    enterpriseType: toEnterpriseType(
      rawFieldValue(fields, 'EnterpriseType')
    ),
    beeLevel,
    isNonCompliant,
    recognitionFactor,
    blackOwnership: toNumber(
      rawFieldValue(fields, 'BlackOwnershipPercentage')
    ),
    blackWomenOwnership: toNumber(
      rawFieldValue(fields, 'BlackWomenOwnershipPercentage')
    ),
    empoweringSupplier: toBoolean(
      rawFieldValue(fields, 'EmpoweringSupplier')
    ),
    issueDate: toDate(rawFieldValue(fields, 'IssueDate')),
    expiryDate: toDate(rawFieldValue(fields, 'ExpiryDate'))
  };
}


async function analyzeUsingLocalCredentials(bytes, endpointValue, apiKey) {
  let endpoint;

  try {
    endpoint = new URL(endpointValue);
  } catch {
    throw new Error('The local Azure Document Intelligence endpoint is invalid.');
  }

  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) {
    throw new Error('The Azure OCR endpoint must be a valid HTTPS URL.');
  }

  const headers = {
    'Ocp-Apim-Subscription-Key': apiKey,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };

  const analyzeUrl = new URL(
    '/documentintelligence/documentModels/prebuilt-layout:analyze',
    endpoint.origin
  );

  analyzeUrl.searchParams.set('_overload', 'analyzeDocument');
  analyzeUrl.searchParams.set('api-version', API_VERSION);
  analyzeUrl.searchParams.set('features', 'queryFields');
  analyzeUrl.searchParams.set('queryFields', QUERY_FIELDS.join(','));

  const submission = await fetch(analyzeUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      base64Source: bytes.toString('base64')
    }),
    signal: AbortSignal.timeout(15000)
  });

  if (!submission.ok) {
    const detail = (await submission.text()).slice(0, 600);
    throw new Error(
      `Azure OCR submission failed with HTTP ${submission.status}: ${detail}`
    );
  }

  const operationLocation = submission.headers.get('operation-location');

  if (!operationLocation) {
    throw new Error('Azure did not return an OCR operation URL.');
  }

  const operationUrl = new URL(operationLocation, endpoint.origin);

  if (
    operationUrl.protocol !== 'https:' ||
    operationUrl.origin !== endpoint.origin
  ) {
    throw new Error('Azure returned an unexpected OCR operation URL.');
  }

  const deadline = Date.now() + 30000;

  while (Date.now() < deadline) {
    await sleep(750);

    const response = await fetch(operationUrl, {
      method: 'GET',
      headers: {
        'Ocp-Apim-Subscription-Key': apiKey,
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 600);
      throw new Error(
        `Azure OCR polling failed with HTTP ${response.status}: ${detail}`
      );
    }

    const operation = await response.json();
    const status = String(operation.status ?? '').toLowerCase();

    if (status === 'succeeded') {
      const documents = operation?.analyzeResult?.documents ?? [];

      return {
        fields: mapExtractedFields(documents[0]?.fields ?? {}),
        documentCount: documents.length
      };
    }

    if (status === 'failed') {
      throw new Error(
        `Azure Document Intelligence reported analysis failure: ${
          operation.error?.message ?? 'No error detail supplied'
        }`
      );
    }
  }

  throw new Error('Azure OCR timed out while waiting for document analysis.');
}


export async function analyzeDocument(bytes, mimeType) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new Error('The attachment has no readable content.');
  }

  const localAzure = cds.env.for('bbbee').azure ?? {};
  const localEndpoint = String(localAzure.endpoint ?? '').trim();
  const localKey = String(localAzure.key ?? '').trim();

  if (localEndpoint || localKey) {
    if (!localEndpoint || !localKey) {
      throw new Error(
        'Configure both bbbee.azure.endpoint and bbbee.azure.key in .env.'
      );
    }

    return analyzeUsingLocalCredentials(bytes, localEndpoint, localKey);
  }

  const destination = await getDestination({
    destinationName: DESTINATION_NAME
  });

  if (!destination?.url) {
    throw new Error(
      `Destination ${DESTINATION_NAME} was not found or has no URL.`
    );
  }

  const destinationUrl = new URL(destination.url);

  if (destinationUrl.protocol !== 'https:') {
    throw new Error('The Azure OCR destination must use HTTPS.');
  }

  // Azure accepts base64Source for binary documents through its JSON API.
  const submission = await executeHttpRequest(
    destination,
    {
      method: 'POST',
      url: '/documentintelligence/documentModels/prebuilt-layout:analyze',
      params: {
        '_overload': 'analyzeDocument',
        'api-version': API_VERSION,
        features: 'queryFields',
        queryFields: QUERY_FIELDS.join(',')
      },
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      data: {
        base64Source: bytes.toString('base64')
      },
      timeout: 15000
    },
    { fetchCsrfToken: false }
  );

  const operationLocation =
    submission.headers?.['operation-location'] ??
    submission.headers?.['Operation-Location'];

  if (!operationLocation) {
    throw new Error('Azure did not return an OCR operation URL.');
  }

  // Only poll the same HTTPS host configured in the destination.
  const operationUrl = new URL(operationLocation, destination.url);

  if (
    operationUrl.protocol !== 'https:' ||
    operationUrl.origin !== destinationUrl.origin
  ) {
    throw new Error('Azure returned an unexpected OCR operation URL.');
  }

  const pollPath = `${operationUrl.pathname}${operationUrl.search}`;
  const deadline = Date.now() + 30000;
  let operation;

  while (Date.now() < deadline) {
    await sleep(750);

    const poll = await executeHttpRequest(
      destination,
      {
        method: 'GET',
        url: pollPath,
        headers: { Accept: 'application/json' },
        timeout: 10000
      },
      { fetchCsrfToken: false }
    );

    operation = poll.data;
    const status = String(operation?.status ?? '').toLowerCase();

    if (status === 'succeeded') {
      const documents = operation?.analyzeResult?.documents ?? [];
      const fields = documents[0]?.fields ?? {};

      return {
        fields: mapExtractedFields(fields),
        documentCount: documents.length
      };
    }

    if (status === 'failed') {
      throw new Error('Azure Document Intelligence reported analysis failure.');
    }
  }

  throw new Error(
    'OCR timed out while waiting for Azure Document Intelligence.'
  );
}
