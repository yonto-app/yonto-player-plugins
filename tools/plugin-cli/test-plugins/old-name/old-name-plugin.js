/* yonto-plugin
{
  "kind": "content-source",
  "id": "old-name",
  "name": "Old name probe",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": [
    "h.tv"
  ]
}
*/
export default {
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  async names() {
    return { yonto: typeof yonto, lantern: typeof globalThis.lantern };
  },
};
