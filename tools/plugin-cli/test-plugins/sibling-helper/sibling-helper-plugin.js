/* yonto-plugin
{
  "kind": "content-source",
  "id": "sibling-helper",
  "name": "A helper beside the entry",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": [
    "h.tv"
  ]
}
*/
import { pick } from './helper.js';

export default {
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  async search() { return [{ id: 'm', title: 'M' }]; },
  async getCategories() {
    return [{ id: 'c', name: String(pick().items.length) }];
  },
};
