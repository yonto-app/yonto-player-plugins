/* yonto-plugin
{
  "kind": "content-source",
  "id": "maccms",
  "name": "MacCMS format",
  "version": "1.0.10",
  "contractVersion": 21,
  "description": "Reads sites that serve the MacCMS format, over their JSON or XML API. You supply the address; Yonto includes no site.",
  "probeQuery": "画皮",
  "provides": "source-type",
  "allowedHosts": [],
  "handles": ["maccms-json", "maccms-xml"],
  "configSchema": [
    {
      "id": "api",
      "label": "API address",
      "type": "url",
      "required": true,
      "placeholder": "https://example.com/api.php/provide/vod"
    },
    {
      "id": "dialect",
      "label": "API format",
      "type": "choice",
      "default": "json",
      "options": [
        { "id": "json", "label": "JSON" },
        { "id": "xml", "label": "XML" }
      ]
    },
    {
      "id": "searchable",
      "label": "Supports search",
      "type": "bool",
      "default": "true"
    }
  ],
  "capabilities": []
}
*/
// One MacCMS server, which is one source: the handler for the `maccms-json` and `maccms-xml`
// yonto types (docs/design/2026-09-23-the-app-reads-every-index.md). It is the retired tvbox
// and xptv index plugins' readers of a MacCMS site merged, taking xptv's answer wherever they
// disagreed and tvbox's XML dialect, recommendations and `searchable` refusal besides.
// `plugins/maccms/AGENTS.md` has the site knowledge and the row-by-row account.
//
// **It reaches its `api` and nothing else.** The address is a `url` field, so the host widens
// the allowlist to exactly that host and checks every redirect hop against it; there is no
// `hostsFromConfig` here. A handler never sees the repo its entry came from, and never needs to.
//
// It keeps nothing in `yonto.store`: a server that did not answer is the app's to rest.

// Their two actions per dialect. `detail` (JSON) and `videolist` (XML) answer with titles — the
// whole listing, search and detail surface — and `list` answers with the class tree in both.
const TITLES_ACTION = { json: 'detail', xml: 'videolist' };
const CLASSES_ACTION = 'list';

/**
 * The site's own latest, which is what the titles action answers with no `t`. `latest` because a
 * category id may not be empty; no MacCMS class id is `latest`, since they are the site's numbers.
 */
const LATEST_CATEGORY_ID = 'latest';
const LATEST_CATEGORY_NAME = '最新';

function isLatest(classId) {
  return classId === LATEST_CATEGORY_ID;
}

/** The one filter a MacCMS site offers: the classes under the one being read. */
const CLASS_FILTER = 'class';
const CLASS_FILTER_NAME = '分类';

/** What `type_pid` says when a class has no parent. */
const TOP_CLASS_PID = '0';

/**
 * MacCMS's own seed classes, for a site that sends no `type_pid`.
 *
 * `ac=list` is flat: parents and children in one array, and only some builds say which is
 * which. Where `type_pid` is there, 0 is a parent and that is the whole rule. Where it is not —
 * suoniapi sends 61 classes without it — these four ids are 电影 / 电视剧 / 综艺 / 动漫 in every
 * MacCMS met so far, and everything else in such a list is a child of one of them. A site that
 * renumbered them offers 最新 alone rather than a guess, and its whole tree is still one press
 * away in the 分类 filter.
 */
const SEED_TOP_CLASS_IDS = ['1', '2', '3', '4'];

const RECOMMENDATION_COUNT = 10;

// The sentences a viewer reads. None names the source: a handler is never told its entry's
// name, and the source's own row already says which one this is.

/** A search the URL encoder will not take — a lone surrogate in what the viewer typed. The
 *  server is fine and was never asked (kangzj/lantern-tv#293). */
const QUERY_UNUSABLE_MESSAGE = "This search can't be sent. Try different words.";
/** No promise of a retry: the app rests the source, and nothing asks again until the viewer does. */
const SERVER_DOWN_MESSAGE = "Can't reach this source right now. Try again later.";
/** 401 or 403. There is no login for a MacCMS site, so this points at the one thing a viewer
 *  can do about it rather than at a sign-in screen that does not exist. */
const SERVER_REFUSED_MESSAGE = 'This source refused access. Try another source.';
/** The server was reached, so telling a viewer to wait for a retry would send them after the
 *  one thing that is not going to change. */
const SERVER_UNREADABLE_MESSAGE = "This source answered with something that can't be read. Try another source.";
/** The server answered and said it could not do what was asked. */
const SERVER_FAILED_MESSAGE = 'This source returned nothing this time. Try again later.';
const NO_SEARCH_MESSAGE = "This source doesn't have search. Try another source.";
/**
 * The host refused where the request was going (`HOST_NOT_ALLOWED`): a redirect off the `api`'s
 * host, or a private address the viewer did not type — the latter only once a repo can name an
 * `api` (kangzj/lantern-tv#615, phase 6). One sentence true of both, and not
 * [SERVER_DOWN_MESSAGE]'s, since waiting will not change either. Of #572's 120 MacCMS addresses,
 * one server had moved to another host and six were parked or hijacked (`plugins/maccms/AGENTS.md`).
 */
const SERVER_OFF_LIMITS_MESSAGE = "This source points at an address Yonto won't connect to. Check its API address.";
const MISCONFIGURED_MESSAGE = 'The API address must start with http:// or https://.';
/** The host would not send what the `api` makes (`REQUEST_INVALID`): with only a query added to
 *  it, that is the address itself, so it is the form's to fix. */
const UNUSABLE_ADDRESS_MESSAGE = "The API address can't be used. Check it.";
/** The server answered with a redirect chain the host gave up on (`REDIRECT_REFUSED`): a hop to
 *  something that is not an address, one carrying credentials, or a loop. Nothing to wait out. */
const REDIRECTS_REFUSED_MESSAGE = "This source's redirects lead nowhere. Check its API address.";
/** A TVBox/XPTV index pasted where a single MacCMS interface belongs (kangzj/lantern-tv#1075):
 *  the address's own kind, not the form's spelling of it. */
const INDEX_ADDRESS_MESSAGE = 'This address is a repo of many sites, not a single MacCMS API. Add it under Repos instead.';

function noTracksMessage(title) {
  return `"${title}" has nothing to play.`;
}

const SEARCH_REFUSED = /不支持搜索/;
const HTTP_URL = /^https?:\/\/\S+$/;

const LINE_SEPARATOR = '$$$';
const EPISODE_SEPARATOR = '#';
const EPISODE_NAME_SEPARATOR = '$';

const WHITESPACE = /\s+/g;
const GENRE_SEPARATOR = /[,，/ ]+/;
const CHARSET = /charset=\s*"?([\w-]+)/i;

// A play line whose URLs are media files plays straight in the player; anything else is a web
// page the TVBox players hand to a 解析 service to sniff a stream out of, which is a service
// this app does not have.
const DIRECT_MEDIA_EXTENSIONS = new Set(['m3u8', 'mp4', 'm4v', 'mkv', 'webm', 'flv', 'mov', 'avi', 'ts']);
const HLS_EXTENSION = 'm3u8';

// What a CMS calls a title's kind. A 片 (film) of any kind is a movie, whatever else its name
// says (剧情片 is a drama film, not a series); the rest goes by the usual words.
const MOVIE_TYPE_HINT = '片';
const SERIES_TYPE_HINTS = ['剧', '动漫', '综艺', '动画', '番'];
const SERIES_REMARK_HINTS = ['集', '期', '更新'];

// ---------------------------------------------------------------------------- the server

/**
 * The one server this source reads, from its config — read on each use, because a module that
 * reaches for `yonto` while it is being evaluated can only be imported after the host exists.
 */
function server() {
  const api = yonto.config.api || '';
  if (!HTTP_URL.test(api)) throw yonto.error.misconfigured(MISCONFIGURED_MESSAGE);
  const dialect = yonto.config.dialect === 'xml' ? 'xml' : 'json';
  return { api, dialect, searchable: yonto.config.searchable !== 'false' };
}

/**
 * **The server did not answer**: a request that went out and got nothing back
 * (`REQUEST_FAILED`), or a status other than 404, 401 and 403. The one failure that rests a
 * source, and `unreachable` is how the app is told to (contract 16); nothing here rests anything
 * itself.
 */
function serverDidNotAnswer() {
  return yonto.error.unreachable(SERVER_DOWN_MESSAGE);
}

/**
 * One `ac=` call against the server.
 *
 * The `api` may already carry a query (`?ac=list` is common) or a `/from/x/at/m3u8/` path, so it
 * is used as given with the action set on top of whatever was there.
 *
 * Only a failure to reach the server is [serverDidNotAnswer], and nothing the server says about
 * itself counts as one: a body this cannot read is not — one MacCMS build answers a search with
 * a sentence in plain text while its listings are fine — and neither is the envelope a site says
 * it failed with.
 */
async function ask(site, params) {
  // Built ahead of the fetch and outside its try: `encodeURIComponent` throws on a lone surrogate
  // in what a viewer typed, and that is not the server's failure (kangzj/lantern-tv#293).
  let url;
  try {
    url = withParams(site.api, params);
  } catch {
    yonto.log('warn', 'could not build a request from what was typed');
    throw yonto.error.unavailable(QUERY_UNUSABLE_MESSAGE);
  }
  let response;
  try {
    response = await yonto.fetch(url);
  } catch (error) {
    // Its code and never its message, which can name the URL asked — and a MacCMS address can
    // carry a key.
    yonto.log('warn', `the request failed: ${error?.code ?? 'no code'}`);
    switch (error?.code) {
      // Only this one is the server's silence; every other code is the host's verdict about a
      // request the server either never saw or did answer, and none of them rests anything.
      case 'REQUEST_FAILED': throw serverDidNotAnswer();
      case 'HOST_NOT_ALLOWED': throw yonto.error.unavailable(SERVER_OFF_LIMITS_MESSAGE);
      case 'REDIRECT_REFUSED': throw yonto.error.unavailable(REDIRECTS_REFUSED_MESSAGE);
      case 'REQUEST_INVALID': throw yonto.error.misconfigured(UNUSABLE_ADDRESS_MESSAGE);
      // `TIMEOUT`, the call's budget running out, and anything newer: the host's own code, kept.
      default: throw error;
    }
  }
  // A 404 is a title this site does not have and a 401/403 is a gate: the server answered, so
  // neither is a reason to rest it.
  if (response.status === 404) {
    yonto.log('warn', 'the server answered HTTP 404');
    throw yonto.error.notFound(params.ids ?? params.ac);
  }
  if (response.status === 401 || response.status === 403) {
    yonto.log('warn', `the server answered HTTP ${response.status}`);
    throw yonto.error.unavailable(SERVER_REFUSED_MESSAGE);
  }
  if (response.status < 200 || response.status >= 300) {
    yonto.log('warn', `the server answered HTTP ${response.status}`);
    throw serverDidNotAnswer();
  }
  const body = bodyText(response);
  let page;
  try {
    page = site.dialect === 'xml' ? parseXmlPage(body) : parseJsonPage(body);
  } catch (error) {
    if (error instanceof LooksLikeIndexError) {
      yonto.log('warn', 'the address answered with a TVBox/XPTV index, not a MacCMS page');
      throw yonto.error.misconfigured(INDEX_ADDRESS_MESSAGE);
    }
    if (refusesSearch(params, body)) throw noSearch();
    yonto.log('warn', `the server answered 200 with something unreadable: ${error?.message ?? error}`);
    throw yonto.error.unavailable(SERVER_UNREADABLE_MESSAGE);
  }
  // It said it failed, which is a refusal and not a failure to answer: a build that answers
  // `code 0` to a search with no matches would otherwise rest the source the viewer is reading
  // for finding nothing.
  if (page.failed) {
    if (refusesSearch(params, page.message)) throw noSearch();
    yonto.log('warn', 'the server used code 0 to say it failed');
    throw yonto.error.unavailable(SERVER_FAILED_MESSAGE);
  }
  return page;
}

/**
 * A search answered with 暂不支持搜索, as plain text or as a failure envelope's `msg`: a build
 * with no search, which is neither an unreadable answer nor a failure to try again later. Only
 * where the page is not a real answer, so a title that happens to say it cannot be taken for one.
 */
function refusesSearch(params, text) {
  return 'wd' in params && SEARCH_REFUSED.test(text);
}

function noSearch() {
  yonto.log('info', 'the server has no search');
  return yonto.error.unavailable(NO_SEARCH_MESSAGE);
}

/**
 * The body in the charset the server said it used.
 *
 * Plenty of MacCMS sites serve GBK, and a host decodes as UTF-8 unless told otherwise — which
 * is the whole reason `yonto.text.decode` exists. It takes the bytes, so this is the one
 * place a response's `bodyBase64` is read rather than its `body`. Header names arrive
 * lowercased from both hosts.
 */
function bodyText(response) {
  const charset = str(response.headers?.['content-type']).match(CHARSET)?.[1];
  if (!charset || /^utf-?8$/i.test(charset)) return response.body;
  return yonto.text.decode(response.bodyBase64, charset);
}

/**
 * `URL` does not exist in QuickJS, so the query is edited as text — keeping every parameter the
 * address already carried, and replacing one it names again.
 */
function withParams(url, params) {
  const [withoutFragment, fragment] = splitOnce(url, '#');
  const [base, query = ''] = splitOnce(withoutFragment, '?');
  const pairs = query === '' ? [] : query.split('&').filter(Boolean);
  const set = Object.entries(params).filter(([, value]) => value !== undefined && value !== null);
  const names = new Set(set.map(([name]) => name));
  const kept = pairs.filter((pair) => !names.has(pair.split('=')[0]));
  const added = set.map(([name, value]) => `${name}=${encodeURIComponent(value)}`);
  const all = [...kept, ...added];
  const rebuilt = all.length === 0 ? base : `${base}?${all.join('&')}`;
  return fragment === undefined ? rebuilt : `${rebuilt}#${fragment}`;
}

function splitOnce(text, separator) {
  const at = text.indexOf(separator);
  return at < 0 ? [text, undefined] : [text.slice(0, at), text.slice(at + separator.length)];
}

// ---------------------------------------------------------------------------- the dialects

/** Thrown by [parseJsonPage] where the body is a TVBox/XPTV index rather than a MacCMS page:
 *  its own class, since a viewer's mistake and an unreadable server answer read as the same
 *  `JSON.parse` failure otherwise and need different sentences. */
class LooksLikeIndexError extends Error {}

/** The JSON dialect: a `list` of `vod_*` objects, and a `class` tree on an `ac=list` answer. */
function parseJsonPage(body) {
  const page = JSON.parse(body);
  // `sites` is the TVBox/XPTV index's own array (kangzj/lantern-tv#1075): no MacCMS build
  // answers with that key, so its presence — not merely an empty `list` and `class` — is what
  // tells the two apart.
  if (Array.isArray(page?.sites)) throw new LooksLikeIndexError('a TVBox/XPTV index, not a MacCMS page');
  const list = Array.isArray(page?.list) ? page.list : [];
  const classList = Array.isArray(page?.class) ? page.class : [];
  const classes = classList
    .map((entry) => ({
      id: str(entry?.type_id),
      name: str(entry?.type_name),
      // Absent on plenty of builds, and absent is not the same as top level: a site that says
      // nothing about parentage is read by the seed rule instead ([topClasses]).
      parentId: entry?.type_pid === undefined || entry?.type_pid === null
        ? undefined
        : str(entry.type_pid),
    }))
    .filter((entry) => entry.id !== '' && entry.name !== '');
  const vods = list.map(vodFromJson).filter(isNamed);
  return { failed: saysItFailed(page, vods, classes), message: str(page?.msg), vods, classes };
}

/**
 * Whether a body is MacCMS saying it could not do what was asked.
 *
 * `{"code":0,"msg":"数据获取失败"}` is the failure envelope, and it parses to no titles and no
 * classes — an empty but successful answer, until this. It is the cheapest thing a broken mirror
 * can return, and an empty source is the failure `doctor` exists to catch.
 *
 * Read narrowly on purpose: `1` is the success code every MacCMS documents, but this is a format
 * with forks, and a build answering `200` or spelling the field another way would be refused by a
 * stricter rule. So the code alone never condemns a body: a site has to have said it failed *and*
 * handed over nothing.
 */
function saysItFailed(page, vods, classes) {
  const code = page?.code === undefined || page?.code === null ? null : str(page.code);
  return code !== null && code !== '1' && vods.length === 0 && classes.length === 0;
}

/**
 * One of their `vod_*` records, in the fields this reads.
 *
 * `content` is kept as the markup it arrives as: only a detail screen shows a synopsis, and
 * reading one costs a parse — see [plainText].
 */
function vodFromJson(vod) {
  return {
    id: str(vod?.vod_id),
    name: str(vod?.vod_name),
    typeName: str(vod?.type_name),
    poster: str(vod?.vod_pic),
    year: str(vod?.vod_year),
    rating: ratingOf(str(vod?.vod_douban_score), str(vod?.vod_score)),
    genres: str(vod?.vod_class).split(GENRE_SEPARATOR).map((genre) => genre.trim()).filter(Boolean),
    content: str(vod?.vod_content) || str(vod?.vod_blurb),
    remarks: str(vod?.vod_remarks),
    hitsWeek: wholeNumberOf(str(vod?.vod_hits_week)),
    playLines: playLines(str(vod?.vod_play_from), str(vod?.vod_play_url)),
  };
}

/**
 * The XML dialect (`at/xml`): an RSS-shaped `<list><video>` with play lines as `<dd flag>`,
 * read with `yonto.xml.load` along the paths FongMi's `Result` (`@Root(name = "rss")`)
 * binds — `list > video`, `class > ty`, and a video's own `dl > dd` — so a `<video>` nested
 * in another is not a title, and its fields are not the outer one's (kangzj/lantern-tv#601).
 *
 * It has no failure envelope, so nothing here is ever [saysItFailed].
 */
function parseXmlPage(body) {
  const $ = yonto.xml.load(body);
  // 暂不支持搜索 or an HTML error page: a lenient parser answers "no titles" for both, which
  // has the site look healthy and empty. So the check is explicit.
  if ($('rss, list, video, class').length === 0) {
    throw new Error('not a MacCMS XML page');
  }
  const classes = $('class > ty').toArray()
    .map((ty) => ({ id: str($(ty).attr('id')), name: $(ty).text().trim(), parentId: undefined }))
    .filter((entry) => entry.id !== '' && entry.name !== '');
  const vods = $('list > video').toArray().map((video) => vodFromXml($, $(video))).filter(isNamed);
  return { failed: false, message: '', vods, classes };
}

function vodFromXml($, video) {
  const text = (tag) => video.children(tag).first().text().trim();
  return {
    id: text('id'),
    name: text('name'),
    typeName: text('type'),
    poster: text('pic'),
    year: text('year'),
    rating: undefined,
    genres: [],
    content: text('des'),
    remarks: text('note'),
    hitsWeek: 0,
    playLines: video.children('dl').children('dd').toArray().map((dd) => ({
      flag: str($(dd).attr('flag')),
      episodes: episodes($(dd).text()),
    })),
  };
}

function isNamed(vod) {
  return vod.id !== '' && vod.name !== '';
}

/** Every scalar in their JSON may be a number, a null or an object. */
function str(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

/** A site that has no score for a title says "0.0", not nothing — or "10.0", which no real
 *  rating is either. */
function ratingOf(...candidates) {
  return candidates.find((candidate) => {
    if (candidate === '') return false;
    const score = Number(candidate);
    return Number.isFinite(score) && score > 0 && score < 10;
  });
}

function wholeNumberOf(text) {
  const value = text === '' ? NaN : Number(text);
  return Number.isInteger(value) ? value : 0;
}

/** `vod_play_from` names the lines, `vod_play_url` carries each line's episodes, both
 *  `$$$`-separated. */
function playLines(from, urls) {
  const flags = from.split(LINE_SEPARATOR);
  const lines = urls.split(LINE_SEPARATOR);
  return flags
    .slice(0, Math.min(flags.length, lines.length))
    .map((flag, index) => ({ flag: flag.trim(), episodes: episodes(lines[index]) }));
}

// `name$url#name$url`; a site may leave the name out, in which case the episode's position
// stands in for it.
function episodes(line) {
  return line
    .split(EPISODE_SEPARATOR)
    .map((entry, index) => {
      const at = entry.indexOf(EPISODE_NAME_SEPARATOR);
      const name = (at < 0 ? '' : entry.slice(0, at)).trim();
      const url = (at < 0 ? entry : entry.slice(at + 1)).trim();
      return url === '' ? null : { name: name || String(index + 1), url };
    })
    .filter((episode) => episode !== null);
}

/**
 * A synopsis as text: their `vod_content`, and the XML dialect's `<des>`, are markup.
 *
 * Read with `yonto.html.load` — real cheerio — rather than a copy of the regex decoder three
 * other plugins carry (kangzj/lantern-tv#350, #332).
 *
 * `&amp;` is unwrapped one level first, which is the one thing a parse cannot do for itself: a
 * site that double-encodes writes `&amp;nbsp;`, which cheerio correctly decodes to the *text*
 * `&nbsp;` and stops (kangzj/lantern-tv#328). One level and no further, because a query string
 * is full of `&` and a title is allowed to contain one.
 *
 * Only `getMediaDetail` reads a synopsis, so the parser's compile is paid once per title opened
 * and never on a listing.
 */
function plainText(markup) {
  if (markup === '') return '';
  const decoded = yonto.html.load(markup.split('&amp;').join('&')).root().text();
  return decoded.replace(WHITESPACE, ' ').trim();
}

// ---------------------------------------------------------------------------- the shapes

/**
 * The classes worth a category: the ones with no parent.
 *
 * `type_pid` when the site sends it, the MacCMS seed ids when it does not, and nothing when
 * neither applies. No rule here returns the whole flat list: Home asks for a shelf per category
 * at once, and 61 concurrent requests to one CMS is a Home that fails rather than one that is
 * full.
 */
function topClasses(classes) {
  if (classes.some((entry) => entry.parentId !== undefined)) {
    return classes.filter((entry) => entry.parentId === TOP_CLASS_PID);
  }
  return classes.filter((entry) => SEED_TOP_CLASS_IDS.indexOf(entry.id) !== -1);
}

/** What the 分类 filter offers inside a category: that class's children where the site says
 *  which are which, and the whole tree where it does not — so every class stays reachable
 *  either way. 最新 belongs to no class, so it offers all of them. */
function classesUnder(classes, classId) {
  if (isLatest(classId) || !classes.some((entry) => entry.parentId !== undefined)) return classes;
  return classes.filter((entry) => entry.parentId === classId);
}

/** What the site's words say a title is, or undefined where they say neither. */
function statedType(vod) {
  if (SERIES_REMARK_HINTS.some((hint) => vod.remarks.includes(hint))) return 'SERIES';
  if (vod.typeName.includes(MOVIE_TYPE_HINT)) return 'MOVIE';
  if (SERIES_TYPE_HINTS.some((hint) => vod.typeName.includes(hint))) return 'SERIES';
  return undefined;
}

function extensionOf(url) {
  const path = splitOnce(splitOnce(url, '?')[0], '#')[0];
  const last = path.slice(path.lastIndexOf('/') + 1);
  const dot = last.lastIndexOf('.');
  return dot < 0 ? '' : last.slice(dot + 1).toLowerCase();
}

function streamOf(url) {
  return { url, mimeType: extensionOf(url) === HLS_EXTENSION ? 'application/x-mpegURL' : 'video/mp4' };
}

/**
 * Lines are kept in the site's order, each one's episodes in a row, so the detail screen's 线路
 * choice and Up Next both follow the CMS's own grouping. Lines that would need a web parser are
 * left out while a direct one exists; a title with only those keeps them, since some do redirect
 * to a stream and the player will say if not.
 */
function playbackOptions(vod) {
  const lines = vod.playLines.filter((line) => line.episodes.length > 0);
  const direct = lines.filter((line) =>
    line.episodes.some((episode) => DIRECT_MEDIA_EXTENSIONS.has(extensionOf(episode.url))));
  const chosen = direct.length > 0 ? direct : lines;
  return chosen.flatMap((line) =>
    line.episodes.map((episode) => ({ label: episode.name, stream: streamOf(episode.url), line: line.flag })));
}

function hasALineOfSeveral(options) {
  const perLine = new Map();
  for (const option of options) perLine.set(option.line, (perLine.get(option.line) ?? 0) + 1);
  return [...perLine.values()].some((count) => count > 1);
}

/** A card. Its id is the site's own vod id, bare. */
function summaryOf(vod) {
  const summary = { id: vod.id, title: vod.name, type: statedType(vod) ?? 'MOVIE' };
  if (vod.poster !== '') summary.posterUrl = vod.poster;
  if (vod.year !== '') summary.year = vod.year;
  if (vod.rating !== undefined) summary.rating = vod.rating;
  return summary;
}

/**
 * The first of everything that answers to one id, in the order it arrived: `BrowseScreen` and
 * `SearchScreen` key their lists on the id, and Compose throws on a repeated key.
 */
function uniqueById(items) {
  const seen = new Set();
  return items.filter((item) => (seen.has(item.id) ? false : seen.add(item.id)));
}

// ---------------------------------------------------------------------------- the contract

export default {
  /** The site's own top-level classes, under its latest. */
  async getCategories() {
    const page = await ask(server(), { ac: CLASSES_ACTION });
    return uniqueById([
      { id: LATEST_CATEGORY_ID, name: LATEST_CATEGORY_NAME },
      ...topClasses(page.classes).map((klass) => ({ id: klass.id, name: klass.name })),
    ]);
  },

  /**
   * The classes under the one being read, as the single 分类 group. A category with no children
   * answers `[]`, which is what a category with no filters looks like.
   */
  async getFilters(categoryId) {
    const page = await ask(server(), { ac: CLASSES_ACTION });
    const options = uniqueById(classesUnder(page.classes, str(categoryId))
      .map((klass) => ({ id: klass.id, name: klass.name })));
    return options.length === 0 ? [] : [{ id: CLASS_FILTER, name: CLASS_FILTER_NAME, options }];
  },

  /** One page of a class, or of the site's latest when the category is its 最新. */
  async getMediaList(categoryId, options) {
    const site = server();
    // The filter wins over the category: both name a class, and the one the viewer chose in
    // front of them is the later answer. An empty filter is no choice at all.
    const chosen = str(options?.filters?.[CLASS_FILTER]) || str(categoryId);
    const page = Math.trunc(options?.page ?? 1);
    const answer = await ask(site, {
      ac: TITLES_ACTION[site.dialect],
      t: isLatest(chosen) ? undefined : chosen,
      pg: String(page >= 1 ? page : 1),
    });
    // An empty page is answered as an empty page: page two of a category that has one page is
    // empty and correct.
    return uniqueById(answer.vods.map(summaryOf));
  },

  /**
   * One title, with every episode of every line it offers — MacCMS hands back `vod_play_url`
   * with the stream URLs already in it, so one request is the whole detail.
   */
  async getMediaDetail(mediaId) {
    const site = server();
    const vodId = str(mediaId);
    if (vodId === '') throw yonto.error.notFound(mediaId);
    const page = await ask(site, { ac: TITLES_ACTION[site.dialect], ids: vodId });
    // Matched, and matching is the whole of it: a site that ignores `ids` and answers with its
    // own latest would otherwise open some other title under the id a viewer pressed, and a
    // watch-history row would resolve to whatever that site put first today.
    const vod = page.vods.find((candidate) => candidate.id === vodId);
    if (vod === undefined) throw yonto.error.notFound(vodId);
    const options = playbackOptions(vod);
    // Refused rather than answered with an empty `playbackOptions`, which reads as a title with
    // nothing to play. A record with no `vod_play_url` is a row the site has not filled in yet.
    if (options.length === 0) throw yonto.error.unavailable(noTracksMessage(vod.name));
    const detail = {
      ...summaryOf(vod),
      genres: vod.genres,
      synopsis: plainText(vod.content),
      playbackOptions: options,
    };
    // Where the site's words say neither, a line with more than one episode is a series: the one
    // thing a detail knows that a card did not.
    if (statedType(vod) === undefined && hasALineOfSeveral(options)) detail.type = 'SERIES';
    return detail;
  },

  /**
   * The site's own search, over `wd`, one page because ours is one page. A source its repo says
   * does not search (`searchable: 0`) is answered without asking the server, as TVBox and FongMi
   * do (Jasper, 2026-09-23).
   */
  async search(query) {
    const site = server();
    if (!site.searchable) throw yonto.error.unavailable(NO_SEARCH_MESSAGE);
    const page = await ask(site, { ac: TITLES_ACTION[site.dialect], wd: query });
    return uniqueById(page.vods.map(summaryOf));
  },

  /**
   * No CMS has a ranking call, but every JSON title carries its weekly hits, so the latest page
   * ordered by them is the nearest thing to one. Only titles with artwork, since this is a hero.
   * A failure is no ranking rather than an error: Home's shelves say what went wrong.
   */
  async getRecommendations() {
    const site = server();
    const page = await ask(site, { ac: TITLES_ACTION[site.dialect], pg: '1' }).catch(() => null);
    if (!page) return [];
    return uniqueById(page.vods
      .filter((vod) => vod.poster !== '')
      .sort((a, b) => b.hitsWeek - a.hitsWeek)
      .map(summaryOf))
      .slice(0, RECOMMENDATION_COUNT);
  },
};
