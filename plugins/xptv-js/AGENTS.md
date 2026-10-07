# xptv-js plugin

The handler for the `xptv-js` Yonto type: **one XPTV catalog**, a stranger's JavaScript program at `ext`, fetched, compiled with `new Function` and handed XPTV's twelve names over `yonto.*`.
It reads no index.
A repo is read by the app, and each `type: 3` entry of an XPTV index the viewer picks becomes a source of its own that runs on this handler with the entry's fields as `yonto.config` (`docs/design/2026-09-23-the-app-reads-every-index.md`).

It is the loader of `plugins/xptv`, the index plugin that came before the app read indexes itself, lifted out whole, with the index, the entry list, the resting marks and the MacCMS reader left behind (the last is `plugins/maccms`).
`plugins/xptv` was retired on 2026-09-24 without ever being publicly released (kangzj/yonto#615, phase 8), and what it had learned about the loader, their plugins and the live runs of 2026-09-22 is written up here.
The study behind the loader is `docs/design/2026-09-22-what-xptv-does-with-plugins.md` and its design `docs/design/2026-09-22-running-xptv-plugins.md`; both are dated records of the plugin this came out of.

**Bundled, and run only once a viewer has agreed to its `ext`**: see *Where it runs*.

## The config

The `xptv-js` type's schema is `contracts/yonto-types/xptv-js.schema.json`.

| field | type | what it is |
|---|---|---|
| `ext` | `url`, required | the catalog's program, labelled *Program address*. An XPTV entry's `ext`, never its `api` |
| `className` | `text` | the entry's `api` (`csp_wogg`), labelled *Class name (optional)*: it names the implementation, so two mirrors of one plugin share it. Used only to name the catalog in a log line |

An `ext` that is not http(s) is `misconfigured`, and nothing is fetched.
Nothing here knows the catalog's name, and nothing needs to: the app's headline names the source, and a source is one catalog, so each sentence names the part that failed (*this source's program* / *website*) rather than the catalog.
The labels and sentences are English in every language, as MacCMS's are (kangzj/yonto#1309): a manifest carries one language.
Names that sit among a catalog's own Chinese ones stay Chinese: the 网盘 and 线路 lines, and 未命名 for a title with no name.

## What it answers

| ours | theirs |
|---|---|
| `getCategories` | `getConfig().tabs`, or `getTabs()` when those are empty. A catalog with none says it has only search (*This source has no categories to browse. Use search instead.*), which is `tianyiso.js` working correctly, not broken |
| `getFilters` | the `filter` on a `getCards` page, since theirs arrive inline with a listing. The page is thrown away |
| `getMediaList` | `getCards`, with `page` and the chosen `filters` put **into the tab's `ext`**: 45 of their 48 read `ext.page`, and the five that filter read `ext.filters` |
| `getMediaDetail` | `getTracks`: every episode a `track` option, their groups our 线路, every share a `pan` option on a 网盘 line of its own |
| `getStream` | `getPlayinfo`, asked about the one track that was pressed: `urls[0]` and `headers[0]` |
| `search` | their `search`, with the query under `text`, page one |
| `checkHealth` | loads the program as every path does, and says it is usable when that worked (*`checkHealth` loads the program*) |

Not exported, each on purpose: `getSubSources` and `catalogsAreRemote` (one entry is one source, and `lint` refuses both on a handler), `getRecommendations` (XPTV ranks nothing, and Home falls back to page one of each category), and `getImageHeaders` / `onImageHeadersRefused` (a `hostsFromConfig` plugin cannot have signed artwork).

**A share is the app's to open, and this handler names no drive and filters by no host.**
A track carrying a `pan` becomes `{ label, pan: { share }, line: 网盘 }`, the URL exactly as the catalog wrote it, whichever host it is on.
Which drive that is, and whether this build speaks it, is the app's `Drives` registry's to decide: `ContentRepository` leaves a share no shipped client claims off the title's page and says how many it left off (kangzj/yonto#565), so `tianyiso.js`'s 天翼 links and `ddys.js`'s UC links opened with nothing changed here once clients for both landed (kangzj/yonto#477, #505).
A host list here would be a second copy of that registry, stale on every drive that lands.
A `pan` that is not an http(s) URL (a magnet, a link with the 提取码 pasted after it) is dropped with a `warn`, because no drive could be read off it.
The label is the track's own name; the share's host is added where the catalog gave several shares one name (欧哥 names a title's 百度 and 夸克 shares identically, and the app hides one of them), and stands in where it gave none.

**Shares go on a 线路 of their own, after the episodes**, because the app reads a title's episode count off its largest line and rolls Up Next within one: forty episodes and two shares on one line would be forty-two.
The line is 网盘, renamed (网盘2) rather than merged if a catalog titles an episode group 网盘; an episode group with no title gets 线路, so a mixed title always has two distinct lines, since `MediaDetailScreen` offers the chooser only then and counts `''` as a line.
A share counts towards neither the series inference nor the episode line.

**Two refusals, and which one a title gets is read off the title, never off the catalog**, because `ddys.js` answers both kinds off one page.
A title with no tracks at all says the catalog has nothing; a title whose every track is unusable (tokens over the bound, shares that are not URLs) says the playback address cannot be read.
It refuses rather than answering an empty list, because a source that quietly returns nothing reads as a site that changed its markup, which is why `doctor` reports a successful-but-empty result as a failure.
On a catalog whose titles are only shares, the detail answers `pan` options and `doctor` skips `getStream` with nothing to redeem, which is not red (kangzj/yonto#465).

**`stream.headers` are checked here, because the host refuses a stream whole over one bad header.**
`HeaderRule` (kangzj/yonto#444) wants a name that is an RFC 9110 token and a value that is printable ASCII, space or a tab, and one header breaking it costs the whole `getStream` answer.
Their `headers[0]` is what crosses, so `streamFrom` checks each header against the same rule and drops the ones that break it with a warning: `X-A\r\nInjected: y`, or a Referer carrying a Chinese path, costs that one header and the episode still plays.
The two patterns are the host's to the character, and `xptv-js-contents.test.js` holds them to the schema's.
Where a header goes is not checked: one this accepts still goes wherever the URL points.

**`checkHealth` loads the program, so the status line is a verdict.**
It runs what any path runs first: the program is read from the store or downloaded, compiled and run to the end of its module, and its `getConfig` is asked.
A dead address, a program that will not run, and a `getConfig` that could not reach the site each throw the same sentence the other paths do, and a program that loads is usable.
It does not ask for tabs, since a search-only catalog works.
The program is kept in the store on the way, so opening the source afterwards downloads nothing.
Settings probes every source, a repo's included, so this is the cost of a repo's dozens of catalogs: bounded by the app's pool of probes and by a verdict being fresh for ten minutes (`docs/agents/architecture.md`, *Source status*).
Until 2026-10-05 it asked nothing and the app never probed these sources, which left every catalog of an XPTV repo reading *Not checked in advance* (Jasper).

**A header the host owns is dropped from a catalog's request, with a log line, not sent.**
`yonto.fetch` refuses `Accept-Encoding`, `Sec-*` and the rest of Fetch's forbidden names whole (`REQUEST_INVALID`, contract: *What a request may carry*), and a native XPTV sends or ignores them: 星芽短劇 login sets `Accept-Encoding: gzip` and 在线之家's player request sets `Sec-Fetch-Dest`, and each lost the source over it.
An `X-HTTP-Method`, `X-HTTP-Method-Override` or `X-Method-Override` header goes only when its value names no forbidden method, as the host judges it.
The lists are copies of `tools/plugin-cli/conformance/request-rules.json`'s, and `xptv-js-catalogs.test.js` holds it to the file.

**A catalog's body is the catalog's own function scope**, so a `let $config = argsify($config_str)` (金牌影院) shadows the parameter we pass rather than redeclaring it, which at XPTV's global scope is legal and as a parameter is a SyntaxError.
A `var` of one of those names starts `undefined` here where XPTV's global would hold the value (`var $config = $config || {}`); none of the catalogs measured does it.

**Their `getConfig` runs before every path**, because their runtime calls it on load and 7 of their 48 do setup in there (`bdys.js` takes a cookie off a throwaway page and its later requests reuse it; kangzj/yonto#433).
Those seven are `bdys.js`, `czzy.js`, `hanime.js`, `javxx.js`, `missav.js`, `ppp.js` and `yunpan8.js`, measured 2026-09-22 as a `getConfig` body holding an `await` or a `$fetch`.
It is asked once per compiled catalog, which is the number their own player makes, and the categories read their tabs out of that same answer.
The 41 that only return the object pay a local call; the 7 pay the request their code expects, so a listing from `czzy.js` costs its homepage as well as the listing page.
A `getConfig` that fails is kept rather than raised: only `getCategories` needs its answer, so it rethrows there and the other five paths carry on without the setup, and it is asked again on the next call, as is one that ran while the site was down (*A site that is down*).
Rethrown rather than handed an empty config, because an empty one reads as a working search-only catalog.
Refusing every path instead, which is what their runtime does with such a plugin, was measured on #433's review against the pinned `czzy.js`: with its homepage refusing the connection, its search answered before and refused after, over a value search never reads, and four of the six catalogs `run-xptv-catalogs.js` found broken do work in `getConfig`.

**Learning the filters costs a listing, and that listing is thrown away.**
Handing it to the `getMediaList` that follows was tried and taken out: the app caches filters for a day and listings for fifteen minutes, so the parked page outlived the cache, and `doctor`'s listing step stopped checking anything of its own.

**A filter group's `init` is carried when it names one of the group's own options** (contract 13, kangzj/yonto#550), read the way an option's `v` is.
Their 全部 (`{ n: '全部', v: '' }`) is dropped from a group with no `init`, since the app draws its own *All* (kangzj/yonto#589), and kept in a group with one, where it is the only way back.
It goes by its name whatever its id, since ole's is `'0'` and its `getCards` reads `cateId || '0'` (kangzj/yonto#621).
Measured 2026-09-24 against all 48 of `fangkuia/XPTV`'s plugins: every 全部 is `''` except those two of ole's, and none sits in a group with an `init`, so the name is what they all mean by unrestricted rather than a guess from one.
A group with no `init` and no 全部 shows the app's *All* beside an option that may mean the same thing, and that is left alone: only `init` says what a missing key means, so the fix is the catalog declaring one (kangzj/yonto#713).
Reading the first option as the default would be right for ole's 排序 (`by = 'update'` in its code) and a guess for zxzj's (an empty slot in its URL), and those are the only two such groups in the 48.
A group keyed `page` is dropped, because the contract reserves the name.
Their rule *非法筛选值建议回退到 init* is not taken: our contract already guarantees the app only sends ids the source offered.

## The ids

| id | shape |
|---|---|
| category | the tab's whole `ext`, `JSON.stringify`'d |
| media | `{"e":<the card's ext>,"n":<its name>,"p":<its artwork>}` |
| track token | `{"t":<the track's ext>}` |

- **All three are JSON, with no prefix of this handler's own.**
- **A media id carries the name and artwork** because their `getTracks` answers no metadata at all, so everything the detail screen draws comes out of the id it was opened with.
- **The `e` and `t` envelopes tell the shapes apart**, and each reader refuses the others' id as `notFound` rather than asking a stranger's site about it.
  A token is read before the catalog is compiled, so a string that is not one never runs anybody's program.
- **A media id is budgeted at 1024 characters, and the artwork goes first.** A budget, not a cap: the `ext` is what `getTracks` is asked with, so one over budget on its own goes out with a `warn` rather than the title becoming unopenable. A real one runs about 230.
- **A token over the contract's 2048 is not an option at all**, never pruned or truncated, because the loader cannot know which fields their `getPlayinfo` reads.
  Measured against archived ddys.pro pages (the worst case, `ext: each`), tokens ran 702 to 860 characters.
  Both are counted in UTF-16 units, as JavaScript's `.length` and the app's `String.length` both count, never in code points or bytes, and `xptv-js-contents.test.js` holds that each is spent in full.
  Only the token has a contract bound; 1024 is this plugin's budget, not a cap.

## The store

| key | what | kept |
|---|---|---|
| `catalog:<ext>` | the catalog's source, written only once it has compiled and loaded, so a CDN's error page served with a 200 cannot refuse the catalog for a week | 7 days |
| `cache:<ext>` | the catalog's `$cache` map, one key for the whole map because the store cannot list keys | 7 days |

`<ext>` is the `ext` config value exactly as it arrives, trimmed.
`cache:<ext>` holds a catalog's logins too (`leijing.js` keeps its token there).
Keyed by address and never by class name, which two mirrors of one plugin share.
A source's store is its own (per source and handler id), so nothing here is shared between catalogs any more.

## The twelve names

A catalog is plain ES2017 with twelve injected names and the runtime's `console`, no DOM and no native networking.
Counts are from 20 of their plugins downloaded on 2026-09-22.

| theirs | here | seen in |
|---|---|---|
| `$fetch.get` / `.post` | `yonto.fetch`, answering `{ data, status, respHeaders }`; an object body is JSON, or a form when the catalog's `Content-Type` says `application/x-www-form-urlencoded` | 20 of 20 |
| `argsify` / `jsonify` | `JSON.parse` / `JSON.stringify` | 20 of 20 |
| `createCheerio()` | `yonto.html.load`, real cheerio | 19 of 20 |
| `createCryptoJS()` | `yonto.cryptoJs()`, the library | 8 of 20 |
| `$print` | `yonto.log`, prefixed `[<className>]`, URLs blanked | 6 of 20 |
| `$utils.toastInfo` / `.toastError` | logged, and the catalog carries on | 4 of 20 |
| `$cache.get` / `.set` / `.del` | a map over `yonto.store`, **synchronous** | 3 of 20 |
| `$config` / `$config_str` | `{}` and `'{}'`, **not** `yonto.config` | 2 of 20 |
| `$utils.openSafari` | asks for a browser check at the URL, `yonto.error.challenged`; a URL the host won't offer (not one, or not fetched in the call) is *unavailable*, with the reason only in the host's log | 1 of 20 |
| `loadJSEncrypt` | `yonto.jsEncrypt()`, the JSEncrypt RSA class (contract 20) | 1 of 20; 瓜子 and 壹影視 of the 21 in `VOD/TV.json` |
| `$utils.os()` / `.app()` | inert constants | 0 of 20 |
| `$html` | `elements`, `text` and `attr` over `yonto.html.load`; an element is its markup, so the next call parses it again, and a selector can match that element itself | 0 of 20 (1 of the 21 in `VOD/TV.json`, 4k-av) |
| `console` | `log`, `info` and `debug` to the log as info, `warn` and `error` as warn, prefixed `[<className>]` | 3 of the 21 in `VOD/TV.json` |

- **`$fetch` answers `data`, `status` and `respHeaders` and nothing else.** Across their 48 plugins' 173 call sites, `respHeaders` is read at 4 and `headers` at none (kangzj/yonto#426).
  `respHeaders` answers to any casing of a name, as HTTP does, and `respHeaders['set-cookie']` is the array `yonto.fetch` answers, the lossless form, because two cookies joined on a comma cannot be split again.
  XPTV's own value is a string, so the array also has a `split` that folds on a comma: `anime1.js` calls `.split(',')` on it, and `bdys.js` indexes it (anime1's stream threw until 0.2.3).
  No cookie is held here: `bdys.js` reads one off a response and puts it on its own next request out of its own closure.
- **A failed `$fetch` carries the host's code and not its message** (`REQUEST_FAILED`, `REQUEST_INVALID`, `REDIRECT_REFUSED`, `TIMEOUT`, `HOST_NOT_ALLOWED`, and `RESPONSE_TOO_LARGE`, listed ahead of kangzj/yonto#716, which adds it; a body too large is the site answering, so it keeps the program's sentence and marks nothing), because the message names the URL, search text and all, and catalogs rethrow it as their own words (`czzy.js`: `'请求失败: ' + e.message`).
- **`createCryptoJS` is the real library**, because their plugins use `AES.encrypt`, `mode.ECB` and `WordArray` objects, which a facade would answer with strings.
- **`$cache` is synchronous** because `leijing.js` reads its token with no `await`. The map is read before the body runs, answered from memory, and written back once at the end of the call that dirtied it, awaited, and in a `finally` around `getPlayinfo`.
- **`$config_str` is their plugin's own settings.** `tgs.js` reads `$config.channels` out of it; handing over `yonto.config` would give a stranger's code this source's config and still be the wrong shape.
- **A browser check keeps its sentence even at module scope**, which is where all three pinned plugins call `createCryptoJS()`. The ones this plugin raised are a module-local `WeakSet`, so a catalog's own `{ code: 'CHALLENGED' }` is not honoured as one. No shim refuses any more: `loadJSEncrypt` did until 0.3.0, when `yonto.jsEncrypt()` (contract 20) let it answer, so a catalog that uses it needs an app that has that.
- **Toasts log and carry on** (the call already worked, kangzj/yonto#357); **`openSafari(url, UA)` throws `yonto.error.challenged(url)`** (kangzj/yonto#830), which the host offers as a browser check where the catalog fetched that site in the call and reports as unavailable otherwise; the manifest's `fromConfig` browserCheck is what lets it. The catalog's agent is not taken, since the check runs under the WebView's own. It joins the refusals, so `answering` lets it past, and `configOf` raises it rather than keeping it as a failed setup. `$html` is deprecated in their own docs in favour of cheerio, and is answered anyway because 4k-av still reads it (it refused until 0.2.2); its three methods are inferred from that one plugin's calls, not from XPTV's source.

**A log line blanks every URL it can see and hides every secret it can name** (kangzj/yonto#566, #597).
Every line goes to logcat on a viewer's box, and `$print`, toasts and a message a catalog threw are a stranger's text, so they keep their words and lose their addresses as `<a URL>`.
A second pass hides the value of any `name=value`, `name: value`, `name：value`, `name＝value` or `name%3Dvalue` (`data[name]=value` too, and a value on the line after its name) whose name holds one of `SECRET_STEMS` as `<hidden>`, URL or not, and so does a bare `Bearer …`: no URL pattern can tell where a URL ends once its unencoded query holds a space.
A quoted value is hidden to its closing quote, a `{…}` or `[…]` value to its closing bracket, and a bare one to the next space, `&`, `%26`, `;`, quote or bracket, except after a name holding `cookie` or ending in `authorization` or `auth-token`, whose value runs to the end of the line.
A name only starts where a run of `[\w.-]` starts, and a scheme where a run of scheme characters does, because tried from every character of a long hex blob either pattern is quadratic (QuickJS took 3 to 18 seconds over 8k to 16k of one).
A name written in Chinese (`密码: …`) is left alone, and a URL-encoded address, a bare `www.` host or a secret under a name that says nothing goes through: it is best effort, and `doctor` still lists every request with its URL.

**Only `bdys.js` actually carries a cookie.**
It reads `respHeaders['set-cookie'][0]`, the array shape.
`leijing.js`'s four reads ask for the folded `Set-Cookie` as a string, so its guard is false, its `$cache.set` never fires and it browses with no cookie; its login path needs credentials nobody here has.
What #426 fixed for it is that it stops throwing on a property of `undefined`, not that it holds a session.
An ordinary header name's case is a separate question (the Kotlin host lowercases, the CLI passes the site's spelling through; kangzj/yonto#431), and inert for these 48.

**`$html` is used by nobody.** The one apparent hit is `muou.js`'s doc line listing the vendor's API, which recommends cheerio instead.

**`getTabs` is a seventh entry point**, declared by `czzy.js` alone, and asked when `getConfig().tabs` is empty. `getLocalInfo` is declared by none and has nothing to map (local files on somebody's phone).

**`lint` reads this plugin whole.**
The shims are explicit `yonto.x.y` references rather than `yonto` handed over as a value, so the contract-version scan sees the whole host surface; one `const { fetch } = yonto` would reduce its answer to a floor and a warning, and `test/cli.test.js` asserts there is no `⚠`.

## What a hostile catalog reaches

A catalog is a stranger's program run in this source's realm, and **nothing here is a sandbox**.
Measured 2026-09-22 under `quickjs-emscripten` (the CLI's engine), by running each route, and not under `quickjs-kt`, which is what a television runs.
Most of it would not move there: `new Function`, the function constructors and indirect `eval` reach the global object because the language says they do, `yonto` is a realm global on both hosts by a recorded decision, and the flat `__host_*` bindings sit beside it under the same names on both.

| route, with the shadowing in place | result |
|---|---|
| bare `yonto` | the loader's shim, not the host |
| `globalThis.yonto` | `TypeError` |
| direct `eval('yonto')` | the loader's shim |
| `this`, at the top of the body, without the fresh `this` | **the real global**: a `new Function` body is sloppy-mode |
| `(0, eval)('this')` | **the real global** |
| `new Function('return this')()` | **the real global** |
| `({}).constructor.constructor('return this')()` | **the real global** |
| `(function*(){}).constructor('return this')()` | **the real global** |
| `__host_installId()`, and every other raw binding, off a recovered global | **the host's own function** |

**The shadowing is hygiene.**
`yonto`, `globalThis` and every `__host_*` and `__yonto*` global are passed as `undefined` parameters, the twelve names are parameters rather than globals, and the body is called with a fresh `this` (kangzj/yonto#391).
The `__host_*` list is not hand-written: they are own, enumerable, writable properties of the global, so filtering `Object.getOwnPropertyNames(globalThis)` is the list and it cannot drift when a host adds a binding.
Shadowing them does not break the shims, because the loader's `yonto.fetch` resolves `__host_fetch` in its own scope, not the caller's.
That removes the accidental routes: the bare name, the property access, direct `eval`, the sloppy-mode `this`, and Yonto-aware code written against `yonto.*` because somebody copied one of our plugins.
It removes none of the deliberate ones: `new Function('return this')()`, `(0, eval)('this')` and the function constructors all reach the real global, and always will, since compiling a catalog needs `Function`.

So a catalog that goes looking reaches **this source's whole `yonto` surface** (`fetch` under its egress, the store read and write including `clear()`, `config`, `installId`, `log`), **`Object.prototype`**, this plugin's exports on the CLI, and **a forged host verdict** (`{ code: 'HOST_NOT_ALLOWED', __host: true }` is honoured by both hosts, kangzj/yonto#342).
It does not reach this plugin's module-scope variables, anything of the viewer's (the host holds every session and hands none over), the television's own install id (`yonto.installId()` is per plugin and profile), or anything Kotlin gates: the private-address floor, the 1 MiB install cap, the twenty-second call bound and the 64 MiB realm all still hold.
Measured, the store includes `clear()`, so one catalog can empty its own source's store, and a property set on `Object.prototype` is visible to the loader on the next line.
On the device the export table is a module binding rather than a global, but `__yontoExports` and `__yontoCall` are globals, read from the source there rather than run.
The forged verdict is **referenced here rather than fixed or accepted**: this handler does not make it worse, it makes it reachable by a stranger.
Nothing here may be described as a sandbox, and no later decision may rest on a catalog not reaching something on the list above.

**One catalog per source is the improvement #391 wanted, for data and not for egress.**
Under the retired index plugin a catalog shared its realm, store and `yonto.config` with every catalog of its index; here it has its own, and its `config` is its own `ext` and class name.
It still reaches any host.

`installId` is not offered as a name: XPTV injects none, and a stable per-source id is exactly what a stranger's code could attach to every request.
Re-deriving a per-catalog one would be worse, an identifier invented for code that never asked for one.
Absent from the shims is not absent from the realm (`new Function('return this')().yonto.installId()` returns the real one, measured), so the claim is only that a catalog has to go out of its way; making it true would be a host change, starting at #342's second half, the raw bindings being globals.

## Where it reaches, and who said yes

The manifest declares **`hostsFromConfig`**, `allowedHosts: []` and **`runsFetchedCode`**, and they are the design's reason it needs a dialog.

- **`hostsFromConfig` is the feature**: the sites a catalog scrapes are named inside its program, and no manifest can list them. It turns the allowlist off, not the floor.
- **The private-address floor still holds.** A catalog reaches a private address only on the host the viewer typed into `ext`, or, for one made from a repo, on the host the viewer typed as that repo's address when `ext` names it, and on any path there: #334's bet on literal hosts, at its sharpest.
- **`runsFetchedCode`** adds *Downloads and runs code you did not install* to a dialog (contract 11, kangzj/yonto#375). It is a self-declaration nothing can verify, since the code it is about arrives while the plugin runs: declared means the author said so and the viewer was told, and **absent means nobody said so**, never that a host found the plugin does no such thing.
- **Nothing of the viewer's is sent anywhere**, and nothing here may start.

### Where it runs

**Bundled since kangzj/yonto#615's phase 5 (app side)**, because the consent came with it. **Since kangzj/yonto#1076, the source editor no longer offers this handler as a new source** (`YontoTypes.OFFERED_BY_HAND` leaves `xptv-js` out): a lone XPTV catalog is one entry of an index, never something a viewer is handed on its own, so offering it invited an index address typed into `ext`. A repo still adds one, and an existing xptv-js catalog — always a repo's, now — still opens under this same handler and saves a `SourceConfig.Catalog`, asking on Save and on Test Connection, with *Reaches any site, not only what you configure* and *Downloads and runs code you did not install*, before it first runs for that source (`CatalogForm.reachToAsk`). The repo dialog is the other place it is asked.
The rule in `docs/agents/plugins.md` is now that nothing with unbounded egress runs until a viewer has answered a dialog that says so (Plex is its one named exception), and it is published with the other plugins.
The editor keeps an `ext` the viewer did not type byte for byte, and gives a typed one only a scheme, so `cache:<ext>` survives a Save.

## A site that is down (kangzj/yonto#579)

Their code never reads `status`, so a 5xx page reaches them as a page with nothing on it, and a rejected fetch comes out of their code like their own bug.
The loader keeps **the latest `$fetch`'s outcome for the call** and, when it was a failure, says *This source's website isn't available right now* where it would otherwise say the program is broken, the title has nothing, the search found nothing, the page is empty, the tabs are empty or there is no stream.

- **`REQUEST_FAILED`, `REDIRECT_REFUSED` or a 5xx, nothing else.** A redirect chain the host refused (too many hops, too long, a `Location` that is no URL) is the site's doing, and the program ran fine. A `TIMEOUT` is the call running out of time and the site may never have been asked (kangzj/yonto#560); `REQUEST_INVALID` is a request their code built wrong, so it keeps the program's sentence; a 4xx is the site answering, and a 404 on a title is a real "not there". `HOST_NOT_ALLOWED` is neither.
- **The latest fetch only**, so a fallback to a second mirror that answers 200 with nothing is "nothing found".
- **Cleared at the start of every call and again right before the entry point**, so the module body's and `getConfig`'s fetches are setup and count only for `getCategories`, whose answer `getConfig` is.
- The fetch that sets it logs why, by code and never by URL: `catalog <className>: a request answered HTTP 520`, `… a request got no answer (REQUEST_FAILED)` or `… a request was redirected in a way the host refused (REDIRECT_REFUSED)`.
- **It is `unavailable`, not the design's `unreachable`.** `unreachable` rests a catalog's server, and the one server this handler reaches for itself is the one holding the program, which moving says nothing about the catalog's own site (the design's *The new error*). So this handler raises it nowhere.
- **A `getConfig` that ran while the site failed is not kept**, even when it did not throw, and the next call asks again. A catalog that builds its tabs by scraping a 520 page returns empty tabs, and kept they would say the catalog has only search after the site came back (PR #617's finding 4).

There are no resting marks here: they were the MacCMS reader's, and the cooldowns are the app's now.

## What a call may spend

Twenty seconds on both hosts, and a first call pays for the program's download, its compile and a page inside it.
The compiled catalog is kept for the life of the runtime, and its source in the store for a week, so later calls pay for the page alone.

## Testing it

| | |
|---|---|
| `test/xptv-js-catalogs.test.js` | compiling a catalog, the twelve names, the log's blanking and hiding, the store keys, the shadowing, egress and the manifest |
| `test/xptv-js-contents.test.js` | their `getCards`, `getTracks`, `getPlayinfo` and `search` as our listing, detail, stream and search, filters, shares, headers, and the site that is down |
| `test/private/xptv-js-real-catalogs.test.js` | the three pinned plugins under `fixtures/catalogs/`, unmodified, against pages written in their sites' shape |
| `test/private/xptv-js-doctor.test.js` | the `doctor` battery over three real catalogs' recordings, paging, a chosen filter, and that no advertising reaches a field |

All offline.
The catalogs in the first two are written for the suites, because `fangkuia/XPTV` carries no licence; `fixtures/catalogs/PROVENANCE.md` and `fixtures/PROVENANCE.md` say what was committed anyway and why.

```
node tools/plugin-cli/src/cli.js doctor plugins/xptv-js --replay         # 独播库, from doctor.json
YONTO_PLUGIN_CONFIG='{"ext":"<a catalog address>"}' node tools/plugin-cli/src/cli.js doctor plugins/xptv-js
```

`doctor --replay` is green except `search`, which is 独播库's own page answering no rows for 画皮.

**The pinned three are a pin rather than a sample**: their plugins change fast, and a pinned copy is the only thing that can tell *our loader breaking* apart from *their file moving*.
They do not replace the written catalogs of the first two suites, and could not: no working plugin demonstrates a forged host verdict, a 200 that is not JavaScript, or two tabs colliding on one id, and four of the five defects the loader's first review round found were in exactly those.
To check them, or any of their 48, against what their repository holds today, which a pin cannot do:

```
node tools/plugin-cli/scripts/run-xptv-catalogs.js            # ddys.js, czzy.js, tianyiso.js
node tools/plugin-cli/scripts/run-xptv-catalogs.js muou.js    # or any other of theirs
```

It fetches, compiles and asks for the categories, serving nothing of their sites, and writes nothing to disk; it goes to the network, so it is opt-in and not part of `npm test`.
On 2026-09-22, 42 of the 48 compiled and answered a category list; `hanime.js`, `missav.js`, `ppp.js`, `tgs.js`, `tgs_xp.js` and `yunpan8.js` did not, each their own code meeting a decision recorded here (`tgs.js` is the `$config_str` row).

**What the live runs of 2026-09-22 said that a fixture could not** (kangzj/yonto#374), from twelve `type: 3` catalogs of `fangkuia/XPTV`'s `allinone.json`:

- `wogg.js`, the flagship, does not browse: `www.wogg.net` does not resolve, and the sentence a viewer met said the program would not run, which pointed at the one thing that was working. The `fetch failed` line went to `yonto.log` and `doctor` threw it away, which is why `doctor` now prints what a plugin said under the step that provoked it, and why *A site that is down* above exists.
- Seven of the twelve never reached a listing, every one for a reason on their side: `muou.js`, `aomi.js` and `wogg.js` reach addresses that no longer resolve, `yunpan8.js` one that accepts and never answers, `ystt.js` a site that 404s on every listing path, and `xzys.js` and `labipan.js` pages their own selectors find nothing in. A viewer pasting an index gets roughly half of what it names.
- `bdys.js`, `ole.js`, `zxzj.js`, `duboku.js` and `ouge.js` worked end to end; `ouge.js`'s 夸克 share was listed through the app on an emulator on 2026-09-23. `bdys.js` and `leijing.js` both read a genuine `Set-Cookie` live without throwing.
- `ole.js` signs every request with a fresh `_vv=`, so a replay of it is always a `NO_FIXTURE`; anything else that cache-busts belongs in the scripted suites.

## When something changes

- A catalog refuses with *website isn't available* → its last `$fetch` got no answer, a refused redirect or a 5xx; the log line just before says which.
- A catalog refuses with *program won't run* → it threw, or would not compile or load, and its last fetch did not fail that way; the `catalog … answered badly: …` or `… did not compile` line says what.
- A catalog refuses with *Can't download this source's program* → `ext` answered non-2xx or an empty body, or its download failed at the transport (no answer, a refused redirect, the call's time running out), which `catalog <className>: its program could not be fetched (<CODE>)` says by code and never by address.
- A catalog refuses with *program is too large to load* → its program is past the host's cap on a body (`RESPONSE_TOO_LARGE`, kangzj/yonto#716), logged the same way; unlike *Can't download* it doesn't say try again, since it will be as large next time.
- A new name of theirs → a row in `shimsFor`, and in the table above with how many of their plugins use it.
- A new entry point of theirs → `ENTRY_POINTS`, which `compileCatalog` guards with `typeof` so a catalog that does not declare it still compiles.
- Anything that changes an id or a store key → it strands the History rows and logins a box already holds for these sources, so weigh that before changing one.
