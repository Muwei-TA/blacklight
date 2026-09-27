import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const url = process.env.PG_TEST_URL;
if (!url || new URL(url).pathname !== '/blacklight_test' || process.env.HG_TEST_DATABASE_RESET !== 'yes') {
  throw new Error('Use an isolated blacklight_test database and HG_TEST_DATABASE_RESET=yes; never run on application data.');
}

const run = async (sql, applicationName = 'user-levels-test', asServiceRole = true) => {
  const connection = new URL(url);
  connection.searchParams.set('application_name', applicationName);
  const statement = asServiceRole ? `SET ROLE service_role; ${sql}` : sql;
  return exec('psql', [connection.toString(), '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', statement], {
    maxBuffer: 4 * 1024 * 1024,
  });
};
const sqlValue = (value) => `'${String(value).replaceAll("'", "''")}'`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForActivity(predicate, description) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { stdout } = await run(`SELECT count(*) FROM pg_stat_activity WHERE ${predicate}`, 'user-levels-poller', false);
    if (Number(stdout.trim()) > 0) return;
    await wait(25);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

test('PostgreSQL serializes daily caps and rolls approval back during account deletion', async () => {
  const prefix = `user-levels-pg-${process.pid}`;
  const actor = `${prefix}-actor`;
  const other = `${prefix}-other`;
  const deleting = `${prefix}-deleting`;
  const retryAuthor = `${prefix}-retry-author`;
  const reactionPosts = Array.from({ length: 6 }, (_, index) => `${prefix}-reaction-post-${index + 1}`);
  const commentPosts = Array.from({ length: 4 }, (_, index) => `${prefix}-comment-post-${index + 1}`);
  const comments = commentPosts.map((_, index) => `${prefix}-comment-${index + 1}`);
  const deletionPost = `${prefix}-deletion-post`;
  const deletionComment = `${prefix}-deletion-comment`;
  const deletionTask = `${prefix}-deletion-review`;
  const deletionLease = `${prefix}-deletion-lease`;
  const retryPost = `${prefix}-retry-post`;
  const retryComment = `${prefix}-retry-comment`;
  const retryTask = `${prefix}-retry-review`;
  const retryLease = `${prefix}-retry-lease`;
  const accountName = `${prefix}-account-delete`;
  const reviewName = `${prefix}-review-holds-content`;
  const memberUpdateName = `${prefix}-member-update`;
  const retryReviewName = `${prefix}-retry-review-session`;

  await run(`
    BEGIN;
    INSERT INTO public.hg_users (id, doc) VALUES
      (${sqlValue(deleting)}, jsonb_build_object('_id', ${sqlValue(deleting)}, 'status', 'active'));
    INSERT INTO public.hg_memberships (id, doc) VALUES
      (${sqlValue(`${actor}:heiguang`)}, jsonb_build_object('_id', ${sqlValue(`${actor}:heiguang`)}, 'userId', ${sqlValue(actor)}, 'clubId', 'heiguang', 'status', 'active', 'role', 'member')),
      (${sqlValue(`${other}:heiguang`)}, jsonb_build_object('_id', ${sqlValue(`${other}:heiguang`)}, 'userId', ${sqlValue(other)}, 'clubId', 'heiguang', 'status', 'active', 'role', 'member')),
      (${sqlValue(`${deleting}:heiguang`)}, jsonb_build_object('_id', ${sqlValue(`${deleting}:heiguang`)}, 'userId', ${sqlValue(deleting)}, 'clubId', 'heiguang', 'status', 'active', 'role', 'member')),
      (${sqlValue(`${retryAuthor}:heiguang`)}, jsonb_build_object('_id', ${sqlValue(`${retryAuthor}:heiguang`)}, 'userId', ${sqlValue(retryAuthor)}, 'clubId', 'heiguang', 'status', 'active', 'role', 'member'));
    INSERT INTO public.hg_posts (id, doc) VALUES
      ${[...reactionPosts, ...commentPosts].map((id) => `(${sqlValue(id)}, jsonb_build_object('_id', ${sqlValue(id)}, 'ownerId', ${sqlValue(other)}, 'clubId', 'heiguang', 'visibility', 'club', 'status', 'published', 'reactionCount', 0, 'commentCount', 0))`).join(',\n      ')},
      (${sqlValue(deletionPost)}, jsonb_build_object('_id', ${sqlValue(deletionPost)}, 'ownerId', ${sqlValue(deleting)}, 'clubId', 'heiguang', 'visibility', 'club', 'status', 'published', 'commentCount', 0)),
      (${sqlValue(retryPost)}, jsonb_build_object('_id', ${sqlValue(retryPost)}, 'ownerId', ${sqlValue(other)}, 'clubId', 'heiguang', 'visibility', 'club', 'status', 'published', 'commentCount', 0));
    INSERT INTO public.hg_comments (id, doc) VALUES
      ${comments.map((id, index) => `(${sqlValue(id)}, jsonb_build_object('_id', ${sqlValue(id)}, 'postId', ${sqlValue(commentPosts[index])}, 'ownerId', ${sqlValue(actor)}, 'status', 'pending', 'version', 1))`).join(',\n      ')},
      (${sqlValue(deletionComment)}, jsonb_build_object('_id', ${sqlValue(deletionComment)}, 'postId', ${sqlValue(deletionPost)}, 'ownerId', ${sqlValue(deleting)}, 'status', 'pending', 'version', 1)),
      (${sqlValue(retryComment)}, jsonb_build_object('_id', ${sqlValue(retryComment)}, 'postId', ${sqlValue(retryPost)}, 'ownerId', ${sqlValue(retryAuthor)}, 'status', 'pending', 'version', 1));
    INSERT INTO public.hg_review_tasks (id, doc) VALUES
      (${sqlValue(deletionTask)}, jsonb_build_object('_id', ${sqlValue(deletionTask)}, 'targetType', 'comment',
        'targetId', ${sqlValue(deletionComment)}, 'postVersion', 1, 'status', 'running', 'attempts', 0,
        'leaseId', ${sqlValue(deletionLease)}, 'leaseExpiresAt', (transaction_timestamp() + interval '5 minutes')::text,
        'createdAt', transaction_timestamp()::text)),
      (${sqlValue(retryTask)}, jsonb_build_object('_id', ${sqlValue(retryTask)}, 'targetType', 'comment',
        'targetId', ${sqlValue(retryComment)}, 'postVersion', 1, 'status', 'running', 'attempts', 0,
        'leaseId', ${sqlValue(retryLease)}, 'leaseExpiresAt', (transaction_timestamp() + interval '5 minutes')::text,
        'createdAt', transaction_timestamp()::text));
    COMMIT;
  `);

  try {
    const checkIns = await Promise.all([
      run(`SELECT public.hg_user_levels_check_in(${sqlValue(actor)})->>'awardedXp'`),
      run(`SELECT public.hg_user_levels_check_in(${sqlValue(actor)})->>'awardedXp'`),
    ]);
    assert.deepEqual(checkIns.map(({ stdout }) => stdout.trim()).sort(), ['0', '5']);
    assert.equal((await run(`SELECT count(*) FROM public.hg_user_xp_events WHERE user_id=${sqlValue(actor)} AND event_type='check_in'`)).stdout.trim(), '1');

    await Promise.all(reactionPosts.map((postId) => run(
      `SELECT public.hg_toggle_reaction(${sqlValue(actor)}, ${sqlValue(postId)}, NULL, true)`,
    )));
    assert.equal((await run(`SELECT count(*) FROM public.hg_user_xp_events WHERE user_id=${sqlValue(actor)} AND event_type='reaction' AND xp > 0`)).stdout.trim(), '5');
    assert.equal((await run(`SELECT count(*) FROM public.hg_reactions WHERE doc->>'userId'=${sqlValue(actor)}`)).stdout.trim(), '6');

    await Promise.all(comments.map((commentId) => run(
      `UPDATE public.hg_comments SET doc=doc||'{"status":"published"}'::jsonb WHERE id=${sqlValue(commentId)}`,
    )));
    assert.equal((await run(`SELECT count(*) FROM public.hg_user_xp_events WHERE user_id=${sqlValue(actor)} AND event_type='comment_approved' AND xp > 0`)).stdout.trim(), '3');
    const actorSnapshot = JSON.parse((await run(`SELECT public.hg_user_levels_snapshot(${sqlValue(actor)})`)).stdout.trim());
    assert.equal(actorSnapshot.totalXp, 19);
    assert.equal(actorSnapshot.today.earnedXp, 19);
    assert.equal(actorSnapshot.today.reactions, 5);
    assert.equal(actorSnapshot.today.comments, 3);

    // Hold the same task -> comment -> post locks as hg_finish_review, then
    // race the actual account deletion RPC. It locks membership before content.
    const reviewSql = `BEGIN;
      SELECT id FROM public.hg_review_tasks WHERE id=${sqlValue(deletionTask)} FOR UPDATE;
      SELECT id FROM public.hg_comments WHERE id=${sqlValue(deletionComment)} FOR UPDATE;
      SELECT id FROM public.hg_posts WHERE id=${sqlValue(deletionPost)} FOR UPDATE;
      SELECT pg_sleep(1.2);
      SELECT public.hg_finish_review(${sqlValue(deletionTask)}, ${sqlValue(deletionLease)}, 1, 'approve', '');
      COMMIT;`;
    const reviewPromise = run(reviewSql, reviewName).then(
      (result) => ({ result, error: null }),
      (error) => ({ result: null, error }),
    );
    await waitForActivity(
      `application_name=${sqlValue(reviewName)} AND query LIKE '%pg_sleep(1.2)%' AND state='active'`,
      'review transaction to hold content locks',
    );
    const deletionPromise = run(`SELECT public.hg_request_account_deletion(${sqlValue(deleting)})`, accountName);
    await waitForActivity(
      `application_name=${sqlValue(accountName)} AND query LIKE '%hg_request_account_deletion%' AND wait_event_type='Lock'`,
      'account deletion to hold membership while waiting for content',
    );
    const reviewResult = await reviewPromise;
    assert.ok(reviewResult.error, 'approval must abort instead of blocking on the membership row');
    assert.match(`${reviewResult.error.stderr || ''}\n${reviewResult.error.stdout || ''}`, /XP_MEMBERSHIP_BUSY/);
    await deletionPromise;

    const deletionState = JSON.parse((await run(`SELECT jsonb_build_object(
      'user', (SELECT doc->>'status' FROM public.hg_users WHERE id=${sqlValue(deleting)}),
      'membership', (SELECT doc->>'status' FROM public.hg_memberships WHERE id=${sqlValue(`${deleting}:heiguang`)}),
      'post', (SELECT doc->>'status' FROM public.hg_posts WHERE id=${sqlValue(deletionPost)}),
      'comment', (SELECT doc->>'status' FROM public.hg_comments WHERE id=${sqlValue(deletionComment)}),
      'xpEvents', (SELECT count(*) FROM public.hg_user_xp_events WHERE user_id=${sqlValue(deleting)})
    )`)).stdout.trim());
    assert.deepEqual(deletionState, {
      user: 'deletion_requested', membership: 'removed', post: 'deleted', comment: 'deleted', xpEvents: 0,
    });

    // A temporary membership-row lock also aborts the full automatic review
    // transaction. After the update commits and membership remains active, the
    // unchanged running lease can be retried and awards exactly once.
    const memberUpdate = run(`BEGIN;
      UPDATE public.hg_memberships SET doc=doc||'{"role":"moderator"}'::jsonb
      WHERE id=${sqlValue(`${retryAuthor}:heiguang`)};
      SELECT pg_sleep(0.8);
      COMMIT;`, memberUpdateName);
    await waitForActivity(
      `application_name=${sqlValue(memberUpdateName)} AND query LIKE '%pg_sleep(0.8)%' AND state='active'`,
      'temporary membership update to hold its row lock',
    );
    await assert.rejects(
      run(`SELECT public.hg_finish_review(${sqlValue(retryTask)}, ${sqlValue(retryLease)}, 1, 'approve', '')`, retryReviewName),
      (error) => /XP_MEMBERSHIP_BUSY/.test(`${error.stderr || ''}\n${error.stdout || ''}`),
    );
    await memberUpdate;
    assert.equal((await run(`SELECT doc->>'status' FROM public.hg_comments WHERE id=${sqlValue(retryComment)}`)).stdout.trim(), 'pending');
    assert.equal((await run(`SELECT doc->>'status' FROM public.hg_review_tasks WHERE id=${sqlValue(retryTask)}`)).stdout.trim(), 'running');
    assert.equal((await run(`SELECT count(*) FROM public.hg_user_xp_events WHERE user_id=${sqlValue(retryAuthor)}`)).stdout.trim(), '0');
    assert.equal((await run(`SELECT public.hg_finish_review(${sqlValue(retryTask)}, ${sqlValue(retryLease)}, 1, 'approve', '')->>'targetStatus'`)).stdout.trim(), 'published');
    assert.equal((await run(`SELECT total_xp FROM public.hg_user_xp_accounts WHERE user_id=${sqlValue(retryAuthor)}`)).stdout.trim(), '3');
  } finally {
    await run(`
      DELETE FROM public.hg_user_xp_events WHERE user_id IN (${sqlValue(actor)}, ${sqlValue(deleting)}, ${sqlValue(retryAuthor)});
      DELETE FROM public.hg_user_xp_accounts WHERE user_id IN (${sqlValue(actor)}, ${sqlValue(deleting)}, ${sqlValue(retryAuthor)});
      DELETE FROM public.hg_review_tasks WHERE id IN (${sqlValue(deletionTask)}, ${sqlValue(retryTask)});
      DELETE FROM public.hg_reactions WHERE doc->>'userId'=${sqlValue(actor)};
      DELETE FROM public.hg_comments WHERE id LIKE ${sqlValue(`${prefix}-%`)};
      DELETE FROM public.hg_posts WHERE id LIKE ${sqlValue(`${prefix}-%`)};
      DELETE FROM public.hg_memberships WHERE doc->>'userId' IN (${sqlValue(actor)}, ${sqlValue(other)}, ${sqlValue(deleting)}, ${sqlValue(retryAuthor)});
      DELETE FROM public.hg_users WHERE id=${sqlValue(deleting)};
    `).catch(() => {});
  }
});
