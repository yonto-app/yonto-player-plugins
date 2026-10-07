/* yonto-plugin
{
  "kind": "content-source",
  "id": "then-loops",
  "name": "Exported then: then-loops",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source-type",
  "allowedHosts": []
}
*/
// Not a content source: a case of ../calls.json. A `then` that never returns, which settling the namespace would call.
export function then() { for (;;) { /* never returns */ } }

export default {
  async fine() { return 'fine'; },
};
