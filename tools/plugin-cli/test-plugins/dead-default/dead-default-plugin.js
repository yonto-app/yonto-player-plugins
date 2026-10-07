/* yonto-plugin
{
  "kind": "content-source",
  "id": "dead-default",
  "name": "Dead Default",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": [],
  "configSchema": [
    {
      "id": "siteUrl",
      "label": "Site URL",
      "type": "url",
      "required": true,
      "default": "example.123"
    },
    {
      "id": "mirrorUrl",
      "label": "Mirror",
      "type": "url",
      "default": "https://mirror.example.com"
    }
  ]
}
*/
// `lint` never runs a plugin, so this fixture is about its manifest alone.
export default {
  async getCategories() { return [{ id: 'c', name: 'C' }]; },
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  async search() { return [{ id: 'm', title: 'M' }]; },
};
