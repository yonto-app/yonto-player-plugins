/* yonto-plugin
{
  "kind": "content-source",
  "id": "repo-typed-host-listed",
  "name": "A manifest listing a repo's typed host",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source-type",
  "description": "A repo's typed host passes the floor only where a value of the repo names it, never because a manifest lists it.",
  "allowedHosts": ["192.168.1.60"],
  "configSchema": [
    { "id": "public", "label": "On the open web", "type": "url" }
  ]
}
*/
// Run as a catalog made from a repo (origin.json) typed on 192.168.1.60, whose only value
// is public. The manifest lists 192.168.1.60, so the allowlist lets a request there through,
// and the floor refuses it: no value of the repo names the typed host, and a manifest's list
// never opens the floor. `repo-on-the-lan/` is the other half, where the manifest lists
// nothing and the typed host is reached only because a repo value names it.
//
// A host that exempted the typed host outright, rather than a repo value on it, reaches
// 192.168.1.60 here.

export default {
  async getCategories() {
    return [
      { id: 'typedHostListedButNotNamed', name: await refusalOf('http://192.168.1.60:9000/ping') },
      { id: 'publicEntry', name: await bodyOf('https://cms.test/ping') },
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
