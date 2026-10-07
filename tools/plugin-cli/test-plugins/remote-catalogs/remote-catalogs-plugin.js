/* yonto-plugin
{
  "kind": "content-source",
  "id": "remote-catalogs",
  "name": "A source whose library list is elsewhere",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "hostsFromConfig": true,
  "catalogsAreRemote": true,
  "allowedHosts": []
}
*/
// The declaration and the call it is about: an index read from somewhere else, kept in the
// store, and a getSubSources that may have to go and fetch it before it can answer.
export default {
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  async search() { return [{ id: 'm', title: 'M' }]; },
  async getSubSources() {
    const cached = await yonto.store.get('index');
    const index = cached ?? JSON.parse((await yonto.fetch('https://example.com/index.json')).body);
    if (!cached) await yonto.store.set('index', index);
    return { items: index.sites.map((s) => ({ id: s.key, name: s.name })), activeId: yonto.subSource() };
  },
  async getCategories() { return [{ id: 'a', name: 'A' }]; },
};
