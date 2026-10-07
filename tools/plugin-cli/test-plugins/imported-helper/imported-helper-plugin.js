/* yonto-plugin
{
  "kind": "content-source",
  "id": "imported-helper",
  "name": "A helper the scan used to miss",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": [
    "h.tv"
  ]
}
*/
import { stamp } from './lib/clock.js';

export default {
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  async search() { return [{ id: 'm', title: 'M' }]; },
  async getCategories() {
    return [{ id: String(stamp()), name: 'C' }];
  },
};
