/* yonto-plugin
{
  "kind": "content-source",
  "id": "hosts-from-config",
  "name": "Hosts from config",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source-type",
  "description": "The one manifest flag that turns the allowlist off; both hosts must read it the same way.",
  "allowedHosts": [],
  "hostsFromConfig": true
}
*/
// A plugin whose servers are named inside the config a viewer pointed it at — an XPTV
// catalog's program is the real one — declares `hostsFromConfig`, and then nothing checks where it goes.
//
// This suite exists because that flag is read by two hosts and asserted by one file: a host
// that forgot it would refuse every request such a catalog makes, and a host that applied it to
// everything would take the allowlist off for every plugin. `conformance/host-api` pins the
// second half, by refusing a host its manifest does not name.

export default {
  async getCategories() {
    return [
      { id: 'unnamedHost', name: await unnamedHost() },
      { id: 'unnamedRedirect', name: await unnamedRedirect() },
    ];
  },

  async raiseHandBuiltNotFound() {
    throw { code: 'NOT_FOUND', message: 'hand-built, not yonto.error.notFound()' };
  },
};

// Nothing in the manifest names this host, and there is no `url` field to widen anything.
async function unnamedHost() {
  return yonto.fetch('https://anywhere.test/ping').then((r) => r.body, (error) => `threw ${error.code}`);
}

// A redirect is where a request leaves the host it was allowed to reach, so a host that
// applied the flag only to the first hop would fail here and nowhere else.
async function unnamedRedirect() {
  return yonto.fetch('https://anywhere.test/moved').then((r) => `${r.body}|${r.url}`, (error) => `threw ${error.code}`);
}
