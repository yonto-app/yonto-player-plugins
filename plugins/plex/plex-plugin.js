/* yonto-plugin
{
  "kind": "content-source",
  "id": "plex",
  "name": "Plex",
  "version": "1.1.3",
  "contractVersion": 21,
  "description": "The Plex servers shared with you, once you log in with a code, or your own server at an address you type.",
  "probeQuery": "bunny",
  "provides": "source-type",
  "allowedHosts": ["*.plex.direct"],
  "catalogsAreRemote": true,
  "configSchema": [
    {
      "id": "serverUrl",
      "label": "Your own server's URL (leave empty to log in instead)",
      "type": "url"
    },
    {
      "id": "token",
      "label": "Plex token, only if your server asks (usually your whole Plex account's token)",
      "type": "secret"
    }
  ],
  "capabilities": [{ "type": "linkLogin", "service": "plex.tv" }]
}
*/
// Plex Media Servers (https://developer.plex.tv/pms/), read through their documented API, each
// one library. A server the viewer typed is read exactly as before the sign-in existed, with the
// token typed beside it. The host's plex.tv login lists the servers shared with the account, and
// the host attaches each one's own token: this plugin sends none to them, and never reaches
// plex.tv (plugins/plex/AGENTS.md).

// Browse pages, so this is a page and not a cap.
const PAGE_SIZE = 60;
const SEARCH_LIMIT = 50;

const MOVIE = 'movie';
const SHOW = 'show';
const LIBRARY_TYPES = [MOVIE, SHOW];

// Plex serves the stored artwork unless asked to resize it; these are the sizes a poster card
// and a full-bleed backdrop are drawn at on a 1080p screen.
const POSTER_SIZE = { width: 480, height: 720 };
const BACKDROP_SIZE = { width: 1920, height: 1080 };

const PRODUCT = 'Yonto';

// A shared server's media id is `<server id>|<ratingKey>` and the typed server's the bare
// ratingKey, so History finds a title on its own server whichever library is picked.
const ID_SEPARATOR = '|';
const TYPED_SERVER_ID = 'typed';

// The only connections the manifest can reach, and the only ones the host binds a token to.
const PLEX_DIRECT = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.plex\.direct(:\d{1,5})?$/i;
const CONNECTION_KEY = 'connection:';
// What a server answers with no token, so a 2xx there says the connection works.
const PROBE_PATH = '/identity';
// How long a direct connection may take to answer after a relay has: a relay is bandwidth-capped.
const RELAY_GRACE_MS = 1000;
// How long a relay is kept before the direct connections are probed again. Not every call: a
// television's call waits for all its requests, so each probe of a dead one costs a connect timeout.
const RELAY_KEPT_SECONDS = 10 * 60;

const SERVER_ERROR_MESSAGE = 'The server answered with an error.';
const SERVER_DOWN_MESSAGE = 'The server did not answer. Check it is running and on this network.';
const SHARED_DOWN_MESSAGE = 'None of the server\'s addresses answered.';
const SERVER_OFF_LIMITS_MESSAGE = 'The server sent this request somewhere it may not go.';
const UNUSABLE_ADDRESS_MESSAGE = 'The server URL cannot be used. Check it by editing the source in Settings.';
const REDIRECTS_REFUSED_MESSAGE = 'The server redirected too far. Check the server URL by editing the source in Settings.';
const UNREADABLE_MESSAGE = 'The server answered with something that is not a Plex library.';
const QUERY_UNUSABLE_MESSAGE = 'This search cannot be sent. Try different words.';
const TOKEN_REFUSED_MESSAGE = 'The server refused the token. Check it by editing the source in Settings.';
const TOKEN_WANTED_MESSAGE = 'The server asks for a Plex token. Add one by editing the source in Settings.';
const SHARED_REFUSED_MESSAGE = 'The server refused this login. Try again in a minute.';
const LOG_IN_MESSAGE = 'Log in to Plex, or type your own server\'s address, by editing the source in Settings.';
const ACCOUNT_DOWN_MESSAGE = 'The list of your Plex servers could not be read.';
const NO_SHARED_SERVERS_MESSAGE =
  'No Plex server is shared with this account. For your own server, add its address and token by editing the source in Settings.';
const NOTHING_TO_PLAY_MESSAGE = 'The server has no playable file for this title.';

function typedServer() {
  return (yonto.config.serverUrl || '').replace(/\/+$/, '');
}

function token() {
  return yonto.config.token || '';
}

// The typed token belongs to the typed server alone: a shared server is signed by the host.
function tokenHeaders(target) {
  return target.typed && token() ? { 'X-Plex-Token': token() } : {};
}

function apiHeaders(target) {
  return {
    Accept: 'application/json',
    'X-Plex-Product': PRODUCT,
    'X-Plex-Client-Identifier': `lantern-${yonto.installId()}`,
    ...tokenHeaders(target),
  };
}

function queryOf(params) {
  const query = Object.keys(params || {})
    .filter((key) => params[key] !== undefined)
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
    .join('&');
  return query ? `?${query}` : '';
}

function rankOf(connection) {
  if (connection.relay) return 2;
  return connection.local ? 0 : 1;
}

// Local, then remote, then relay: the order Plex's own clients prefer.
function connectionsOf(server) {
  return server.connections
    .map((connection) => ({ connection, base: String(connection.uri).replace(/\/+$/, '') }))
    .filter(({ base }) => PLEX_DIRECT.test(base))
    .sort((a, b) => rankOf(a.connection) - rankOf(b.connection))
    .map(({ connection, base }) => ({ base, relay: connection.relay === true }));
}

// The servers shared with the login, each with the connections this plugin can reach.
async function sharedServers() {
  let servers;
  try {
    servers = await yonto.session.servers();
  } catch (error) {
    yonto.log('warn', `the account's servers could not be read: ${error?.code ?? 'no code'}`);
    if (error?.code === 'REQUEST_FAILED') throw yonto.error.unreachable(ACCOUNT_DOWN_MESSAGE);
    throw error;
  }
  // Signed out, or the account refused the host's own request: the list is empty either way.
  if (!yonto.session.linked()) throw yonto.error.unauthenticated(LOG_IN_MESSAGE);
  return servers
    .filter((server) => !server.owned)
    .map((server) => ({ id: server.id, name: server.name || server.id, connections: connectionsOf(server) }))
    .filter((server) => server.connections.length > 0);
}

// Beside a typed server a login is extra: its absence or failure leaves the typed library alone,
// unless a shared server is the pick, which must not be read as the typed one without a word.
async function sharedBesideTyped() {
  if (!yonto.session.linked()) return [];
  const pick = yonto.subSource();
  if (pick !== null && pick !== TYPED_SERVER_ID) return sharedServers();
  try {
    return await sharedServers();
  } catch (error) {
    yonto.log('warn', `the shared servers were left out: ${error?.code ?? 'no code'}`);
    return [];
  }
}

// With no typed server, a login sharing nothing leaves the viewer's own server to be typed.
async function sharedOnly() {
  const servers = await sharedServers();
  if (servers.length === 0) throw yonto.error.misconfigured(NO_SHARED_SERVERS_MESSAGE);
  return servers;
}

function typedLibrary() {
  return { id: TYPED_SERVER_ID, name: typedServer().replace(/^[a-z]+:\/\//i, '') };
}

function sharedLibrary(server) {
  return { id: server.id, name: server.name };
}

async function rememberedBase(server) {
  const base = await yonto.store.get(CONNECTION_KEY + server.id);
  return server.connections.some((connection) => connection.base === base) ? base : null;
}

function typedTarget() {
  return { typed: true, base: typedServer(), prefix: '' };
}

async function sharedTarget(server) {
  const remembered = await rememberedBase(server);
  return { typed: false, server, remembered, base: null, probed: false, prefix: `${server.id}${ID_SEPARATOR}` };
}

// The picked library, falling back to the typed one and then to the first shared server.
async function pickedTarget() {
  const pick = yonto.subSource();
  if (typedServer()) {
    if (pick === null || pick === TYPED_SERVER_ID) return typedTarget();
    const server = (await sharedBesideTyped()).find((s) => s.id === pick);
    return server ? sharedTarget(server) : typedTarget();
  }
  const servers = await sharedOnly();
  return sharedTarget(servers.find((s) => s.id === pick) || servers[0]);
}

// A bare id is the typed server's ratingKey as it always was; a shared server's names its server.
async function targetOf(mediaId) {
  const at = mediaId.indexOf(ID_SEPARATOR);
  if (at === -1) return { target: typedServer() ? typedTarget() : null, key: mediaId };
  const server = (await sharedServers()).find((s) => s.id === mediaId.slice(0, at));
  return { target: server ? await sharedTarget(server) : null, key: mediaId.slice(at + 1) };
}

function refusal(error, target) {
  switch (error?.code) {
    case 'REQUEST_FAILED': return yonto.error.unreachable(target.typed ? SERVER_DOWN_MESSAGE : SHARED_DOWN_MESSAGE);
    case 'HOST_NOT_ALLOWED': return yonto.error.unavailable(SERVER_OFF_LIMITS_MESSAGE);
    case 'REDIRECT_REFUSED': return yonto.error.unavailable(REDIRECTS_REFUSED_MESSAGE);
    case 'REQUEST_INVALID':
      return target.typed ? yonto.error.misconfigured(UNUSABLE_ADDRESS_MESSAGE) : yonto.error.unavailable(UNREADABLE_MESSAGE);
    default: return error;
  }
}

async function fetchTyped(target, pathAndQuery, what) {
  try {
    return await yonto.fetch(`${target.base}${pathAndQuery}`, { headers: apiHeaders(target) });
  } catch (error) {
    // The code, never the message: a failed fetch can name the URL.
    yonto.log('warn', `${what} failed: ${error?.code ?? 'no code'}`);
    throw refusal(error, target);
  }
}

// Every connection at once, as Plex's own clients do: one after another, two that drop packets
// spend the call's budget on connect timeouts before a relay is ever asked. The first direct one
// to answer wins, and a relay only when no direct one answers within the grace.
function probe(target, what) {
  return new Promise((resolve, reject) => {
    const { connections } = target.server;
    let waiting = connections.length;
    let relay = null;
    let settled = false;
    const settle = (base) => {
      if (settled) return;
      settled = true;
      resolve(base);
    };
    const answered = () => {
      waiting -= 1;
      if (waiting > 0 || settled) return;
      if (relay !== null) settle(relay);
      else {
        settled = true;
        reject(refusal({ code: 'REQUEST_FAILED' }, target));
      }
    };
    for (const { base, relay: isRelay } of connections) {
      yonto.fetch(`${base}${PROBE_PATH}`, { headers: apiHeaders(target) }).then((response) => {
        if (!isSuccess(response.status)) {
          yonto.log('warn', `${what}: a connection answered HTTP ${response.status}`);
        } else if (!isRelay) settle(base);
        else if (relay === null) {
          relay = base;
          yonto.sleep(RELAY_GRACE_MS).then(() => settle(base), () => settle(base));
        }
        answered();
      }, (error) => {
        yonto.log('warn', `${what}: a connection did not answer: ${error?.code ?? 'no code'}`);
        answered();
      });
    }
  });
}

// The remembered connection, or the probe's winner, remembered; a relay only for a while.
async function connect(target, what) {
  if (target.remembered !== null) return target.remembered;
  target.probed = true;
  const base = await probe(target, what);
  target.remembered = base;
  const key = CONNECTION_KEY + target.server.id;
  const kept = target.server.connections.some((c) => c.base === base && c.relay)
    ? yonto.store.set(key, base, { ttlSeconds: RELAY_KEPT_SECONDS })
    : yonto.store.set(key, base);
  await kept.catch(() => {});
  return base;
}

function isSuccess(status) {
  return status >= 200 && status < 300;
}

// A remembered connection that stops answering, or answers with an error, is let go and the
// connections probed once more.
async function fetchShared(target, pathAndQuery, what) {
  let response;
  try {
    if (target.base === null) target.base = await connect(target, what);
    response = await yonto.fetch(`${target.base}${pathAndQuery}`, { headers: apiHeaders(target) });
  } catch (error) {
    yonto.log('warn', `${what} failed: ${error?.code ?? 'no code'}`);
    if (error?.code !== 'REQUEST_FAILED' && error?.code !== 'UNREACHABLE') throw refusal(error, target);
    await yonto.store.remove(CONNECTION_KEY + target.server.id).catch(() => {});
    if (target.probed) throw refusal({ code: 'REQUEST_FAILED' }, target);
    return probedAgain(target, pathAndQuery, what);
  }
  if (target.probed || isSuccess(response.status)) return response;
  yonto.log('warn', `${what} got HTTP ${response.status} from the connection it kept`);
  await yonto.store.remove(CONNECTION_KEY + target.server.id).catch(() => {});
  return probedAgain(target, pathAndQuery, what);
}

function probedAgain(target, pathAndQuery, what) {
  target.remembered = null;
  target.base = null;
  return fetchShared(target, pathAndQuery, what);
}

async function get(target, path, what, params) {
  // Outside the fetch's try: a lone surrogate in a search makes `encodeURIComponent` throw,
  // and that is not the server's failure (kangzj/lantern-tv#293).
  let query;
  try {
    query = queryOf(params);
  } catch {
    yonto.log('warn', `could not build the ${what} request from what was typed`);
    throw yonto.error.unavailable(QUERY_UNUSABLE_MESSAGE);
  }
  const response = target.typed
    ? await fetchTyped(target, `${path}${query}`, what)
    : await fetchShared(target, `${path}${query}`, what);
  if (response.status === 401 || response.status === 403) {
    yonto.log('warn', `${what} got HTTP ${response.status}`);
    if (!target.typed) {
      // The token the host attached was refused: it asks plex.tv again on the next call.
      yonto.session.refused();
      throw yonto.error.unavailable(SHARED_REFUSED_MESSAGE);
    }
    throw yonto.error.unauthenticated(token() ? TOKEN_REFUSED_MESSAGE : TOKEN_WANTED_MESSAGE);
  }
  if (response.status === 404) throw yonto.error.notFound(what);
  if (response.status < 200 || response.status >= 300) {
    yonto.log('warn', `${what} got HTTP ${response.status}`);
    throw yonto.error.unreachable(SERVER_ERROR_MESSAGE);
  }
  let payload;
  try {
    payload = JSON.parse(response.body);
  } catch {
    payload = undefined;
  }
  if (!payload || typeof payload.MediaContainer !== 'object' || payload.MediaContainer === null) {
    yonto.log('warn', `${what} answered 200 with no MediaContainer`);
    throw yonto.error.unavailable(UNREADABLE_MESSAGE);
  }
  return payload.MediaContainer;
}

function list(container, key) {
  return Array.isArray(container[key]) ? container[key] : [];
}

// No token in the URL: the app signs the typed host's artwork with `getImageHeaders()`, and a
// shared server's with the host's own token.
function imageUrl(target, path, size) {
  if (!path) return undefined;
  return `${target.base}/photo/:/transcode${queryOf({
    url: path,
    width: String(size.width),
    height: String(size.height),
    minSize: '1',
    upscale: '1',
  })}`;
}

function mediaType(item) {
  return item.type === SHOW ? 'SERIES' : 'MOVIE';
}

function yearOf(item) {
  return item.year === null || item.year === undefined ? undefined : String(item.year);
}

function toSummary(target, item) {
  return {
    id: `${target.prefix}${item.ratingKey}`,
    title: item.title,
    type: mediaType(item),
    posterUrl: imageUrl(target, item.thumb, POSTER_SIZE),
    backdropUrl: imageUrl(target, item.art, BACKDROP_SIZE),
    year: yearOf(item),
    rating: item.contentRating || undefined,
  };
}

// The part key is the one string the server puts straight after our host, so it has to be a
// path on that host: `@evil.example/x` or `//evil.example/x` would move the stream, and the
// token in its headers, somewhere else.
const PATH_ON_THIS_HOST = /^\/(?![/\\])/;

function firstPartKey(media) {
  const part = (media.Part || [])[0];
  const key = part && part.key;
  return typeof key === 'string' && PATH_ON_THIS_HOST.test(key) ? key : undefined;
}

// The contract reads a stream with no mimeType as HLS, so a file has to say it is not one.
// Past that the player sniffs the container itself; these only name it where Plex did.
const CONTAINER_TYPES = { mkv: 'video/x-matroska', webm: 'video/webm', ts: 'video/mp2t', mpegts: 'video/mp2t' };
const DEFAULT_FILE_TYPE = 'video/mp4';

// The part's own path is Plex's direct play: the file as stored, with the typed token as a
// header so it is never in a URL the player might log.
function streamOf(target, media) {
  const stream = {
    url: `${target.base}${firstPartKey(media)}`,
    mimeType: CONTAINER_TYPES[media.container] || DEFAULT_FILE_TYPE,
  };
  const headers = tokenHeaders(target);
  if (headers['X-Plex-Token']) stream.headers = headers;
  return stream;
}

// One option per version of a movie, named by resolution only when there is more than one.
function movieOptions(target, item) {
  const playable = (item.Media || []).filter(firstPartKey);
  return playable.map((media) => ({
    label: playable.length > 1 && media.videoResolution ? `Play ${media.videoResolution}` : 'Play',
    stream: streamOf(target, media),
  }));
}

function episodeOptions(target, episodes) {
  return episodes
    .map((episode) => ({ episode, media: (episode.Media || [])[0] || {} }))
    .filter(({ media }) => firstPartKey(media))
    .map(({ episode, media }) => {
      const season = episode.parentIndex ?? 1;
      const number = episode.index ?? 0;
      return {
        label: `S${season}E${String(number).padStart(2, '0')} · ${episode.title}`,
        stream: streamOf(target, media),
        season,
      };
    });
}

export default {
  // Only the typed host is ever signed with this: the host signs no `*.` entry's hosts.
  async getImageHeaders() {
    return typedServer() ? tokenHeaders(typedTarget()) : {};
  },

  // The token is typed into the form, so only the viewer can replace one the server refused.
  async onImageHeadersRefused() {
    return { renewable: false };
  },

  // One library per server: the typed one first, then each one shared with the login.
  async getSubSources() {
    const items = typedServer()
      ? [typedLibrary(), ...(await sharedBesideTyped()).map(sharedLibrary)]
      : (await sharedOnly()).map(sharedLibrary);
    const pick = yonto.subSource();
    return { items, activeId: (items.find((item) => item.id === pick) || items[0]).id };
  },

  async getCategories() {
    const target = await pickedTarget();
    return list(await get(target, '/library/sections/all', 'libraries'), 'Directory')
      .filter((section) => LIBRARY_TYPES.indexOf(section.type) !== -1)
      .map((section) => ({ id: String(section.key), name: section.title }));
  },

  async getMediaList(categoryId, options) {
    const { page = 1 } = options || {};
    const target = await pickedTarget();
    const container = await get(target, `/library/sections/${encodeURIComponent(categoryId)}/all`, categoryId, {
      'X-Plex-Container-Start': String(Math.max(page - 1, 0) * PAGE_SIZE),
      'X-Plex-Container-Size': String(PAGE_SIZE),
    });
    return list(container, 'Metadata').map((item) => toSummary(target, item));
  },

  async getMediaDetail(mediaId) {
    const { target, key } = await targetOf(mediaId);
    if (!target) throw yonto.error.notFound(mediaId);
    const path = `/library/metadata/${encodeURIComponent(key)}`;
    const item = list(await get(target, path, mediaId), 'Metadata')[0];
    if (!item) throw yonto.error.notFound(mediaId);
    const options = item.type === SHOW
      ? episodeOptions(target, list(await get(target, `${path}/allLeaves`, mediaId), 'Metadata'))
      : movieOptions(target, item);
    if (options.length === 0) {
      yonto.log('warn', `${item.type} has no media part to play`);
      throw yonto.error.unavailable(NOTHING_TO_PLAY_MESSAGE);
    }
    return {
      ...toSummary(target, item),
      genres: list(item, 'Genre').map((genre) => genre.tag),
      synopsis: item.summary || '',
      playbackOptions: options,
    };
  },

  async search(query) {
    const target = await pickedTarget();
    const hubs = list(await get(target, '/hubs/search', 'search', { query, limit: String(SEARCH_LIMIT) }), 'Hub');
    return hubs
      .filter((hub) => LIBRARY_TYPES.indexOf(hub.type) !== -1)
      .flatMap((hub) => list(hub, 'Metadata'))
      .map((item) => toSummary(target, item));
  },
};
