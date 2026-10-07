/* yonto-plugin
{
  "kind": "content-source",
  "id": "claims-a-source",
  "name": "Claims A Source",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": [
    "h.tv"
  ],
  "configSchema": [
    {
      "id": "siteUrl",
      "label": "Site URL",
      "type": "url",
      "required": true
    }
  ]
}
*/
export default {
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  async search() { return [{ id: 'm', title: 'M' }]; },
  async getCategories() {
    const answer = await yonto.fetch(`${yonto.config.siteUrl}/list`);
    return [{ id: answer.status === 200 ? 'ok' : 'no', name: 'Everything' }];
  },
};
