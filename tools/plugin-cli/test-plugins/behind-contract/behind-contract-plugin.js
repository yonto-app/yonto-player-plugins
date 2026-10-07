/* yonto-plugin
{
  "kind": "content-source",
  "id": "behind-contract",
  "name": "Declares a contract no host runs",
  "version": "1.0.0",
  "contractVersion": 20,
  "provides": "source",
  "allowedHosts": [
    "h.tv"
  ]
}
*/
// Says 1 in its manifest and reaches for two things that arrived in 2: a host function an
// older app does not provide, and a method an older app does not know to call. Mentions a
// third in a comment — getRecommendations() — which is prose and must not count.
const RESTED_FOR = 30 * 60 * 1000;

export default {
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  async search() { return [{ id: 'm', title: 'M' }]; },
  getImageHeaders() {
    return { Authorization: 'Bearer x' };
  },

  async getCategories() {
    const until = yonto.now() + RESTED_FOR;
    return [{ id: String(until), name: 'One' }];
  },
};
