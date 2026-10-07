/* yonto-plugin
{
  "kind": "content-source",
  "id": "private-floor",
  "name": "The private-address floor",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source-type",
  "description": "A manifest cannot reach the viewer's own network by naming it; a viewer typing an address can.",
  "allowedHosts": [
    "192.168.1.1",
    "0x7f000001",
    "h.test",
    "*.plex.test"
  ],
  "configSchema": [
    {
      "id": "typedUrl",
      "label": "Your box",
      "type": "url"
    },
    {
      "id": "defaultedUrl",
      "label": "Seeded",
      "type": "url",
      "default": "http://192.168.1.2/config.json"
    },
    {
      "id": "schemelessDefault",
      "label": "Seeded without a scheme",
      "type": "url",
      "default": "192.168.1.3:8080"
    }
  ]
}
*/
// The floor: a plugin may not reach the television's own network because its manifest asked
// to. A viewer typing an address into a `url` field is the whole exception, and a `default`
// a viewer never changed is the manifest asking rather than the viewer — see
// contracts/content-source-http.md's "The private-address floor".
//
// One file, two hosts, one expected.json. A host that skipped the floor would fetch where
// these expect a refusal; a host that applied it to the typed address would refuse the one
// case a viewer actually asked for; and a host that classified before folding the spelling
// would name a different address in the message.

export default {
  async getCategories() {
    return [
      { id: 'manifestNamed', name: await refusalOf('http://192.168.1.1/') },
      // The manifest names loopback as `0x7f000001` and the request writes it as
      // `2130706433`. Both fold to `127.0.0.1`, so the entry *does* permit the request —
      // and the floor refuses it anyway. One case, both halves.
      { id: 'manifestNamedOddly', name: await refusalOf('http://2130706433/') },
      { id: 'seededDefault', name: await refusalOf('http://192.168.1.2/config.json') },
      // The same thing written without a scheme. The editor saves what `SourceUrl.normalize`
      // returns, so the stored value is never byte-identical to the default it came from —
      // and a host comparing the strings rather than the hosts calls this a viewer's word
      // and exempts it from the floor, with nobody having typed an address.
      { id: 'schemelessDefault', name: await refusalOf('http://192.168.1.3:8080/') },
      { id: 'viewerTyped', name: await bodyOf('http://192.168.1.50:8096/ping') },
      { id: 'redirectOffTypedHost', name: await refusalOf('http://192.168.1.50:8096/moved') },
      { id: 'publicHost', name: await bodyOf('https://h.test/ping') },
      // A name the manifest allows is reached, as a Plex server's `*.plex.direct` names are.
      { id: 'manifestNamedName', name: await bodyOf('https://1-2-3-4.abc.plex.test/ping') },
    ];
  },

  async raiseHandBuiltNotFound() {
    throw { code: 'NOT_FOUND', message: 'hand-built, not yonto.error.notFound()' };
  },
};

// The code and the message both, because the message carries the canonical host — which is
// how this pins that the two hosts folded the spelling the same way before refusing it.
async function refusalOf(url) {
  return yonto.fetch(url).then(
    (response) => `fetched ${response.status}`,
    (error) => `${error.code}: ${error.message}`,
  );
}

async function bodyOf(url) {
  return yonto.fetch(url).then((response) => response.body, (error) => `threw ${error.code}`);
}
