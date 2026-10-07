/* yonto-plugin
{
  "kind": "content-source",
  "id": "says-partial",
  "name": "A source whose answers are incomplete",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": []
}
*/
// Only the listing's two pages' sentences show, cleaned: the categories' is on a method no
// screen draws it under, the detail's is only a bell, and the search takes its own back.
export default {
  async getCategories() {
    yonto.partial('分类只列出了一部分。');
    return [{ id: 'a', name: 'A' }];
  },
  async getMediaList(categoryId, options) {
    if (options.page > 1) {
      yonto.partial('第二页只问到了三个站点。');
      return [];
    }
    yonto.partial('一号站没有回应。');
    yonto.partial('四个站点中有一个\u202e没有回应\u0007，列表可能不全。');
    return [{ id: 'm', title: 'M' }];
  },
  async getMediaDetail() {
    yonto.partial('\u0007');
    return { id: 'm', title: 'M', playbackOptions: [{ label: '1', stream: { url: 'https://h.tv/1.m3u8' } }] };
  },
  async search() {
    yonto.partial('搜索只问到了三个站点。');
    yonto.partial('');
    return [{ id: 'm', title: 'M' }];
  },
};
