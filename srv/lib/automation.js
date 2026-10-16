import cds from '@sap/cds';
import { getDestination } from '@sap-cloud-sdk/connectivity';
import { executeHttpRequest } from '@sap-cloud-sdk/http-client';
import { syncSupplierCompliance } from './s4-business-partner.js';
import { expiryReminderThreshold } from './expiry-reminder.js';
import { requireSystemAdmin, isProduction } from './authorization.js';

const { SELECT, INSERT, UPDATE } = cds.ql;
const log = cds.log('bbbee-automation');
const DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit'
});

export function localDateString(date = new Date()) {
  // en-CA normally renders ISO, but build it explicitly so locale ICU variations cannot change the key.
  const parts = Object.fromEntries(DATE_FORMATTER.formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function clean(value) { return typeof value === 'string' ? value.trim() : ''; }

export async function enqueueIntegrationEvent(tx, supplier, certificate, eventType) {
  const transitionKey = certificate.modifiedAt ? String(certificate.modifiedAt) : String(certificate.status ?? 'initial');
  const idempotencyKey = `BEE:S4:${supplier.ID}:${certificate.ID}:${eventType}:${transitionKey}`;
  const existing = await tx.run(SELECT.one.from('cc.bbbee.IntegrationOutbox').where({ idempotencyKey }));
  if (existing) return idempotencyKey;
  await tx.run(INSERT.into('cc.bbbee.IntegrationOutbox').entries({
    idempotencyKey,
    eventType,
    supplier_ID: supplier.ID,
    certificate_ID: certificate.ID,
    payload: JSON.stringify({
      businessPartnerId: supplier.businessPartnerId ?? null,
      certificateID: certificate.ID,
      eventType,
      currentComplianceState: supplier.currentComplianceState ?? null,
      currentBEELevel: supplier.currentBEELevel ?? null,
      recognitionFactor: supplier.recognitionFactor == null ? null : Number(supplier.recognitionFactor),
      expiryDate: certificate.expiryDate ?? null
    }),
    status: 'Pending',
    attempts: 0
  }));
  return idempotencyKey;
}

export async function enqueueNotification(tx, supplier, certificate, {
  eventType, daysToExpiry = null, subject, body
}) {
  const idempotencyKey = `BEE:NOTICE:${certificate.ID}:${eventType}:${daysToExpiry ?? 'NA'}`;
  const existing = await tx.run(SELECT.one.from('cc.bbbee.NotificationEvents').where({ idempotencyKey }));
  if (existing) return false;
  await tx.run(INSERT.into('cc.bbbee.NotificationEvents').entries({
    idempotencyKey,
    supplier_ID: supplier.ID,
    certificate_ID: certificate.ID,
    eventType,
    daysToExpiry,
    recipient: supplier.contactEmail ?? null,
    subject,
    body,
    status: supplier.contactEmail ? 'Pending' : 'Blocked',
    attempts: 0,
    lastError: supplier.contactEmail ? null : 'No supplier contact email is recorded.'
  }));
  return true;
}

function isoDate(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function dateDiffDays(fromDate, toDate) {
  const from = new Date(`${isoDate(fromDate)}T00:00:00.000Z`);
  const to = new Date(`${isoDate(toDate)}T00:00:00.000Z`);
  return Math.round((to.getTime() - from.getTime()) / 86400000);
}

async function auditExpiry(tx, certificate, supplier, today, actor) {
  await tx.run(INSERT.into('cc.bbbee.AuditTrail').entries({
    ID: cds.utils.uuid(),
    certificate_ID: certificate.ID,
    supplier_ID: supplier.ID,
    action: 'SystemExpire',
    performedBy: actor,
    previousStatus: 'Approved',
    newStatus: 'Expired',
    remarks: `Active certificate expired on ${String(certificate.expiryDate).slice(0, 10)}; supplier compliance was set to NonCompliant.`,
    fieldDeltas: JSON.stringify({
      certificate: { status: { before: 'Approved', after: 'Expired' } },
      supplier: {
        currentComplianceState: { before: supplier.currentComplianceState, after: 'NonCompliant' },
        recognitionFactor: { before: supplier.recognitionFactor, after: 0 },
        currentBEELevel: { before: supplier.currentBEELevel, after: null }
      },
      runDate: today
    })
  }));
}

export async function runDailyExpiryJob({ actor = 'system-expiry-job' } = {}) {
  const today = localDateString();
  const runToken = cds.utils.uuid();
  const result = { status: 'Succeeded', message: 'Expiry monitoring completed.', certificatesExpired: 0, notificationsQueued: 0, integrationQueued: 0, integrationProcessed: 0 };
  let acquired = false;
  try {
    await cds.db.tx(async tx => {
      const run = await tx.run(SELECT.one.from('cc.bbbee.ExpiryJobRuns').where({ runDate: today }));
      if (run?.status === 'Succeeded') {
        result.status = 'AlreadyRun';
        result.message = `Expiry monitoring already completed for ${today}.`;
        return;
      }
      if (run?.status === 'Running') {
        const startedMs = run.startedAt ? new Date(run.startedAt).getTime() : 0;
        if (startedMs && Date.now() - startedMs < 10 * 60 * 1000) {
          result.status = 'AlreadyRunning';
          result.message = `Expiry monitoring for ${today} is already running on an application instance.`;
          return;
        }
      }
      if (!run) {
        await tx.run(INSERT.into('cc.bbbee.ExpiryJobRuns').entries({
          runDate: today, status: 'Running', startedAt: new Date().toISOString(), runToken,
          certificatesExpired: 0, notificationsQueued: 0, integrationQueued: 0
        }));
      } else {
        await tx.run(UPDATE('cc.bbbee.ExpiryJobRuns').set({
          status: 'Running', startedAt: new Date().toISOString(), runToken,
          finishedAt: null, errorMessage: null
        }).where({ runDate: today, runToken: run.runToken ?? null }));
      }
      acquired = true;

      const activeCertificates = await tx.run(
        SELECT.from('cc.bbbee.Certificates').where({ status: 'Approved' })
      );
      for (const certificate of activeCertificates) {
        if (!certificate.expiryDate) continue;
        const supplier = await tx.run(
          SELECT.one.from('cc.bbbee.Suppliers').where({ ID: certificate.supplier_ID })
        );
        if (!supplier || supplier.activeCertificate_ID !== certificate.ID) continue;
        const expiryDate = isoDate(certificate.expiryDate);
        const daysRemaining = dateDiffDays(today, expiryDate);

        if (daysRemaining < 0) {
          await tx.run(UPDATE('cc.bbbee.Certificates').set({ status: 'Expired' }).where({ ID: certificate.ID, status: 'Approved' }));
          const afterSupplier = {
            ...supplier,
            currentComplianceState: 'NonCompliant', currentBEELevel: null,
            recognitionFactor: 0,
            s4SyncStatus: supplier.businessPartnerId ? 'Pending' : 'NotLinked',
            s4SyncMessage: 'Certificate expiry requires a non-compliant status update in S/4HANA.'
          };
          await tx.run(UPDATE('cc.bbbee.Suppliers').set({
            currentComplianceState: 'NonCompliant', currentBEELevel: null,
            recognitionFactor: 0, s4SyncStatus: afterSupplier.s4SyncStatus,
            s4SyncMessage: afterSupplier.s4SyncMessage
          }).where({ ID: supplier.ID }));
          await auditExpiry(tx, certificate, supplier, today, actor);
          await enqueueIntegrationEvent(tx, afterSupplier, { ...certificate, status: 'Expired', isNonCompliant: true }, 'EXPIRE_NON_COMPLIANT');
          const notificationQueued = await enqueueNotification(tx, afterSupplier, { ...certificate, status: 'Expired' }, {
            eventType: 'CERTIFICATE_EXPIRED',
            subject: `B-BBEE certificate expired: ${supplier.companyName}`,
            body: `The B-BBEE certificate ${certificate.certificateNumber || certificate.ID} expired on ${expiryDate}. The supplier is now marked Non-Compliant with a recognition factor of 0 until a replacement certificate is approved.`
          });
          result.certificatesExpired++;
          result.integrationQueued++;
          if (notificationQueued) result.notificationsQueued++;
          continue;
        }

        // Queue only the nearest due reminder band. If the app was down on
        // an exact boundary, catch up with the most relevant due reminder.
        const threshold = expiryReminderThreshold(daysRemaining);
        if (threshold == null) continue;
        const key = `BEE:NOTICE:${certificate.ID}:EXPIRY_${threshold}D:${threshold}`;
        const existingNotice = await tx.run(SELECT.one.from('cc.bbbee.NotificationEvents').where({ idempotencyKey: key }));
        if (!existingNotice) {
          const queued = await enqueueNotification(tx, supplier, certificate, {
            eventType: `EXPIRY_${threshold}D`,
            daysToExpiry: threshold,
            subject: `B-BBEE certificate expires in ${daysRemaining} day${daysRemaining === 1 ? '' : 's'}: ${supplier.companyName}`,
            body: `The active B-BBEE certificate ${certificate.certificateNumber || certificate.ID} expires on ${expiryDate} (${daysRemaining} day${daysRemaining === 1 ? '' : 's'} remaining). Please submit a replacement certificate and allow time for compliance review.`
          });
          if (queued) result.notificationsQueued++;
        }
      }
      await tx.run(UPDATE('cc.bbbee.ExpiryJobRuns').set({
        status: 'Succeeded', certificatesExpired: result.certificatesExpired,
        notificationsQueued: result.notificationsQueued,
        integrationQueued: result.integrationQueued,
        finishedAt: new Date().toISOString(), errorMessage: null
      }).where({ runDate: today, runToken }));
    });
  } catch (error) {
    result.status = 'Failed';
    result.message = `Expiry monitoring failed: ${error?.message ?? 'Unknown error'}`;
    log.error(result.message);
    // Only mark the run we acquired. A competing application instance must not
    // accidentally mark another instance's successful run as failed.
    try {
      await cds.db.tx(async tx => {
        const current = await tx.run(SELECT.one.from('cc.bbbee.ExpiryJobRuns').where({ runDate: today }));
        if (acquired && current?.runToken === runToken) {
          await tx.run(UPDATE('cc.bbbee.ExpiryJobRuns').set({
            status: 'Failed', finishedAt: new Date().toISOString(), errorMessage: result.message.slice(0, 1000)
          }).where({ runDate: today, runToken }));
        } else if (!current) {
          await tx.run(INSERT.into('cc.bbbee.ExpiryJobRuns').entries({
            runDate: today, status: 'Failed', startedAt: new Date().toISOString(), runToken,
            finishedAt: new Date().toISOString(), errorMessage: result.message.slice(0, 1000)
          }));
        }
      });
    } catch (recordError) {
      log.error('Could not persist expiry job failure:', recordError?.message);
    }
  }
  return result;
}

export async function processIntegrationOutbox() {
  const result = { status: 'Succeeded', message: 'Integration outbox processed.', certificatesExpired: 0, notificationsQueued: 0, integrationQueued: 0, integrationProcessed: 0 };
  const live = String(process.env.S4_SYNC_MODE || 'dry-run').toLowerCase() === 'live';
  const statuses = live ? ['Pending', 'Failed', 'NotLinked', 'DryRun'] : ['Pending', 'Failed'];
  const candidates = await cds.db.run(
    SELECT.from('cc.bbbee.IntegrationOutbox')
      .where({ status: { in: statuses } })
      .orderBy('createdAt asc')
      .limit(100)
  );
  const now = Date.now();
  const rows = candidates.filter(item => {
    if (!item.lastAttemptAt) return true;
    const delay = Math.min(60, 2 ** Math.min(item.attempts ?? 0, 6)) * 60 * 1000;
    return now - new Date(item.lastAttemptAt).getTime() >= delay;
  }).slice(0, 25);
  let failures = 0;
  for (const item of rows) {
    try {
      const changed = await cds.db.run(
        UPDATE('cc.bbbee.IntegrationOutbox').set({
          status: 'Processing', attempts: (item.attempts ?? 0) + 1,
          lastAttemptAt: new Date().toISOString(), lastError: null
        }).where({ idempotencyKey: item.idempotencyKey, status: item.status })
      );
      if (typeof changed === 'number' && changed === 0) continue;
      const supplier = await cds.db.run(SELECT.one.from('cc.bbbee.Suppliers').where({ ID: item.supplier_ID }));
      const certificate = item.certificate_ID
        ? await cds.db.run(SELECT.one.from('cc.bbbee.Certificates').where({ ID: item.certificate_ID }))
        : null;
      if (!supplier || !certificate) throw new Error('The supplier or certificate referenced by the outbox event no longer exists.');
      const syncResult = await syncSupplierCompliance(supplier, certificate, { idempotencyKey: item.idempotencyKey });
      if (syncResult.status === 'Succeeded') {
        await cds.db.run(UPDATE('cc.bbbee.IntegrationOutbox').set({ status: 'Succeeded', deliveredAt: new Date().toISOString(), lastError: null }).where({ idempotencyKey: item.idempotencyKey }));
        await cds.db.run(UPDATE('cc.bbbee.Suppliers').set({ s4SyncStatus: 'Succeeded', s4LastSyncAt: new Date().toISOString(), s4SyncMessage: syncResult.message }).where({ ID: supplier.ID }));
      } else {
        const queuedStatus = syncResult.status === 'DryRun' ? 'DryRun' : syncResult.status === 'NotLinked' ? 'NotLinked' : 'Failed';
        await cds.db.run(UPDATE('cc.bbbee.IntegrationOutbox').set({ status: queuedStatus, lastError: syncResult.message }).where({ idempotencyKey: item.idempotencyKey }));
        await cds.db.run(UPDATE('cc.bbbee.Suppliers').set({ s4SyncStatus: queuedStatus, s4SyncMessage: syncResult.message }).where({ ID: supplier.ID }));
      }
      result.integrationProcessed++;
    } catch (error) {
      failures++;
      const message = String(error?.message ?? 'Unknown integration error').slice(0, 1000);
      await cds.db.run(UPDATE('cc.bbbee.IntegrationOutbox').set({ status: 'Failed', lastError: message }).where({ idempotencyKey: item.idempotencyKey }));
      await cds.db.run(UPDATE('cc.bbbee.Suppliers').set({ s4SyncStatus: 'Failed', s4SyncMessage: message.slice(0, 500) }).where({ ID: item.supplier_ID }));
      log.error(`S/4 outbox event ${item.idempotencyKey} failed: ${message}`);
    }
  }
  if (failures) {
    result.status = 'PartialFailure';
    result.message = `Processed ${result.integrationProcessed} S/4 event(s); ${failures} failed and remain available for retry.`;
  } else {
    result.message = `Processed ${result.integrationProcessed} S/4 event(s). Mode: ${live ? 'live' : 'dry-run'}.`;
  }
  return result;
}

export async function dispatchNotifications() {
  const result = { status: 'Succeeded', message: 'Notification outbox processed.', certificatesExpired: 0, notificationsQueued: 0, integrationQueued: 0, integrationProcessed: 0 };
  const destinationName = clean(process.env.BEE_NOTIFICATION_DESTINATION || 'BB_BEE_NOTIFICATION_SERVICE');
  const mode = String(process.env.BEE_NOTIFICATION_MODE || (isProduction() ? 'destination' : 'log')).toLowerCase();
  if (!['destination', 'log'].includes(mode)) {
    result.status = 'Failed';
    result.message = 'BEE_NOTIFICATION_MODE must be destination or log.';
    return result;
  }
  const notificationPath = clean(process.env.BEE_NOTIFICATION_PATH || '/notifications');
  if (mode === 'destination' && (!notificationPath.startsWith('/') || notificationPath.startsWith('//') || notificationPath.includes('..') || /^https?:/i.test(notificationPath))) {
    result.status = 'Failed';
    result.message = 'BEE_NOTIFICATION_PATH must be a relative HTTPS destination path beginning with one slash.';
    return result;
  }
  const candidates = await cds.db.run(
    SELECT.from('cc.bbbee.NotificationEvents')
      .where({ status: { in: ['Pending', 'Failed', 'Blocked'] } })
      .orderBy('createdAt asc')
      .limit(100)
  );
  const now = Date.now();
  const rows = candidates.filter(event => {
    if (!event.lastAttemptAt) return true;
    const delay = Math.min(60, 2 ** Math.min(event.attempts ?? 0, 6)) * 60 * 1000;
    return now - new Date(event.lastAttemptAt).getTime() >= delay;
  }).slice(0, 25);
  let failures = 0;
  for (const originalEvent of rows) {
    let event = originalEvent;
    if (event.status === 'Blocked' || !event.recipient) {
      const supplier = await cds.db.run(SELECT.one.from('cc.bbbee.Suppliers').where({ ID: event.supplier_ID }));
      if (!clean(supplier?.contactEmail)) {
        await cds.db.run(UPDATE('cc.bbbee.NotificationEvents').set({ status: 'Blocked', lastError: 'No supplier contact email is recorded.' }).where({ idempotencyKey: event.idempotencyKey }));
        continue;
      }
      event = { ...event, recipient: supplier.contactEmail };
      await cds.db.run(UPDATE('cc.bbbee.NotificationEvents').set({ status: 'Pending', recipient: event.recipient, lastError: null }).where({ idempotencyKey: event.idempotencyKey }));
    }
    if (mode === 'log') {
      await cds.db.run(UPDATE('cc.bbbee.NotificationEvents').set({ status: 'Logged', deliveredAt: new Date().toISOString(), lastError: 'Development log mode; no external notification was sent.' }).where({ idempotencyKey: event.idempotencyKey }));
      result.notificationsQueued++;
      continue;
    }
    try {
      const destination = await getDestination({ destinationName });
      if (!destination?.url) throw new Error(`Notification destination ${destinationName} is unavailable.`);
      if (new URL(destination.url).protocol !== 'https:') throw new Error('The notification destination must use HTTPS.');
      const response = await executeHttpRequest(destination, {
        method: 'POST',
        url: notificationPath,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Idempotency-Key': event.idempotencyKey },
        data: {
          idempotencyKey: event.idempotencyKey,
          to: event.recipient,
          subject: event.subject,
          body: event.body,
          eventType: event.eventType,
          supplier_ID: event.supplier_ID,
          certificate_ID: event.certificate_ID
        },
        timeout: 15000
      }, { fetchCsrfToken: false });
      if (response.status < 200 || response.status >= 300) throw new Error(`Notification endpoint returned HTTP ${response.status}.`);
      await cds.db.run(UPDATE('cc.bbbee.NotificationEvents').set({ status: 'Succeeded', deliveredAt: new Date().toISOString(), attempts: (event.attempts ?? 0) + 1, lastAttemptAt: new Date().toISOString(), lastError: null }).where({ idempotencyKey: event.idempotencyKey }));
      result.notificationsQueued++;
    } catch (error) {
      failures++;
      const message = String(error?.message ?? 'Unknown notification error').slice(0, 1000);
      await cds.db.run(UPDATE('cc.bbbee.NotificationEvents').set({ status: 'Failed', attempts: (event.attempts ?? 0) + 1, lastAttemptAt: new Date().toISOString(), lastError: message }).where({ idempotencyKey: event.idempotencyKey }));
      log.error(`Notification ${event.idempotencyKey} failed: ${message}`);
    }
  }
  result.status = failures ? 'PartialFailure' : 'Succeeded';
  result.message = failures
    ? `Processed ${result.notificationsQueued} notification(s); ${failures} remain available for retry.`
    : `Processed ${result.notificationsQueued} notification(s). Mode: ${mode}.`;
  return result;
}

export async function handleRunExpiryJob(req) {
  requireSystemAdmin(req);
  return runDailyExpiryJob({ actor: req.user?.id || 'system-expiry-job' });
}

export async function handleProcessIntegrationOutbox(req) {
  requireSystemAdmin(req);
  return processIntegrationOutbox();
}

export async function handleDispatchNotifications(req) {
  requireSystemAdmin(req);
  return dispatchNotifications();
}

export async function handleRequeueBlockedNotifications(req) {
  requireSystemAdmin(req);
  return dispatchNotifications();
}

let scheduled = false;
export function registerAutomationScheduler() {
  if (scheduled || !isProduction() || String(process.env.BB_BEE_AUTOMATION_ENABLED ?? 'true').toLowerCase() === 'false') return;
  scheduled = true;
  const timer = setInterval(async () => {
    try {
      // Each daily sweep is guarded by ExpiryJobRuns.runDate, while outbox work is idempotent.
      await runDailyExpiryJob();
      await processIntegrationOutbox();
      await dispatchNotifications();
    } catch (error) {
      log.error('Automation cycle failed:', error?.message ?? error);
    }
  }, Number(process.env.BB_BEE_AUTOMATION_INTERVAL_MS || 60000));
  timer.unref?.();
  log.info('B-BBEE automation scheduler registered.');
}
