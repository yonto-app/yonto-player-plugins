/* yonto-plugin
{
  "kind": "content-source",
  "id": "resolved-name",
  "name": "A name that resolves into the viewer's network",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source-type",
  "description": "A name is reached wherever it resolves; only a private address written as one is refused.",
  "hostsFromConfig": true,
  "allowedHosts": [],
  "configSchema": [
    { "id": "typedUrl", "label": "Your box", "type": "url" },
    { "id": "repoValue", "label": "The repo's server", "type": "url" },
    { "id": "repoCgnat", "label": "The repo's Tailscale box", "type": "url" }
  ]
}
*/
// Run as a catalog made from a repo (origin.json): the viewer typed `typedUrl`, and the other
// values are the repo's word. The plugin reads its hosts from its config, so it has no
// allowlist to be checked against. Each name below resolved into the viewer's network when it
// was recorded, and is reached anyway: only the host as written is under the private-address
// floor, on every platform (Jasper, 2026-09-26; see contracts/content-source-http.md's
// "The private-address floor"). The literals are still refused, the IPv4-in-IPv6 spellings
// included, which is the half iOS and Android both keep.

export default {
  async getCategories() {
    return [
      { id: 'lanName', name: await refusalOf('https://lan-name.test/ping') },
      { id: 'cgnatName', name: await refusalOf('https://cgnat-name.test/ping') },
      { id: 'loopbackV6Name', name: await refusalOf('https://v6-loop.test/ping') },
      { id: 'uniqueLocalName', name: await refusalOf('https://v6-ula.test/ping') },
      { id: 'linkLocalName', name: await refusalOf('https://v6-link.test/ping') },
      { id: 'mappedName', name: await refusalOf('https://v6-mapped.test/ping') },
      { id: 'publicV6Name', name: await refusalOf('https://v6-public.test/ping') },
      { id: 'nat64Name', name: await refusalOf('https://nat64-name.test/ping') },
      { id: 'sixToFourName', name: await refusalOf('https://sixtofour-name.test/ping') },
      { id: 'teredoName', name: await refusalOf('https://teredo-name.test/ping') },
      { id: 'nat64PublicName', name: await refusalOf('https://nat64-public.test/ping') },
      { id: 'nat64Literal', name: await refusalOf('http://[64:ff9b::7f00:1]/ping') },
      { id: 'sixToFourLiteral', name: await refusalOf('http://[2002:c0a8:146::]/ping') },
      { id: 'siitName', name: await refusalOf('https://siit-name.test/ping') },
      { id: 'siitLiteral', name: await refusalOf('http://[::ffff:0:c0a8:146]/ping') },
      { id: 'typedName', name: await refusalOf('https://typed-name.test/ping') },
      { id: 'repoName', name: await refusalOf('https://repo-name.test/ping') },
      { id: 'repoCgnatName', name: await refusalOf('https://repo-cgnat.test/ping') },
      { id: 'redirectToLanName', name: await refusalOf('https://typed-name.test/moved') },
      { id: 'publicName', name: await refusalOf('https://public-name.test/ping') },
      { id: 'cgnatLiteral', name: await refusalOf('http://100.64.0.1/ping') },
      { id: 'benchmarkingName', name: await refusalOf('https://bench-name.test/ping') },
      { id: 'benchmarkingLiteral', name: await refusalOf('http://198.19.1.1/ping') },
      { id: 'privateLiteral', name: await refusalOf('http://10.0.0.1/ping') },
      { id: 'loopbackLiteral', name: await refusalOf('http://127.0.0.1/ping') },
      { id: 'localhost', name: await refusalOf('http://localhost/ping') },
      { id: 'dotLocal', name: await refusalOf('http://x.local/ping') },
      { id: 'mappedLiteral', name: await refusalOf('http://[::ffff:127.0.0.1]/ping') },
    ];
  },

  async raiseHandBuiltNotFound() {
    throw { code: 'NOT_FOUND', message: 'hand-built, not yonto.error.notFound()' };
  },
};

// The body when fetched, the code and the message when refused: the message names the host,
// which is how this pins that both hosts refused the name the plugin asked for.
async function refusalOf(url) {
  return yonto.fetch(url).then(
    (response) => response.body,
    (error) => `${error.code}: ${error.message}`,
  );
}
