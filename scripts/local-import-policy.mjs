export function assertPublicTableInventory(actualTables, expectedTables) {
  const actual = [...actualTables].sort();
  const expected = [...expectedTables].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('target public table inventory does not match this checkout');
  }
}

export function assertTargetRowsEmpty(rows, { seededConfig = false, replaceSeed = false } = {}) {
  if (seededConfig && !replaceSeed) {
    throw new Error('target has the local club seed; pass --replace-local-club-seed after confirming it is disposable');
  }
  for (const [name, count] of rows) {
    if (name === 'hg_club_config' && seededConfig && replaceSeed) continue;
    if (count !== 0) throw new Error(`target table is not empty: ${name}`);
  }
}
