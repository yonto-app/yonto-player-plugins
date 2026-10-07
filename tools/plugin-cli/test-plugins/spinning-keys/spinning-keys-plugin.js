/* yonto-plugin
{
  "kind": "content-source",
  "id": "spinning-keys",
  "name": "spinning-keys",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": [
    "h.tv"
  ]
}
*/
// Listing what a plugin exports is plugin code when the plugin is a Proxy.
export default new Proxy({}, {
  ownKeys() {
    while (true) { /* until the interrupt handler says otherwise */ }
  },
});
