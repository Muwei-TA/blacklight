import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';

const { Pool } = pg;
const databaseUrl = process.env.PG_TEST_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== '/blacklight_test' || process.env.HG_TEST_DATABASE_RESET !== 'yes') {
  throw new Error('Use an isolated blacklight_test database and HG_TEST_DATABASE_RESET=yes; never run on application data.');
}

test('image intent locks preserve per-club and per-owner upload quotas under concurrent requests', async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 8, application_name: 'usage-quotas-concurrency-test' });
  const prefix = `usage-concurrency-${process.pid}`;
  const clubId = `${prefix}-club`;
  const ownerClubId = `${prefix}-owner-club`;
  const clubOwners = Array.from({ length: 4 }, (_, index) => `${prefix}-club-owner-${index + 1}`);
  const singleOwner = `${prefix}-single-owner`;
  const owners = [...clubOwners, singleOwner];
  const clubs = [clubId, ownerClubId];
  const quotaError = (error) => error && error.code === 'P0001' && error.message === 'IMAGE_QUOTA';

  async function intent(targetClub, owner, assetId, key, quotaBytes) {
    const client = await pool.connect();
    const now = new Date();
    const asset = {
      _id: assetId,
      clubId: targetClub,
      ownerId: owner,
      postId: '',
      mediaType: 'image',
      declaredSize: 100,
      quotaBytes,
      mimeType: 'image/png',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
      status: 'intent',
    };
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE service_role');
      const result = await client.query(
        'SELECT public.hg_image_intent($1, $2, $3, $4::jsonb) AS result',
        [owner, targetClub, key, JSON.stringify(asset)],
      );
      await client.query('COMMIT');
      return { result: result.rows[0].result, error: null };
    } catch (error) {
      await client.query('ROLLBACK');
      return { result: null, error };
    } finally {
      client.release();
    }
  }

  try {
    const setup = await pool.connect();
    try {
      await setup.query('BEGIN');
      for (const [id, userUploadDailyBytes, clubUploadDailyBytes] of [
        [clubId, 20 * 1024 * 1024, 4 * 1024 * 1024],
        [ownerClubId, 1 * 1024 * 1024, 100 * 1024 * 1024],
      ]) {
        await setup.query('INSERT INTO public.hg_club_config(id, doc) VALUES ($1, $2::jsonb)', [id, JSON.stringify({
          _id: id,
          status: 'active',
          discoverable: false,
          usageLimits: { userUploadDailyBytes, clubUploadDailyBytes, reviewDailyCalls: 100, warningRatio: 0.8 },
        })]);
      }
      for (const [owner, targetClub] of [...clubOwners.map((item) => [item, clubId]), [singleOwner, ownerClubId]]) {
        await setup.query('INSERT INTO public.hg_users(id, doc) VALUES ($1, $2::jsonb)', [owner, JSON.stringify({ _id: owner, status: 'active' })]);
        const membershipId = `${owner}:${targetClub}`;
        await setup.query('INSERT INTO public.hg_memberships(id, doc) VALUES ($1, $2::jsonb)', [membershipId, JSON.stringify({
          _id: membershipId, userId: owner, clubId: targetClub, status: 'active', role: 'member',
        })]);
      }
      await setup.query('COMMIT');
    } catch (error) {
      await setup.query('ROLLBACK');
      throw error;
    } finally {
      setup.release();
    }

    const clubResults = await Promise.all(clubOwners.map((owner, index) => intent(
      clubId, owner, `${prefix}-club-asset-${index + 1}`, `${prefix}-club-key-${index + 1}`, 2 * 1024 * 1024,
    )));
    assert.equal(clubResults.filter((item) => !item.error).length, 2);
    assert.equal(clubResults.filter((item) => quotaError(item.error)).length, 2);
    assert.ok(clubResults.every((item) => !item.error || quotaError(item.error)));

    const ownerResults = await Promise.all(Array.from({ length: 4 }, (_, index) => intent(
      ownerClubId, singleOwner, `${prefix}-owner-asset-${index + 1}`, `${prefix}-owner-key-${index + 1}`, 512 * 1024,
    )));
    assert.equal(ownerResults.filter((item) => !item.error).length, 2);
    assert.equal(ownerResults.filter((item) => quotaError(item.error)).length, 2);
    assert.ok(ownerResults.every((item) => !item.error || quotaError(item.error)));

    const usage = await pool.query(`SELECT club_id, upload_reserved_bytes FROM public.hg_daily_usage
      WHERE club_id=ANY($1::text[]) ORDER BY club_id`, [clubs]);
    assert.deepEqual(usage.rows.map((row) => [row.club_id, Number(row.upload_reserved_bytes)]), [
      [clubId, 4 * 1024 * 1024],
      [ownerClubId, 1024 * 1024],
    ]);
    const assetCounts = await pool.query(`SELECT doc->>'clubId' AS club_id, count(*)::int AS total
      FROM public.hg_assets WHERE doc->>'clubId'=ANY($1::text[]) GROUP BY doc->>'clubId' ORDER BY doc->>'clubId'`, [clubs]);
    assert.deepEqual(assetCounts.rows.map((row) => [row.club_id, row.total]), [[clubId, 2], [ownerClubId, 2]]);
  } finally {
    await pool.query('DELETE FROM public.hg_daily_usage WHERE club_id=ANY($1::text[])', [clubs]);
    await pool.query("DELETE FROM public.hg_idempotency WHERE doc->>'clubId'=ANY($1::text[])", [clubs]);
    await pool.query("DELETE FROM public.hg_assets WHERE doc->>'clubId'=ANY($1::text[])", [clubs]);
    await pool.query("DELETE FROM public.hg_memberships WHERE doc->>'clubId'=ANY($1::text[])", [clubs]);
    await pool.query('DELETE FROM public.hg_users WHERE id=ANY($1::text[])', [owners]);
    await pool.query('DELETE FROM public.hg_club_config WHERE id=ANY($1::text[])', [clubs]);
    await pool.end();
  }
});
