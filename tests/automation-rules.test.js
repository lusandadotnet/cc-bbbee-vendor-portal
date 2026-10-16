import test from 'node:test';
import assert from 'node:assert/strict';
import { expiryReminderThreshold } from '../srv/lib/expiry-reminder.js';

test('expiry reminders are not sent earlier than 60 days', () => {
  assert.equal(expiryReminderThreshold(61), null);
  assert.equal(expiryReminderThreshold(90), null);
});

test('selects the 60-day reminder band through the 31-day boundary', () => {
  assert.equal(expiryReminderThreshold(60), 60);
  assert.equal(expiryReminderThreshold(45), 60);
  assert.equal(expiryReminderThreshold(31), 60);
});

test('selects only the 30-day reminder band between 8 and 30 days', () => {
  assert.equal(expiryReminderThreshold(30), 30);
  assert.equal(expiryReminderThreshold(15), 30);
  assert.equal(expiryReminderThreshold(8), 30);
});

test('selects only the 7-day reminder band during the final week', () => {
  assert.equal(expiryReminderThreshold(7), 7);
  assert.equal(expiryReminderThreshold(1), 7);
  assert.equal(expiryReminderThreshold(0), 7);
});

test('does not return an expiry reminder for invalid or past-day values', () => {
  assert.equal(expiryReminderThreshold(-1), null);
  assert.equal(expiryReminderThreshold(1.5), null);
  assert.equal(expiryReminderThreshold(Number.NaN), null);
});
