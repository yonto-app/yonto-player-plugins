/* yonto-plugin
{
  "kind": "content-source",
  "id": "raised",
  "name": "Raised",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source-type",
  "allowedHosts": ["loop.test", "silent.test", "large.test"]
}
*/
// Not a content source: the plugin `raised.json` is walked through. `raise`'s argument is one
// case's `call` as JSON: a fetch or a store write to let through uncaught, or a fetch to make and set aside
// first, then either a value to throw as it is or a `yonto.error` constructor to call and
// throw.
export default {
  async getCategories() { return [{ id: 'a', name: 'A' }]; },
  async raise(call) {
    const { fetch, storeKeyOf, fetchFirst, handBuilt, raise, with: args = [] } = JSON.parse(call);
    if (fetch !== undefined) await yonto.fetch(fetch);
    if (storeKeyOf !== undefined) await yonto.store.set('k'.repeat(storeKeyOf), 1);
    if (fetchFirst) {
      try {
        await yonto.fetch(fetchFirst);
      } catch {
        // Set aside, as a plugin that goes on to give its own verdict does.
      }
    }
    if (handBuilt) throw handBuilt;
    throw yonto.error[raise](...args);
  },
};
