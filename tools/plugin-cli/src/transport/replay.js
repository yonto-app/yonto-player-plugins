import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Code, PluginError } from '../errors.js';
import { fixtureName } from './record.js';

export function createReplayTransport({ dir }) {
  return {
    async request(req) {
      const file = join(dir, fixtureName(req));
      if (!existsSync(file)) {
        // Which of the two it is changes what an author should do, and the message used to
        // tell them to record — advice that is wrong for a plugin whose fixtures were
        // never recordable in the first place. plugins/ddys is one: its site needs a
        // session cookie, and a cookie must not end up in a committed fixture.
        throw new PluginError(Code.NO_FIXTURE,
          existsSync(dir) && readdirSync(dir).length > 0
            ? `no recorded fixture for ${req.method} ${req.url} — re-run with --record`
            : `this plugin has no recorded fixtures at all (${dir} is empty or absent), ` +
              `so --replay has nothing to answer ${req.method} ${req.url} with`,
          { url: req.url, file });
      }
      const fixture = JSON.parse(readFileSync(file, 'utf8'));
      return fixture.response;
    },
  };
}
