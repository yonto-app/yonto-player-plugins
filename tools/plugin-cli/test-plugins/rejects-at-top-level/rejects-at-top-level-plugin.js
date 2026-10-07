/* yonto-plugin
{
  "kind": "content-source",
  "id": "rejects-at-top-level",
  "name": "Rejects at the top level",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": [
    "h.tv"
  ]
}
*/
const READY = await Promise.reject(new Error('the table was not there'));

export default {
  async getCategories() { return [{ id: READY, name: READY }]; },
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  async search() { return [{ id: 'm', title: 'M' }]; },
};
