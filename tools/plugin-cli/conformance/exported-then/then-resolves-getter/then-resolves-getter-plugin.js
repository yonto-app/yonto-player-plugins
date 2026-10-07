/* yonto-plugin
{
  "kind": "content-source",
  "id": "then-resolves-getter",
  "name": "Exported then: then-resolves-getter",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source-type",
  "allowedHosts": []
}
*/
// Not a content source: a case of ../calls.json. A `then` that hands back an object whose `default` getter never returns.
export function then(resolve) { resolve({ get default() { for (;;) { /* never returns */ } } }); }

export default {
  async fine() { return 'fine'; },
};
