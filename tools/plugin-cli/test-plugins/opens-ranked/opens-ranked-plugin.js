/* yonto-plugin
{
  "kind": "content-source",
  "id": "opens-ranked",
  "name": "A listing already ranked by plays",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": [
    "h.tv"
  ]
}
*/
// Its listing is already ranked by plays, and its sort group says so with `init`. Nothing
// in this source shows lint that it answers with one, which is why 13 is not "too high".
export default {
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  async search() { return [{ id: 'm', title: 'M' }]; },
  async getCategories() {
    return [{ id: 'a', name: 'A' }];
  },
  async getFilters() {
    return [{ id: 'sort', name: '排序', options: [{ id: 'new', name: '最新' }, { id: 'hot', name: '最热' }], init: 'hot' }];
  },
};
