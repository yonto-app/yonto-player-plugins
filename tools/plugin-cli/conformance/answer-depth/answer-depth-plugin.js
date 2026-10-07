/* yonto-plugin
{
  "kind": "content-source",
  "id": "answer-depth",
  "name": "Answer depth",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source-type",
  "allowedHosts": ["depth.test"]
}
*/
// Not a content source: the plugin `calls.json` is walked through, one runtime for every call.
const nested = (depth) => {
  let value = [];
  for (let i = 1; i < depth; i++) value = [value];
  return value;
};

export default {
  async getCategories() { return [{ id: 'a', name: 'A' }]; },
  async nested(depth) { return nested(depth); },
  async ok() { return 'still here'; },
};
