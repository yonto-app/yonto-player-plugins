/* yonto-plugin
{
  "kind": "content-source",
  "id": "module-throws",
  "name": "Throws while loading",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": [
    "h.tv"
  ]
}
*/
// The failure 爱影视 shipped once: real work at module scope, reaching for something the
// realm does not have. It has to be reported as the plugin's throw, not as a bare V8
// error escaping to the CLI's top level.
const ORIGIN = new URL('https://h.tv').origin;

export default {
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  async search() { return [{ id: 'm', title: 'M' }]; },
  async getCategories() {
    return [{ id: ORIGIN, name: ORIGIN }];
  },
};
