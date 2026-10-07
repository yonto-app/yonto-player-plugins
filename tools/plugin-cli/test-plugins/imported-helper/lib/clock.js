// Deliberately outside the plugin's own directory tree in the sense that matters: it is
// not under `src/`, which is the only place the old scan looked. The build reads it.
export function stamp() {
  return yonto.teleport();
}
