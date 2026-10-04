'use strict';

const { validateConfig } = require('./config');

const DEFAULT_INTERVAL_MS = 60 * 1000;
const TERM_REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;

function createTermReminderRunner(pgStore, { now = Date.now, intervalMs = TERM_REMINDER_INTERVAL_MS } = {}) {
  if (!pgStore || typeof pgStore.rpc !== 'function') throw new TypeError('PostgreSQL RPC client is required');
  let lastRunAt = 0;
  return async function runTermRemindersIfDue() {
    const current = now();
    if (current - lastRunAt < intervalMs) return { skipped: true };
    const result = await pgStore.rpc('hg_management_term_reminders', {});
    lastRunAt = current;
    return result || {};
  };
}

function intervalMs() {
  const configured = Number(process.env.WORKER_INTERVAL_MS || DEFAULT_INTERVAL_MS);
  return Number.isInteger(configured) ? Math.max(10 * 1000, Math.min(configured, 60 * 60 * 1000)) : DEFAULT_INTERVAL_MS;
}

async function start() {
  validateConfig();
  const worker = require('../cloudfunctions/worker');
  const pg = require('../shared/pg-store');
  let active = false;
  let stopping = false;
  let timer = null;
  let lastSessionCleanupAt = 0;
  const runTermRemindersIfDue = createTermReminderRunner(pg);

  async function cleanupSessions(now = Date.now()) {
    if (now - lastSessionCleanupAt < 24 * 60 * 60 * 1000) return;
    try {
      const result = await pg.query(
        `DELETE FROM public.hg_sessions
          WHERE expires_at <= NOW() OR revoked_at IS NOT NULL`,
      );
      await pg.query("DELETE FROM public.hg_web_sessions WHERE expires_at <= NOW() OR revoked_at IS NOT NULL OR last_seen_at < NOW() - INTERVAL '24 hours'");
      await pg.query("DELETE FROM public.hg_web_auth_limits WHERE window_started_at < NOW() - INTERVAL '1 day'");
      lastSessionCleanupAt = now;
      if (result.rowCount > 0) console.log('[worker] expired sessions removed', { count: result.rowCount });
    } catch (error) {
      console.error('[worker] session cleanup failed', { code: error.code || 'session_cleanup_error' });
    }
  }

  async function tick() {
    if (active || stopping) return;
    active = true;
    try {
      await cleanupSessions();
      try {
        const reminders = await runTermRemindersIfDue();
        if (!reminders.skipped && (Number(reminders.sent30Day) > 0 || Number(reminders.sent7Day) > 0)) {
          console.log('[worker] management term reminders sent', {
            sent30Day: Number(reminders.sent30Day) || 0,
            sent7Day: Number(reminders.sent7Day) || 0,
          });
        }
      } catch (error) {
        console.error('[worker] management term reminders failed', { code: error.code || 'term_reminder_error' });
      }
      const result = await worker.main(
        { mode: 'all' },
        { localRuntime: true, requestId: `nas:${Date.now().toString(36)}` },
      );
      if (!result || result.code !== 0) console.error('[worker] run incomplete', { code: result && result.code || 'worker_error' });
    } catch (error) {
      console.error('[worker] run failed', { code: error.code || 'worker_error' });
    } finally {
      active = false;
    }
  }

  await tick();
  timer = setInterval(tick, intervalMs());
  console.log('[worker] scheduler started', { intervalMs: intervalMs() });

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    if (timer) clearInterval(timer);
    while (active) await new Promise((resolve) => setTimeout(resolve, 100));
    await pg.close().catch(() => {});
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return { tick, stop, cleanupSessions };
}

if (require.main === module) {
  start().catch((error) => {
    console.error('[worker] startup failed', { code: error.code || 'startup_error' });
    process.exitCode = 1;
  });
}

module.exports = { start, intervalMs, DEFAULT_INTERVAL_MS, TERM_REMINDER_INTERVAL_MS, createTermReminderRunner };
