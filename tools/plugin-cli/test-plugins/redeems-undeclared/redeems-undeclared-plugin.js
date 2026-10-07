/* yonto-plugin
{
  "kind": "content-source",
  "id": "redeems-undeclared",
  "name": "A source whose options are not URLs yet",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": ["example.com"]
}
*/
// The export without the declaration. A `track` option is the only thing that could ever
// call getStream, so a manifest that does not admit it is a manifest lint refuses.
export default {
  async getCategories() { return [{ id: 'a', name: 'A' }]; },
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() {
    return { id: 'm', title: 'M', playbackOptions: [{ label: '第1集', track: 'ep-1' }] };
  },
  async search() { return [{ id: 'm', title: 'M' }]; },
  async getStream(token) { return { url: `https://example.com/${token}.mp4`, mimeType: 'video/mp4' }; },
};
