/* yonto-plugin
{
  "kind": "content-source",
  "id": "taken-apart",
  "name": "Reaches the host through a pattern",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": [
    "h.tv"
  ]
}
*/
// Takes the clock out of the namespace before calling it, which is legal, reasonable, and
// unreadable to a scan that matches `yonto.<name>`. Declaring 1 is what this plugin gets
// away with today; the warning is what stops it being silent.
export default {
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  async search() { return [{ id: 'm', title: 'M' }]; },
  async getCategories() {
    const { now } = yonto;
    return [{ id: String(now()), name: 'One' }];
  },
};
