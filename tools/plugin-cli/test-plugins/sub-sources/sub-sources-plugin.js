/* yonto-plugin
{
  "kind": "content-source",
  "id": "sub-sources",
  "name": "A source that is several libraries",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "catalogsAreRemote": true,
  "allowedHosts": []
}
*/
// One source made of several libraries, the shape a 仓 or an XPTV index had while a plugin
// read one: `getSubSources` offers them, `yonto.subSource()` is the viewer's pick, and
// everything else answers from the picked library alone, naming it, so a test can see which
// one was read. `resting` is offered greyed, never hidden, and picking it reads the first.
const LIBRARIES = [
  { id: 'north', name: '北方资源库' },
  { id: 'south', name: '南方资源库' },
  { id: 'resting', name: '休息中的资源库', available: false },
];

function active() {
  const picked = yonto.subSource();
  return LIBRARIES.find((library) => library.id === picked && library.available !== false) ?? LIBRARIES[0];
}

const titleOf = (library, page) => ({ id: `${library.id}-${page}`, title: `${library.name}的第${page}部片` });

export default {
  async getSubSources() {
    return { items: LIBRARIES, activeId: active().id };
  },
  async getCategories() {
    return [{ id: 'latest', name: `${active().name}最新` }];
  },
  async getMediaList(categoryId, { page }) {
    return [titleOf(active(), page)];
  },
  async getMediaDetail(id) {
    const [, libraryId, page] = /^(.+)-(\d+)$/.exec(id) ?? [];
    const library = LIBRARIES.find((it) => it.id === libraryId);
    if (!library) throw yonto.error.notFound(`没有 ${id}`);
    return {
      ...titleOf(library, Number(page)),
      playbackOptions: [{ label: '正片', stream: { url: `https://media.example/${id}.m3u8` } }],
    };
  },
  async search() {
    return [titleOf(active(), 1)];
  },
};
