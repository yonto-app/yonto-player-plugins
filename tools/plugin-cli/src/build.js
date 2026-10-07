import { realpathSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import * as esbuild from 'esbuild';
import { Code, PluginError } from './errors.js';
import { entryFile } from './manifest.js';

/**
 * Where esbuild names a plugin's files from: the plugin's own directory.
 *
 * esbuild writes each module's path, relative to its working directory, into the bundle as a
 * comment, so left to cwd one plugin bundled to different bytes from two directories, and a
 * published sha256 could not be reproduced from anywhere but where it was built
 * (kangzj/lantern-tv#638). From the plugin's own directory the bytes depend on the plugin and
 * nothing else: not the working directory, and not the folders above it, which for an author
 * outside this repo would put their own path, username included, into what they publish.
 */
export function bundleRoot(dir) {
  return realpathSync(dir);
}

/**
 * The plugin bundled from its entry, or one sentence saying why it could not be.
 *
 * Every command builds the same file with the same bundler, so they fail with the same
 * words: left to itself esbuild prints its own log to stderr, then throws an error whose
 * message names each file relative to wherever the CLI was run from (kangzj/lantern-tv#452).
 * Its locations are real paths, so the plugin's own directory is resolved the same way before
 * they are named from it: a plugin reached through a symlink would otherwise be named by the
 * walk out of the link and back in.
 */
export async function buildPlugin(dir, options) {
  const entry = entryFile(dir);
  try {
    return await esbuild.build({
      entryPoints: [resolve(entry)],
      bundle: true,
      target: 'es2020',
      // Both hosts run a module that awaits at the top level (kangzj/lantern-tv#457), and
      // es2020 would refuse it. Only this is admitted rather than the target raised, so a
      // plugin that does not use it bundles to the same bytes it always did.
      supported: { 'top-level-await': true },
      platform: 'neutral',
      absWorkingDir: bundleRoot(dir),
      write: false,
      logLevel: 'silent',
      ...options,
    });
  } catch (cause) {
    const home = realpathSync(dir);
    const reasons = (cause.errors ?? []).map(({ text, location }) => (location
      ? `${relative(home, resolve(bundleRoot(dir), location.file))}:${location.line}:${location.column}: ${text}`
      : text));
    throw new PluginError(Code.BUILD_FAILED,
      `${basename(entry)} could not be built: ${reasons.length ? reasons.join('; ') : cause.message}`, { entry });
  }
}
