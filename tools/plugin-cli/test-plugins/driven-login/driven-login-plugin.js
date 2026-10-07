/* yonto-plugin
{
  "kind": "content-source",
  "id": "driven-login",
  "name": "A login a host drives",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": ["ddys.app"],
  "capabilities": [
    { "type": "cookieLogin", "url": "https://ddys.app", "cookieName": "gate" }
  ]
}
*/
export default {
  async getCategories() { return [{ id: 'c', name: 'C' }]; },
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  async search() { return [{ id: 'm', title: 'M' }]; },
};
