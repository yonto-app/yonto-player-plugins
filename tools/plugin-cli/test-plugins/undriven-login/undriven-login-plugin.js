/* yonto-plugin
{
  "kind": "content-source",
  "id": "undriven-login",
  "name": "A login no host drives",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": ["other.example"],
  "capabilities": [
    { "type": "cookieLogin", "url": "https://other.example/login", "cookieName": "gate" }
  ]
}
*/
export default {
  async getCategories() { return [{ id: 'c', name: 'C' }]; },
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  async search() { return [{ id: 'm', title: 'M' }]; },
};
