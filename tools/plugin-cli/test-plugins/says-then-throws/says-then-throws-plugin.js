/* yonto-plugin
{
  "kind": "content-source",
  "id": "says-then-throws",
  "name": "Says something, then throws while loading",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": [
    "h.tv"
  ]
}
*/
// The XPTV shape: the module body does real work, says what it found, and then dies. The
// lines it wrote on the way down are the only description of the cause, so a report that
// drops them leaves an author with a throw and no account of it.
yonto.log('info', 'index names 81 catalogs, 0 readable');
yonto.log('error', 'the index answered 520');
throw new Error('no catalog survived the index');

export default {
  async getCategories() { return [{ id: 'c', name: 'C' }]; },
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  async search() { return [{ id: 'm', title: 'M' }]; },
};
