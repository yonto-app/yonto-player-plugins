/* yonto-plugin
{
  "kind": "content-source",
  "id": "spinning-lookup",
  "name": "spinning-lookup",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": [
    "h.tv"
  ]
}
*/
// Reading a method is plugin code when the plugin says so, and there is nothing above a
// getter to stop it.
export default {
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  async search() { return [{ id: 'm', title: 'M' }]; },
  get getCategories() {
    while (true) { /* until the interrupt handler says otherwise */ }
  },
};
