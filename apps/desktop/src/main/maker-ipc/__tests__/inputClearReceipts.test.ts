import { expect, it } from 'vitest';
import { InputClearReceipts } from '../inputClearReceipts.js';

it('isolates owner/task/request generations and refuses a second pending mutation', () => {
  const receipts = new InputClearReceipts(), owner = {};
  const first = receipts.begin(owner, 1, 'task', 'at');
  expect(() => receipts.begin(owner, 1, 'task', 'again')).toThrow('pending');
  expect(receipts.read({}, 1, 'task', 'at').status).toBe('unknown');
  expect(receipts.read(owner, 2, 'task', 'at').status).toBe('unknown');
  expect(receipts.read(owner, 1, 'other', 'at').status).toBe('unknown');
  expect(receipts.read(owner, 1, 'task', 'other').status).toBe('unknown');
  const replacement = receipts.begin(owner, 2, 'task', 'next');
  first.status = 'committed';
  expect(receipts.read(owner, 2, 'task', 'next').status).toBe('pending');
  replacement.status = 'failed';
  expect(receipts.begin(owner, 2, 'task', 'retry').status).toBe('pending');
});

it('bounds receipts without evicting active mutations or treating eviction as failure', () => {
  const receipts = new InputClearReceipts(), owner = {};
  const first = receipts.begin(owner, 1, '0', 'at');
  for (let index = 1; index < 256; index++) receipts.begin(owner, 1, String(index), 'at');
  expect(() => receipts.begin(owner, 1, 'new', 'at')).toThrow('capacity');
  first.status = 'committed';
  receipts.begin(owner, 1, 'new', 'at');
  expect(receipts.read(owner, 1, '0', 'at').status).toBe('unknown');
  expect(receipts.read(owner, 1, '1', 'at').status).toBe('pending');
});
