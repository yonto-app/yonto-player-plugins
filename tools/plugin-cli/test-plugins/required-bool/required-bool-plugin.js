/* yonto-plugin
{
  "kind": "content-source",
  "id": "required-bool",
  "name": "Required Bool",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": [
    "h.tv"
  ],
  "configSchema": [
    {
      "id": "subs",
      "label": "Subtitles",
      "type": "bool",
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
    const answer = await yonto.fetch('https://h.tv/list');
    return [{ id: answer.status === 200 ? 'ok' : 'no', name: 'Everything' }];
  },
};
