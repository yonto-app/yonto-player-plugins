/* yonto-plugin
{
  "kind": "content-source",
  "id": "not-index",
  "name": "Not index",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": [
    "h.tv"
  ]
}
*/
export default {
  async getCategories() {
    const res = await yonto.fetch('https://h.tv/categories');
    return JSON.parse(res.body);
  },
  async getMediaList(categoryId, { page }) {
    return [{ id: `${categoryId}-${page}`, title: 'A title' }];
  },
  async getMediaDetail(id) {
    if (id === '404') throw yonto.error.notFound(id);
    if (id === 'boom') throw new Error('boom');
    if (id === 'weird') throw Object.assign(new Error('x'), { code: 'TOTALLY_MADE_UP' });
    throw new Error('no such title');
  },
  async search() {
    // Long enough to outlive the 50 ms timeout the test sets, short enough not to hold
    // the test process open once it has. yonto.sleep, not setTimeout: a television has
    // no timers, and the realm the engine runs this in has none either.
    await yonto.sleep(500);
    return [];
  },
};
