/* yonto-plugin
{
  "kind": "content-source",
  "id": "reaches-the-account",
  "name": "Signs in and reaches the account",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": ["*.plex.direct", "*.plex.tv"],
  "capabilities": [{ "type": "linkLogin", "service": "plex.tv" }]
}
*/
export default {
  async getCategories() { return [{ id: 'c', name: 'C' }]; },
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  async search() { return [{ id: 'm', title: 'M' }]; },
};
