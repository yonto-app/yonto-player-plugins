/* yonto-plugin
{
  "kind": "content-source",
  "id": "handler",
  "name": "A handler for both MacCMS dialects and somebody else's type",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source-type",
  "allowedHosts": [],
  "handles": ["maccms-json", "maccms-xml", "io.github.someone.alist"],
  "configSchema": [
    { "id": "api", "label": "API", "type": "url", "required": true },
    {
      "id": "dialect",
      "label": "Dialect",
      "type": "choice",
      "default": "json",
      "options": [{ "id": "json", "label": "JSON" }, { "id": "xml", "label": "XML" }]
    },
    { "id": "searchable", "label": "Searchable", "type": "bool", "default": "true" }
  ]
}
*/
export default {
  async getCategories() { return [{ id: 'a', name: 'A' }]; },
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  async search() { return [{ id: 'm', title: 'M' }]; },
};
