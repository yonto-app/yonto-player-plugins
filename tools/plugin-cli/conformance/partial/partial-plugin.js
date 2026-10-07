/* yonto-plugin
{
  "kind": "content-source",
  "id": "partial",
  "name": "Partial",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source-type",
  "allowedHosts": []
}
*/
// Not a content source: the plugin `calls.json` is walked through. Each method's first
// argument is one of its calls as JSON: what to hand `yonto.partial`, in order, and whether
// to throw after.
function say(call) {
  const { says, throws } = JSON.parse(call);
  for (const reason of says) yonto.partial(reason);
  if (throws) throw new Error('thrown after saying it');
}

export default {
  async getCategories() { return [{ id: 'a', name: 'A' }]; },
  async getFilters(call) { say(call); return []; },
  async getMediaList(call) { say(call); return [{ id: 'm', title: 'M' }]; },
  async search(call) { say(call); return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail(call) { say(call); return { id: 'm', title: 'M', playbackOptions: [] }; },
};
