/* yonto-plugin
{
  "kind": "content-source",
  "id": "says-while-reading",
  "name": "Says something while it reads a title",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": []
}
*/
export default {
  async getCategories() { return [{ id: 'c', name: 'C' }]; },
  async getMediaList(categoryId, { page }) { return page === 1 ? [{ id: 'm', title: 'M' }] : []; },
  async getMediaDetail(id) {
    yonto.log('info', `title ${id}: 1 tracks, 0 of them a share`);
    return { id, title: 'M', playbackOptions: [{ label: 'Watch', stream: { url: 'https://example.com/m.mp4' } }] };
  },
  async search() { return [{ id: 'm', title: 'M' }]; },
};
