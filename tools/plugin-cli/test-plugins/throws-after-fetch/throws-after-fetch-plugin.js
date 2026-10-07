/* yonto-plugin
{
  "kind": "content-source",
  "id": "throws-after-fetch",
  "name": "throws-after-fetch",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": [
    "h.tv"
  ]
}
*/
// A module body that starts a host call and then gives up, leaving the call in flight.
// Disposing the runtime while one is outstanding makes QuickJS abort rather than free,
// and what the author needs to read is this throw, not that.
yonto.fetch('https://h.tv/x');

throw new Error('module body gave up');

// eslint-disable-next-line no-unreachable
export default {
  async getCategories() { return [{ id: 'c', name: 'C' }]; },
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  async search() { return [{ id: 'm', title: 'M' }]; },
};
