/* yonto-plugin
{
  "kind": "content-source",
  "id": "stale-choice",
  "name": "Stale Choice",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": [
    "h.tv"
  ],
  "configSchema": [
    {
      "id": "quality",
      "label": "Quality",
      "type": "choice",
      "default": "hd",
      "options": [
        { "id": "HD", "label": "HD" },
        { "id": "SD", "label": "SD" }
      ]
    },
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
    // What the two hosts have to agree on: a default naming no option is blanked, and an
    // untouched bool is the string 'false'.
    return [
      { id: `quality:${JSON.stringify(yonto.config.quality)}`, name: 'Quality' },
      { id: `subs:${JSON.stringify(yonto.config.subs)}`, name: 'Subs' },
    ];
  },
};
