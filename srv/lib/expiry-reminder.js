/**
 * Select the nearest expiry reminder band without sending future or duplicate
 * threshold notices when the daily scheduler was unavailable for several days.
 */
export function expiryReminderThreshold(daysRemaining) {
  if (!Number.isFinite(daysRemaining) || !Number.isInteger(daysRemaining)) return null;
  if (daysRemaining < 0 || daysRemaining > 60) return null;
  if (daysRemaining > 30) return 60;
  if (daysRemaining > 7) return 30;
  return 7;
}
