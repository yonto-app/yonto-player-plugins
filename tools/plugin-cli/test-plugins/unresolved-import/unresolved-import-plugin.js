/* yonto-plugin
{
  "kind": "content-source",
  "id": "unresolved-import",
  "name": "Unresolved import",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": [
    "h.tv"
  ]
}
*/
import { helper } from './src/nowhere.js';

export default {
  async getCategories() { return helper(); },
  async getMediaList() { return []; },
  async getMediaDetail() { return null; },
  async search() { return []; },
};
