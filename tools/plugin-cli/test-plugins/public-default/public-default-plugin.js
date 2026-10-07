/* yonto-plugin
{
  "kind": "content-source",
  "id": "public-default",
  "name": "Public default",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source-type",
  "allowedHosts": [],
  "hostsFromConfig": true,
  "configSchema": [
    {
      "id": "serverUrl",
      "label": "Server",
      "type": "url",
      "default": "https://demo.example.com:8443/api"
    }
  ]
}
*/
// A `url` default that names a public host. The point of the fixture is that the lint scan
// reads the field at all: its manifest can name a host nowhere else.
export default {
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  async search() { return [{ id: 'm', title: 'M' }]; },
  async getCategories() { return [{ id: 'a', name: 'A' }]; },
};
