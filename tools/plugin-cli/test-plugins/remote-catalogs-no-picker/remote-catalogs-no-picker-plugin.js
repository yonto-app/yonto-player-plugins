/* yonto-plugin
{
  "kind": "content-source",
  "id": "remote-catalogs-no-picker",
  "name": "A declaration about a call that is not there",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "catalogsAreRemote": true,
  "allowedHosts": []
}
*/
// catalogsAreRemote with no getSubSources: a wait bought for a picker that never opens.
export default {
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  async search() { return [{ id: 'm', title: 'M' }]; },
  async getCategories() { return [{ id: 'a', name: 'A' }]; },
};
