/* yonto-plugin
{
  "kind": "content-source",
  "id": "browser-check",
  "name": "A site behind a browser check",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": ["site.example"],
  "capabilities": [
    { "type": "browserCheck", "url": "https://site.example/" }
  ]
}
*/
export default {
  async getCategories() { return [{ id: 'c', name: 'C' }]; },
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  async search() { return [{ id: 'm', title: 'M' }]; },
};
