/* yonto-plugin
{
  "kind": "content-source",
  "id": "lan-host",
  "name": "Reaches the LAN",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source-type",
  "hostsFromConfig": true,
  "allowedHosts": [],
  "configSchema": [
    {
      "id": "configUrl",
      "label": "仓 address",
      "type": "url",
      "default": "http://192.168.1.1/config.json"
    }
  ]
}
*/
// A manifest that names the viewer's own network without a viewer naming it: `allowedHosts`
// is empty because `hostsFromConfig` forces it to be, and the address arrives as a `url`
// field's default, which the editor seeds the form with. Only here to be linted.
export default {
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  async search() { return [{ id: 'm', title: 'M' }]; },
  async getCategories() { return [{ id: 'a', name: 'A' }]; },
};
