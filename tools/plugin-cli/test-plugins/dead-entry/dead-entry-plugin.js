/* yonto-plugin
{
  "kind": "content-source",
  "id": "dead-entry",
  "name": "Dead Entry",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": [
    "h.tv",
    "999.999.999.999",
    "example.123",
    "08",
    "*.1.2.3.4.5",
    "*.1.1"
  ]
}
*/
// `lint` never runs a plugin — it parses the entry file and reads the manifest — so this
// fixture is about its allowedHosts and needs no behaviour at all.
export default {
  async getCategories() { return [{ id: 'c', name: 'C' }]; },
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  async search() { return [{ id: 'm', title: 'M' }]; },
};
