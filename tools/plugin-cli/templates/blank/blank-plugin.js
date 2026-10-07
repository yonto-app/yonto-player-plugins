/* yonto-plugin
{
  "kind": "content-source",
  "id": "blank",
  "name": "Blank",
  "version": "1.0.0",
  "contractVersion": 21,
  "description": "A starting point: one made-up title, and no network.",
  "provides": "source",
  "allowedHosts": []
}
*/
const TITLES = [
  { id: 'demo', title: 'A made-up title', type: 'movie', year: '2025' },
];

export default {
  async getCategories() {
    return [{ id: 'all', name: 'All' }];
  },

  async getMediaList(categoryId, { page }) {
    return page === 1 ? TITLES : [];
  },

  async getMediaDetail(id) {
    const title = TITLES.find((candidate) => candidate.id === id);
    if (!title) throw yonto.error.notFound(`no title ${id}`);
    return {
      ...title,
      synopsis: 'Replace this with what the site says.',
      playbackOptions: [{ label: 'Watch', stream: { url: 'https://example.com/demo.mp4' } }],
    };
  },

  async search(query) {
    return TITLES.filter((title) => title.title.toLowerCase().includes(query.toLowerCase()));
  },
};
