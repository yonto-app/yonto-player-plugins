/* yonto-plugin
{
  "kind": "content-source",
  "id": "device-without-stream",
  "name": "A source that asks for the device and answers no track",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": ["example.com"],
  "deviceProfile": true
}
*/
// The declaration without the export. What the device plays reaches getStream alone, so a
// manifest asking for it from a source with no getStream is a manifest lint refuses.
export default {
  async getCategories() { return [{ id: 'a', name: 'A' }]; },
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() {
    return { id: 'm', title: 'M', playbackOptions: [{ label: 'Play', stream: { url: 'https://example.com/m.mp4', mimeType: 'video/mp4' } }] };
  },
  async search() { return [{ id: 'm', title: 'M' }]; },
};
