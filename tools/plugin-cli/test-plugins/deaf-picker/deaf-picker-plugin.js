/* yonto-plugin
{
  "kind": "content-source",
  "id": "deaf-picker",
  "name": "A picker nothing reads",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": []
}
*/
// Offers a viewer a choice and never reads it back, so the library is the same whichever
// one they pick. A switch that appears to work and changes nothing, which is what the
// pairing rule in `lint` exists to refuse.
export default {
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  async search() { return [{ id: 'm', title: 'M' }]; },
  async getSubSources() { return { items: [{ id: 'a', name: 'A' }], activeId: 'a' }; },
  async getCategories() { return [{ id: 'a', name: 'A' }]; },
};
