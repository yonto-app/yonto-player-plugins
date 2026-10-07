/* yonto-plugin
{
  "kind": "content-source",
  "id": "blind-picker",
  "name": "A picker read through a local name",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": []
}
*/
// Exports the picker and reaches the host in a shape no name can be read out of, so the
// scan cannot tell whether the pick is read. Refusing this one would refuse a plugin that
// works, so it is warned about instead.
const host = yonto;
export default {
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  async search() { return [{ id: 'm', title: 'M' }]; },
  async getSubSources() { return { items: [{ id: 'a', name: 'A' }], activeId: host.subSource() ?? 'a' }; },
  async getCategories() { return [{ id: 'a', name: 'A' }]; },
};
