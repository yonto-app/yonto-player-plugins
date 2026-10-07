/* yonto-plugin
{
  "kind": "content-source",
  "id": "link-login",
  "name": "A source signed in with a code",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source-type",
  "allowedHosts": ["*.plex.direct"],
  "configSchema": [{ "id": "serverUrl", "label": "Server", "type": "url" }],
  "capabilities": [{ "type": "linkLogin", "service": "plex.tv" }]
}
*/
async function firstServer() {
  if (!yonto.session.linked()) throw yonto.error.unauthenticated('not logged in');
  const [server] = await yonto.session.servers();
  if (!server) throw yonto.error.unavailable('the account lists no server');
  return server.connections[0].uri;
}

export default {
  async getCategories() {
    const response = await yonto.fetch(`${await firstServer()}/library/sections`);
    if (response.status === 401) {
      yonto.session.refused();
      throw yonto.error.unavailable('the server refused its credential');
    }
    return JSON.parse(response.body).sections;
  },
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  async search() { return [{ id: 'm', title: 'M' }]; },
  async sessionState() {
    return { linked: yonto.session.linked(), servers: await yonto.session.servers() };
  },
  async echo(url) {
    const response = await yonto.fetch(url);
    return { body: response.body, headers: response.headers };
  },
  async says(text) {
    yonto.log('info', text);
    yonto.partial(text);
    throw new Error(text);
  },
};
