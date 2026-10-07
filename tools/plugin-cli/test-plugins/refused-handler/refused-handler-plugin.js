/* yonto-plugin
{
  "kind": "content-source",
  "id": "refused-handler",
  "name": "A handler breaking every rule lint holds handles to",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "hostsFromConfig": true,
  "catalogsAreRemote": true,
  "allowedHosts": [],
  "handles": ["plugin", "maccms-jsn", "maccms-xml"],
  "configSchema": [
    { "id": "api", "label": "API", "type": "text" },
    { "id": "dialect", "label": "Dialect", "type": "choice", "options": [{ "id": "json", "label": "JSON" }] }
  ]
}
*/
export default {
  async getCategories() { return [{ id: 'a', name: 'A' }]; },
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  async search() { return [{ id: 'm', title: 'M' }]; },
  async getSubSources() { return { items: [], activeId: yonto.subSource() }; },
};
