/* yonto-plugin
{
  "kind": "content-source",
  "id": "beyond-contract",
  "name": "Declares a contract no host speaks",
  "version": "1.0.0",
  "contractVersion": 99,
  "provides": "source",
  "allowedHosts": [
    "h.tv"
  ]
}
*/
// Uses nothing that arrived after the first contract and declares a version no host has
// ever shipped, which installs nowhere — the refusal it earns should arrive here and not
// on a television.
export default {
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  async search() { return [{ id: 'm', title: 'M' }]; },
  async getCategories() {
    return [{ id: 'a', name: 'A' }];
  },
};
