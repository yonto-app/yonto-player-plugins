// Next to the entry rather than under `src/`, which is the shape that broke the old
// "a key with no `/` is the plugin" inference: this file's path relative to the plugin is
// a bare basename too.
//
// The internal table is the part that mattered — read as the entry, `getSubSources` in it
// counted as the plugin exporting one.
const handlers = {
  getSubSources() {
    return { items: [], activeId: null };
  },
};

export function pick() {
  return handlers.getSubSources();
}
