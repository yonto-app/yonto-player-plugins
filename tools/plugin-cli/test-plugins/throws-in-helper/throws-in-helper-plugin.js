/* yonto-plugin
{
  "kind": "content-source",
  "id": "throws-in-helper",
  "name": "Throws in a helper",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": [
    "h.tv"
  ]
}
*/
import { explode } from './lib/fail.js';

export default {
  async getCategories() { return explode(); },
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  async search() { return [{ id: 'm', title: 'M' }]; },
};
