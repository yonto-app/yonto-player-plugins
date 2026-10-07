/* yonto-plugin
{
  "kind": "content-source",
  "id": "cang-signs",
  "name": "A 仓 that asks to sign",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source-type",
  "hostsFromConfig": true,
  "allowedHosts": [],
  "configSchema": [
    {
      "id": "configUrl",
      "label": "配置地址",
      "type": "url"
    }
  ]
}
*/
// A plugin whose hosts come from its own config, asking for artwork headers it cannot have:
// there is no allowlist to send them to. `lint` is the only place an author hears so.
export default {
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  async search() { return [{ id: 'm', title: 'M' }]; },
  async getCategories() { return [{ id: 'a', name: 'A' }]; },
  async getImageHeaders() { return { Authorization: 'Bearer whatever' }; },
};
