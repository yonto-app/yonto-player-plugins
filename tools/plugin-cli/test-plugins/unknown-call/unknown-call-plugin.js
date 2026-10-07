/* yonto-plugin
{
  "kind": "content-source",
  "id": "unknown-call",
  "name": "Calls something no host has",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": [
    "h.tv"
  ]
}
*/
// A typo and a host function from the future look identical from here, so neither is
// counted as version 1 — both are named, and the author decides which one it was.
export default {
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  async search() { return [{ id: 'm', title: 'M' }]; },
  async getCategories() {
    return [{ id: String(yonto.teleport()), name: 'One' }];
  },
};
