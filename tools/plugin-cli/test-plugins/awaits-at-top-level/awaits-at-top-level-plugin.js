/* yonto-plugin
{
  "kind": "content-source",
  "id": "awaits-at-top-level",
  "name": "Awaits at the top level",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": [
    "h.tv"
  ]
}
*/
// Allowed on both hosts (kangzj/lantern-tv#457). What it awaits is its own: a module body
// still must not call the host.
const READY = await Promise.resolve('ready');

export default {
  async getCategories() { return [{ id: READY, name: READY }]; },
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  async search() { return [{ id: 'm', title: 'M' }]; },
};
