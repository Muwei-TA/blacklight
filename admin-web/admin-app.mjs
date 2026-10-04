(async function bootAdminModules() {
  const [, , , richDoc] = await Promise.all([
    import('./core.js'),
    import('./api.js'),
    import('./content-review.js'),
    import('../web/rich-doc.mjs'),
  ]);
  globalThis.AdminRichDoc = {
    authorizedMediaUrl: richDoc.authorizedMediaUrl,
    renderRichDoc: richDoc.renderRichDoc,
  };
  await import('./app.js');
}());
