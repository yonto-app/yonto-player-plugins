/* yonto-plugin
{
  "kind": "content-source",
  "id": "link-login-host-api",
  "name": "yonto.session conformance",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source-type",
  "allowedHosts": ["*.plex.direct"],
  "configSchema": [{ "id": "serverUrl", "label": "Server", "type": "url" }],
  "capabilities": [{ "type": "linkLogin", "service": "plex.tv" }]
}
*/
// A probe, not a source: each case is what yonto.session and yonto.fetch answer a linked
// plugin, which both hosts must answer alike (conformance/link-login/host-api/expected.json).
// The two tokens below are this suite's test data, known here only so a case can put one
// where no plugin could have got it from.
const SERVER_TOKEN = 'shared-token-aaaaaaaa';
const ACCOUNT_TOKEN = 'account-token-cccccccc';
const BOUND = 'https://203-0-113-7.aaaa.plex.direct:32400';

async function outcome(run) {
  try {
    return String(await run());
  } catch (error) {
    return `${error.code}: ${error.message}`;
  }
}

export default {
  async getCategories() {
    const cases = {};
    // Fetched before the host has read any server's token, and its bytes read after.
    const early = await yonto.fetch(`${BOUND}/echo`);
    cases.linked = String(yonto.session.linked());
    cases.servers = JSON.stringify(await yonto.session.servers());
    cases.echoedBody = await outcome(async () => (await yonto.fetch(`${BOUND}/echo`)).body);
    cases.echoedHeaders = await outcome(async () => JSON.stringify((await yonto.fetch(`${BOUND}/echo`)).headers));
    cases.echoedBytes = await outcome(async () => yonto.encoding.base64Decode((await yonto.fetch(`${BOUND}/echo`)).bodyBase64));
    cases.redirectedLocation = await outcome(async () => (await yonto.fetch(`${BOUND}/moved`, { redirect: 'manual' })).location);
    cases.credentialInUrl = await outcome(() => yonto.fetch(`${BOUND}/library?X-Plex-Token=${SERVER_TOKEN}`));
    cases.accountInUrl = await outcome(() => yonto.fetch(`${BOUND}/library?t=${encodeURIComponent(ACCOUNT_TOKEN)}`));
    cases.bytesReadLater = yonto.encoding.base64Decode(early.bodyBase64);
    yonto.session.refused();
    cases.linkedAfterRefused = String(yonto.session.linked());
    return Object.entries(cases).map(([id, name]) => ({ id, name }));
  },
  async getMediaList() { return []; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  async search() { return []; },
  // What a thrown message carrying a held credential reads as once it has crossed into the host.
  async raiseHandBuiltNotFound() {
    throw { code: 'NOT_FOUND', message: `not found: ${SERVER_TOKEN} or ${ACCOUNT_TOKEN}` };
  },
};
