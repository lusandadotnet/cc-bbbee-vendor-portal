const RECOGNITION_FACTORS = Object.freeze({
  1: 135,
  2: 125,
  3: 110,
  4: 100,
  5: 80,
  6: 60,
  7: 50,
  8: 10
});

export function calculateRecognitionFactor(beeLevel, isNonCompliant = false) {
  if (isNonCompliant) return 0;

  if (!Number.isInteger(beeLevel) ||
      !Object.hasOwn(RECOGNITION_FACTORS, beeLevel)) {
    throw new RangeError('B-BBEE level must be an integer from 1 to 8.');
  }

  return RECOGNITION_FACTORS[beeLevel];
}

export function deriveOwnershipFlags(blackOwnership, blackWomenOwnership) {
  validatePercentage(blackOwnership, 'Black ownership');
  validatePercentage(blackWomenOwnership, 'Black women ownership');

  if (blackWomenOwnership > blackOwnership) {
    throw new RangeError(
      'Black women ownership cannot exceed total black ownership.'
    );
  }

  return {
    isBlackOwned: blackOwnership >= 51,
    isBlackWomenOwned: blackWomenOwnership >= 30
  };
}

function validatePercentage(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) ||
      value < 0 || value > 100) {
    throw new RangeError(`${label} must be between 0 and 100.`);
  }
}

function parseDate(value, fieldName) {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RangeError(`${fieldName} must be a valid YYYY-MM-DD date.`);
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  if (Number.isNaN(date.getTime()) ||
      date.toISOString().slice(0, 10) !== value) {
    throw new RangeError(`${fieldName} is not a valid calendar date.`);
  }

  return date;
}

export function validateCertificateDates(
  issueDate,
  expiryDate,
  today = new Date().toISOString().slice(0, 10)
) {
  if (!issueDate || !expiryDate) {
    throw new RangeError('Issue date and expiry date are required.');
  }

  const issue = parseDate(issueDate, 'Issue date');
  const expiry = parseDate(expiryDate, 'Expiry date');
  const current = parseDate(today, 'Current date');

  if (issue > current) {
    throw new RangeError('Issue date cannot be in the future.');
  }

  if (expiry < issue) {
    throw new RangeError('Expiry date cannot precede issue date.');
  }

  const validityDays = (expiry.getTime() - issue.getTime()) / 86400000;

  if (validityDays > 365) {
    throw new RangeError(
      'Certificate validity cannot exceed 365 calendar days.'
    );
  }

  if (expiry < current) {
    throw new RangeError('Certificate has expired.');
  }

  return { validityDays };
}

export function validateCertificate(data, options = {}) {
  const today = options.today ??
    new Date().toISOString().slice(0, 10);

  const requiresDates =
    data.status === 'PendingReview' || data.status === 'Approved';

  if (requiresDates || data.issueDate || data.expiryDate) {
    validateCertificateDates(data.issueDate, data.expiryDate, today);
  }

  if (data.isNonCompliant === true) {
    if (data.beeLevel != null) {
      throw new RangeError(
        'A non-compliant certificate must not have a B-BBEE level.'
      );
    }
  } else if (data.beeLevel != null) {
    calculateRecognitionFactor(data.beeLevel);
  }

  const hasOwnership =
    data.blackOwnership != null || data.blackWomenOwnership != null;

  if (hasOwnership) {
    if (data.blackOwnership == null || data.blackWomenOwnership == null) {
      throw new RangeError(
        'Both black ownership percentages must be provided together.'
      );
    }

    deriveOwnershipFlags(
      Number(data.blackOwnership),
      Number(data.blackWomenOwnership)
    );
  }

  return true;
}
