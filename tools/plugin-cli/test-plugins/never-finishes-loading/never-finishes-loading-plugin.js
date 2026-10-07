/* yonto-plugin
{
  "kind": "content-source",
  "id": "never-finishes-loading",
  "name": "Never finishes loading",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": [
    "h.tv"
  ]
}
*/
const READY = await new Promise(() => {});

export default {
  async getCategories() { return [{ id: READY, name: READY }]; },
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  async search() { return [{ id: 'm', title: 'M' }]; },
};
