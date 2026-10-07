/* yonto-plugin
{
  "kind": "content-source",
  "id": "session-without-link-login",
  "name": "Reads a session it has no login for",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": ["site.example"]
}
*/
export default {
  async getCategories() { return yonto.session.linked() ? [{ id: 'c', name: 'C' }] : []; },
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  async search() { return [{ id: 'm', title: 'M' }]; },
};
