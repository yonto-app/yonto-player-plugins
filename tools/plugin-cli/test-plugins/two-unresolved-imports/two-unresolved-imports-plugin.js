/* yonto-plugin
{
  "kind": "content-source",
  "id": "two-unresolved-imports",
  "name": "Two unresolved imports",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": [
    "h.tv"
  ]
}
*/
import { helper } from './src/nowhere.js';
import { other } from './src/elsewhere.js';

export default {
  async getCategories() { return helper(other); },
  async getMediaList() { return []; },
  async getMediaDetail() { return null; },
  async search() { return []; },
};
