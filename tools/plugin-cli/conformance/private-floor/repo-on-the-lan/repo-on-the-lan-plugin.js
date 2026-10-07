/* yonto-plugin
{
  "kind": "content-source",
  "id": "repo-on-the-lan",
  "name": "A repo on the viewer's own network",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source-type",
  "description": "A catalog made from a repo the viewer typed on a private host reaches that host, and no other private one.",
  "allowedHosts": [],
  "configSchema": [
    { "id": "onTypedHost", "label": "On the repo's host", "type": "url" },
    { "id": "onAnotherHost", "label": "On another private host", "type": "url" },
    { "id": "typedByViewer", "label": "Your box", "type": "url" },
    { "id": "public", "label": "On the open web", "type": "url" }
  ]
}
*/
// Run as a catalog made from a repo (origin.json): the viewer typed the repo's address as
// `http://0xc0a8013c:8080/index.json`, which is 192.168.1.60, and typed `typedByViewer`
// themselves. Every other value is the repo's word — see contracts/content-source-http.md's
// "The private-address floor".
//
// A host that exempted every value the repo named would reach 192.168.1.61; one that
// exempted none would refuse the repo's own server; one that compared the typed address as
// a string rather than as a host would refuse it too, since nothing names it `0xc0a8013c`.

export default {
  async getCategories() {
    return [
      // Another port on the typed host: the exemption is the host, on any port.
      { id: 'entryOnTypedHost', name: await bodyOf('http://192.168.1.60:9000/ping') },
      { id: 'entryOnAnotherHost', name: await refusalOf('http://192.168.1.61/ping') },
      { id: 'redirectOffTypedHost', name: await refusalOf('http://192.168.1.60:9000/moved') },
      { id: 'viewerTyped', name: await bodyOf('http://192.168.1.50:8096/ping') },
      { id: 'publicEntry', name: await bodyOf('https://cms.test/ping') },
      // What a repo's value widens the allowlist to is its host exactly, and nothing else.
      { id: 'nobodyNamedIt', name: await refusalOf('https://elsewhere.test/ping') },
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
