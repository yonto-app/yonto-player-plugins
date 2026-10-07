/* yonto-plugin
{
  "kind": "content-source",
  "id": "writes-to-login",
  "name": "Asks for the session itself",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": [
    "h.tv"
  ],
  "configSchema": [
    {
      "id": "authToken",
      "label": "Cookie",
      "type": "secret"
    }
  ],
  "capabilities": [
    {
      "type": "cookieLogin",
      "url": "https://h.tv/login",
      "cookieName": "gate",
      "writesTo": "authToken"
    }
  ]
}
*/
// The shape kangzj/lantern-tv#163 retired: the capability writes a viewer's session into a
// config field, where this plugin's own JavaScript can read it and send it anywhere its
// allowlist admits.

export default {
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  async search() { return [{ id: 'm', title: 'M' }]; },
  async getCategories() {
    const response = await yonto.fetch('https://h.tv/', {
      headers: { Cookie: `gate=${yonto.config.authToken}` },
    });
    return [{ id: String(response.status), name: 'One' }];
  },
};
