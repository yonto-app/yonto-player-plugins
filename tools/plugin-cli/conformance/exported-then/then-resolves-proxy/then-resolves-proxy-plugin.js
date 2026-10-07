/* yonto-plugin
{
  "kind": "content-source",
  "id": "then-resolves-proxy",
  "name": "Exported then: then-resolves-proxy",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source-type",
  "allowedHosts": []
}
*/
// Not a content source: a case of ../calls.json. A `then` that hands back a Proxy whose every read never returns.
export function then(resolve) { resolve(new Proxy({}, { get() { for (;;) { /* never returns */ } } })); }

export default {
  async fine() { return 'fine'; },
};
