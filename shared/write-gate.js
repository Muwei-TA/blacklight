const fs = require('node:fs');
const path = require('node:path');

const MAINTENANCE_MARKER = '[CLOUDBASE_WRITES_PAUSED]';
const PAUSE_FILE = 'CLOUDBASE_WRITES_PAUSED';

function markerExists(markerPath) {
  try {
    fs.statSync(markerPath);
    return true;
  } catch (err) {
    // A missing marker is the normal state. Any other filesystem failure is
    // treated as paused so an unreadable activation marker cannot fail open.
    return !err || err.code !== 'ENOENT';
  }
}

function isCloudbaseWritesPaused({ env = process.env, markerPath } = {}) {
  if (env && env.CLOUDBASE_WRITES_PAUSED === '1') return true;
  const activationFile = markerPath || path.resolve(__dirname, '..', PAUSE_FILE);
  return markerExists(activationFile);
}

function readRequestId(context = {}) {
  const value = context && (context.requestId || context.request_id);
  if (typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\r\n]/.test(value)) {
    return value;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return 'unknown';
}

function maintenanceResult(requestId) {
  return {
    code: 'maintenance',
    status: 'paused',
    requestId,
  };
}

function withCloudbaseWriteGate(handler, options = {}) {
  if (typeof handler !== 'function') throw new TypeError('handler must be a function');

  return async function guardedMain(event = {}, context = {}) {
    const requestId = readRequestId(context);
    if (isCloudbaseWritesPaused(options)) {
      console.warn(MAINTENANCE_MARKER, { requestId });
      return maintenanceResult(requestId);
    }
    return handler(event, context);
  };
}

module.exports = {
  MAINTENANCE_MARKER,
  PAUSE_FILE,
  isCloudbaseWritesPaused,
  readRequestId,
  maintenanceResult,
  withCloudbaseWriteGate,
};
