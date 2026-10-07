/* yonto-plugin
{
  "kind": "content-source",
  "id": "pages-by-cursor",
  "name": "Pages by cursor",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "pagination": "cursor",
  "allowedHosts": [
    "h.tv"
  ]
}
*/
// A listing that pages by cursor and says so, which is what doctor reads the manifest for
// (kangzj/lantern-tv#331).
export default {
  async getCategories() { return [{ id: 'all', name: 'All' }]; },
  async getMediaList(categoryId, options) {
    return options.cursor === 'two'
      ? { items: [{ id: 'b', title: 'B' }], nextCursor: null }
      : { items: [{ id: 'a', title: 'A' }], nextCursor: 'two' };
  },
  async getMediaDetail() { return { id: 'a', title: 'A', playbackOptions: [{ label: 'x', stream: { url: 'https://h.tv/a.m3u8' } }] }; },
  async search() { return [{ id: 'a', title: 'A' }]; },
};
