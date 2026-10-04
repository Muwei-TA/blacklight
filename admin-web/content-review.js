(function registerContentReview() {
  function isRichReviewItem(item) {
    return !!item
      && (item.queue || item.type) === 'content'
      && item.kind === 'article'
      && item.format === 'richtext-v1';
  }

  function contentDetailPayload(item) {
    const version = Number(item && item.version);
    if (!isRichReviewItem(item) || typeof item.id !== 'string' || !item.id
      || item.version === null || item.version === undefined || item.version === ''
      || !Number.isInteger(version) || version < 1) return null;
    return { id: item.id, expectedVersion: version };
  }

  function isCurrentRichReviewDetail(item, detail) {
    if (!isRichReviewItem(item) || !detail || typeof detail !== 'object') return false;
    return !!(detail.id === item.id
      && Number(detail.version) === Number(item.version)
      && detail.format === 'richtext-v1'
      && typeof detail.title === 'string' && detail.title.length > 0
      && typeof detail.summary === 'string'
      && ['club', 'public'].includes(detail.visibility)
      && Array.isArray(detail.assets) && Array.isArray(detail.assetIds)
      && detail.richDoc && detail.richDoc.type === 'doc' && Array.isArray(detail.richDoc.content));
  }

  const api = { isRichReviewItem, contentDetailPayload, isCurrentRichReviewDetail };
  globalThis.AdminContentReview = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}());
