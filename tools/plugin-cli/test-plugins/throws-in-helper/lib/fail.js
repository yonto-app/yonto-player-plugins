// A helper esbuild inlines above the plugin's own code, which is where a bundle's line
// numbers drift furthest from the file an author has open (kangzj/lantern-tv#455).
export function explode() {
  throw new Error('the helper gave up');
}
