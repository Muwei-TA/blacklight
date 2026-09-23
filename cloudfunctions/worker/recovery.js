/**
 * Worker lease/retry helpers.
 *
 * This module deliberately has no CloudBase dependency.  The scheduler keeps
 * the database conditional updates in index.js, while the timing and retry
 * rules stay deterministic and unit-testable.
 */

const crypto = require('node:crypto');

const DEFAULT_LEASE_MS = 90 * 1000;
const DEFAULT_WAIT_MS = 60 * 1000;
const DEFAULT_RETRY_BASE_MS = 30 * 1000;
const DEFAULT_RETRY_MAX_MS = 15 * 60 * 1000;

function toMillis(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) {
    const result = value.getTime();
    return Number.isFinite(result) ? result : null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const result = new Date(value).getTime();
  return Number.isFinite(result) ? result : null;
}

function nowMillis(now = Date.now()) {
  const result = toMillis(now);
  return result === null ? Date.now() : result;
}

function isTaskDue(task, now = Date.now()) {
  const nextAttemptAt = toMillis(task && task.nextAttemptAt);
  return nextAttemptAt === null || nextAttemptAt <= nowMillis(now);
}

function isLeaseExpired(task, now = Date.now(), leaseMs = DEFAULT_LEASE_MS) {
  const nowAt = nowMillis(now);
  const explicitExpiry = toMillis(task && task.leaseExpiresAt);
  if (explicitExpiry !== null) return explicitExpiry <= nowAt;

  // Tasks written by the previous worker have claimedAt but no lease field.
  // Recover those after the same lease window.  A running task with neither
  // timestamp is also recoverable: it cannot prove that an instance owns it.
  const claimedAt = toMillis(task && task.claimedAt);
  return claimedAt === null || claimedAt + leaseMs <= nowAt;
}

function createLeaseId(invocationId = 'worker') {
  const prefix = String(invocationId || 'worker').slice(0, 80);
  return `${prefix}:${Date.now().toString(36)}:${crypto.randomBytes(12).toString('hex')}`;
}

function buildLeaseFields({ leaseId, now = Date.now(), leaseMs = DEFAULT_LEASE_MS }) {
  const nowAt = nowMillis(now);
  return {
    leaseId,
    claimedAt: new Date(nowAt),
    leaseExpiresAt: new Date(nowAt + leaseMs),
  };
}

function retryDelay(attempt, {
  baseMs = DEFAULT_RETRY_BASE_MS,
  maxMs = DEFAULT_RETRY_MAX_MS,
} = {}) {
  const n = Math.max(1, Number(attempt) || 1);
  return Math.min(maxMs, baseMs * (2 ** (n - 1)));
}

function clearLeaseFields() {
  return {
    leaseId: '',
    leaseExpiresAt: null,
    claimedAt: null,
  };
}

function safeErrorMessage(error) {
  const message = error && error.message ? String(error.message) : String(error || 'worker task failed');
  return message.replace(/[\r\n]+/g, ' ').slice(0, 300);
}

/** A queued result is a dependency wait, not an execution failure. */
function isWaitingResult(result) {
  return !!result && result.status === 'queued';
}

function buildWaitingUpdate(result, now = Date.now(), waitMs = DEFAULT_WAIT_MS) {
  const requestedNextAttempt = toMillis(result && result.nextAttemptAt);
  return {
    status: 'queued',
    note: result && result.note ? String(result.note).slice(0, 300) : 'waiting for dependency',
    waitingReason: result && result.waitingReason ? String(result.waitingReason).slice(0, 100) : 'dependency',
    nextAttemptAt: new Date(requestedNextAttempt && requestedNextAttempt > nowMillis(now)
      ? requestedNextAttempt : nowMillis(now) + waitMs),
    lastError: '',
    finishedAt: null,
    ...clearLeaseFields(),
  };
}

function buildTerminalUpdate(result, now = Date.now()) {
  return {
    status: result.status,
    note: result.note ? String(result.note).slice(0, 300) : '',
    waitingReason: '',
    nextAttemptAt: null,
    lastError: '',
    finishedAt: new Date(nowMillis(now)),
    ...clearLeaseFields(),
  };
}

function buildFailureUpdate(task, error, now = Date.now(), {
  maxAttempts = 5,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
  retryMaxMs = DEFAULT_RETRY_MAX_MS,
} = {}) {
  const attempts = (Number(task && task.attempts) || 0) + 1;
  const exhausted = attempts >= maxAttempts;
  const update = {
    status: exhausted ? 'manual' : 'queued',
    attempts,
    lastError: safeErrorMessage(error),
    waitingReason: '',
    nextAttemptAt: exhausted
      ? null
      : new Date(nowMillis(now) + retryDelay(attempts, { baseMs: retryBaseMs, maxMs: retryMaxMs })),
    finishedAt: exhausted ? new Date(nowMillis(now)) : null,
    ...clearLeaseFields(),
  };
  if (exhausted) update.note = 'retry limit reached; manual review required';
  return { update, attempts, exhausted };
}

module.exports = {
  DEFAULT_LEASE_MS,
  DEFAULT_WAIT_MS,
  DEFAULT_RETRY_BASE_MS,
  DEFAULT_RETRY_MAX_MS,
  toMillis,
  nowMillis,
  isTaskDue,
  isLeaseExpired,
  createLeaseId,
  buildLeaseFields,
  retryDelay,
  safeErrorMessage,
  isWaitingResult,
  buildWaitingUpdate,
  buildTerminalUpdate,
  buildFailureUpdate,
};
