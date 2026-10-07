/* yonto-plugin
{
  "kind": "content-source",
  "id": "redeems-tokens",
  "name": "A source whose options are not URLs yet",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "playbackTokens": true,
  "allowedHosts": ["example.com"]
}
*/
// The declaration and the export it is about: a detail that answers a token instead of a
// URL, and the getStream that turns one back into a stream when the viewer presses play.
export default {
  async getCategories() { return [{ id: 'a', name: 'A' }]; },
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() {
    return { id: 'm', title: 'M', playbackOptions: [{ label: '第1集', track: 'ep-1' }] };
  },
  async search() { return [{ id: 'm', title: 'M' }]; },
  async getStream(token) { return { url: `https://example.com/${token}.mp4`, mimeType: 'video/mp4' }; },
};
