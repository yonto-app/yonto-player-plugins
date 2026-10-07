/* yonto-plugin
{
  "kind": "content-source",
  "id": "repo-redirected",
  "name": "A repo whose fetch was redirected",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source-type",
  "description": "Where a repo's fetch was redirected to is never the host the viewer typed.",
  "allowedHosts": [],
  "configSchema": [
    { "id": "whereTheFetchLanded", "label": "Where the repo's fetch landed", "type": "url" },
    { "id": "public", "label": "On the open web", "type": "url" }
  ]
}
*/
// Run as a catalog made from a repo (origin.json) whose address the viewer typed on the open
// web, `https://gist.test/u/index.json`, and whose fetch was redirected to 192.168.1.62. The
// typed host is the literal one, before redirects, so the repo exempts nothing here: a host
// that exempted where the fetch landed would reach 192.168.1.62.

export default {
  async getCategories() {
    return [
      { id: 'entryWhereTheFetchLanded', name: await refusalOf('http://192.168.1.62/ping') },
      { id: 'publicEntry', name: await bodyOf('https://raw.test/ping') },
    ];
  },

  async raiseHandBuiltNotFound() {
    throw { code: 'NOT_FOUND', message: 'hand-built, not yonto.error.notFound()' };
  },
};

async function refusalOf(url) {
  return yonto.fetch(url).then(
    (response) => `fetched ${response.status}`,
    (error) => `${error.code}: ${error.message}`,
  );
}

async function bodyOf(url) {
  return yonto.fetch(url).then((response) => response.body, (error) => `threw ${error.code}`);
}
