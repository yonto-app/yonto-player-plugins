/* yonto-plugin
{
  "kind": "content-source",
  "id": "computed-key",
  "name": "Methods under keys the scan cannot fold",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": [
    "h.tv"
  ]
}
*/
const NAMES = ['getCategories', 'getMediaList', 'getMediaDetail', 'search'];

export default {
  [NAMES[0]]: async () => [{ id: 'c', name: 'C' }],
  [NAMES[1]]: async () => [{ id: 'm', title: 'M' }],
  [NAMES[2]]: async () => ({ id: 'm', title: 'M', playbackOptions: [] }),
  [NAMES[3]]: async () => [{ id: 'm', title: 'M' }],
};
