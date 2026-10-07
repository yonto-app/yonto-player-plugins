/* yonto-plugin
{
  "kind": "content-source",
  "id": "picker",
  "name": "A source that is several",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": []
}
*/
// Both halves of the surface: a list of libraries to offer, and the viewer's pick read back.
// The case `lint`'s pairing rule must stay silent about.
export default {
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  async search() { return [{ id: 'm', title: 'M' }]; },
  async getSubSources() {
    const active = yonto.subSource() ?? 'a';
    return { items: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], activeId: active };
  },
  async getCategories() { return [{ id: 'a', name: 'A' }]; },
};
