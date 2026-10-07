/* yonto-plugin
{
  "kind": "content-source",
  "id": "pointer-login",
  "name": "A pointerLogin, which was a name with nothing behind it",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": ["other.example"],
  "capabilities": [
    { "type": "pointerLogin", "url": "https://other.example/captcha" }
  ]
}
*/
export default {
  async getCategories() { return [{ id: 'c', name: 'C' }]; },
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  async search() { return [{ id: 'm', title: 'M' }]; },
};
