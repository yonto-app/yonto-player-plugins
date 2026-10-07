/* yonto-plugin
{
  "kind": "content-source",
  "id": "half-a-plugin",
  "name": "Exports one of the four",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": [
    "h.tv"
  ]
}
*/
export default {
  async getCategories() {
    return [{ id: 'c', name: 'C' }];
  },
};
