/* yonto-plugin
{
  "kind": "content-source",
  "id": "bad-default",
  "name": "bad-default",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": [
    "h.tv"
  ]
}
*/
// Not an object. Both hosts have to call this MISSING_EXPORT rather than answering that
// the plugin exports no methods.
export default 42;
