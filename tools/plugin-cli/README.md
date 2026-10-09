# yonto-plugin

Write, run, diagnose and package a Yonto content-source plugin, from a Mac, a PC or Linux.
Nothing here needs an Android SDK, an emulator or a device.

It is written in the app's repository rather than its own, for the same reason `server/` is: it implements the `yonto.*` host API, and the Android app implements the same surface.
The two have to change together, and `conformance/` is what proves they did.
It is published, MIT-licensed, with `contracts/` and the format plugins in yonto-app/yonto-player-plugins, by a one-way export (`tools/public-repo/export.sh`; `docs/agents/releases.md` says when).

## Using it

```
node src/cli.js init   <id> [--template <name>] [--name <display name>]   a new plugin in ./<id>, from templates/<name> (blank, video-blog)
node src/cli.js lint   <plugin-dir>            manifest and bundle checks, no network
node src/cli.js run    <plugin-dir> <method> [args…]   one method, its JSON, its requests
node src/cli.js doctor <plugin-dir>            the full battery, exit code for CI
node src/cli.js doctor <repo-url>              a 仓, XPTV or Yonto index read as a television reads it,
                                                or the repos a 多仓 or 多线路 list names
node src/cli.js link   <plugin-dir>            sign in to a linkLogin plugin's service with a code:
                                                eval "$(node src/cli.js link <plugin-dir>)"
node src/cli.js bundle <plugin-dir>            esbuild -> the publishable .js, a zip of it + sha256
node src/cli.js index  <plugins-dir> --base-url <url>   an index of the plugins there, as JSON
node src/cli.js index  --check <file-or-url>   an index's schema, then each plugin it lists downloaded and held to it
```

`index` writes the document `contracts/index.schema.json` describes: the 仓/XPTV envelope, each plugin a `type` 50 entry with `ext.yontoType` `plugin` and its payload in `ext.config` (`contracts/yonto-types/plugin.schema.json`), listed at `<url>/<id>/<id>-<version>.zip` with the sha256 `bundle` printed.
It bundles into a directory of its own, never a plugin's `dist/`, which is Gradle's.
`index --check` is `doctor` for a repo, and what a third-party repo author runs: it refuses a plugin entry with no sha256, a download that doesn't match it, a manifest whose id, version or contract isn't the entry's, a `yontoType` that is neither a short id nor reverse-DNS, and a Yonto entry typed `"50"`, and reports every one rather than the first.
It reads the document through `src/index-reader.js`, the reader the app's is held to, and what that reader only skips it reports and does not refuse: an entry of a type no reader takes, one with no http address, a 仓 spider, and a key an earlier entry already has.
Every plugin entry is fetched and held to its sha256, one a reader passes over included, and one that can't be fetched or doesn't match fails the check.
An index address or file path carrying its own `#sha256=` is checked before anything it lists is fetched.

`<plugin-dir>` defaults to the directory you are in, for `run` as for the others, and `--help` prints the full usage.
`--record` writes every response to `<plugin-dir>/fixtures/`, each cookie's value written as `redacted` since a fixture is committed; `--replay` serves them with the network off.
The host's own requests for a linkLogin — the account's server list, a server's identity, a sign-in — go to `fixtures/host/`, so a replay serves them to the host and never to the plugin.
With a session held, every value the host holds or made is written as a placeholder (`<credential>`, `<server-credential>`, `<host-client-id>`, and in the host's own fixtures a sign-in's id and code as `<pin>`), and a fixture one survives in anyway is not written: the run carries on, says which file, and exits non-zero.
`run` takes its arguments as JSON, so a string needs quoting twice: `run … search '"庆余年"'`, and one that is not JSON is refused with that quoting shown.
`npm test` runs everything with `node --test`, in a TMPDIR of its own that it removes afterwards (`scripts/run-tests.js`). It must pass with wifi off.

## Configuring a plugin you are running

A plugin whose `configSchema` has a `required` field cannot do anything without one — an XPTV catalog has no program until it is told where it lives, a Jellyfin has no server.
`run` and `doctor` read that config from two places, the second winning:

```
<plugin-dir>/doctor.json                        committed beside the plugin
YONTO_PLUGIN_CONFIG='{"serverUrl":"…"}'       for one run
```

`doctor.json` is the same idea as `probeQuery` in the manifest: what this plugin needs in order to be exercised, written down once instead of retyped by every author.
It is a development file — `bundle` packs the manifest and the source and nothing else — so a value written to match a fixture cannot travel to a television.
Keep it fixture-shaped for that reason: `plugins/jellyfin/doctor.json` names `jellyfin.example.com` and `fixture-api-key`, and `write-jellyfin-fixtures.js` reads that same file rather than holding a second copy of it, so the fixtures and the config cannot drift apart. **A real key belongs in neither file.**
`plugins/xptv-js/doctor.json` and `plugins/maccms/doctor.json` hold real addresses, and on purpose: a catalog's program and a MacCMS site are public, with no key in them, and the address is where the fixtures were recorded from.
A live `doctor` reaches them because `doctor.json` holds the address; `--replay` doesn't.

A value has to be a string, because a television has no other kind of answer to give — the editor's form fills in `yonto.config` from text fields. A number here would run on this host and on no other, so it is refused rather than quietly coerced.

A required field left empty is refused before the first call, naming the field — it used to reach the plugin as an empty string and come back as `not a URL:` once per step, which reads as a broken plugin rather than an unconfigured one.

## Signing in to a linkLogin

A plugin whose manifest declares `{ "type": "linkLogin", "service": "plex.tv" }` is signed in by the host, never by itself (`contracts/content-source-http.md`, *A login the viewer finishes elsewhere*):

```
eval "$(node src/cli.js link plugins/plex)"
```

`link` shows the code, the page to type it at and a countdown on stderr, asks the service until the code is linked, replaces one that expires, and stops after half an hour.
Its one line of stdout is `export YONTO_PLUGIN_SESSION='…'`, which `eval` puts in the shell's environment and nothing else records: not the scrollback, not the history, not a file.
`run` and `doctor` then hold that session as a television does: the host lists the account's servers for `yonto.session.servers()`, attaches each server's own credential to requests to its hosts, and masks every held credential out of what the plugin is handed and says.
The identifier the host gives the service is its own, derived from the plugin's directory, and never the plugin's `installId()`.

With no session, `doctor` on such a plugin makes one real start and one poll of the service, checks both against the rules every service's answers are held to, expects the poll to be pending, and reports each step that raises `unauthenticated` as ``not logged in: run `yonto-plugin link` `` rather than as a failure, unless the plugin raised it with `{ signIn: false }`, a refusal no login answers, which fails with its own words.
Under `--replay` it skips that check, since a sign-in is only ever checked live.
A report never prints a held credential, nor any service's credential header's value.

## What `doctor --replay` can answer, per plugin

It is the "did my change break a shipped plugin" check, and it is honest about where it cannot be.
The public copy of this file (yonto-app/yonto-player-plugins) has no `ddys` or `iyingshi`, nor `xptv-js`'s fixtures, `doctor.json` or `test/private/`, so those rows describe the app's repository only.

| plugin | fixtures | `doctor --replay` |
|---|---|---|
| `iyingshi` | 16 | green. The battery lists and pages the 纪录片 片库 its manifest's `probeCategory` names rather than 推荐, which has no page 2 (kangzj/yonto#556); `test/private/iyingshi.test.js` holds the rest of the 片库's paging, to its last page (kangzj/yonto#539) |
| `jellyfin` | 9 | green, using `doctor.json`; page 2 is skipped, since no fixture records it |
| `emby` | 13 | green, using `doctor.json`; recorded from a local Emby 4.10 in Docker with an API key, then moved to `emby.example.com` (`plugins/emby/AGENTS.md`). Page 2 is recorded as the empty answer it was |
| `maccms` | 5 | green, using `doctor.json` (lziapi, recorded by `doctor --record`) |
| `plex` | 9 | green, using `doctor.json`'s typed server: recorded from a real Plex Media Server, unclaimed so no token is in them (`plugins/plex/AGENTS.md`). With no server typed and no session (`YONTO_PLUGIN_CONFIG='{"serverUrl":""}'`) it names each step as not logged in; the linked path has no fixtures a replay can serve, since no Plex account exists |
| `xptv-js` | 16 | green except `search`, using `doctor.json` (独播库, one of three catalogs recorded under the retired `xptv` index plugin and copied across unchanged). `search` is red because 独播库's own page answered no rows for 画皮 when recorded. `test/private/xptv-js-doctor.test.js` runs the battery over all three catalogs, and `plugins/xptv-js/fixtures/PROVENANCE.md` says what each recording is |
| `ddys` | none | **cannot have any**: the site needs a session cookie and a cookie must never be committed, so `plugins/ddys/AGENTS.md` puts the JVM suite over `DdysPages` in its place |

`--replay` says which of those two it is rather than telling every author to `--record`, because for `ddys` that advice is wrong.


## What `lint` refuses, and what it only warns about

An `allowedHosts` entry is compared as a canonical host, so an entry that is not a host matches nothing — `999.999.999.999` has an octet over 255, `example.123` ends in a number and so is read as an address that fails to be one, `08` is a failed octal number rather than a decimal eight.
`lint` **refuses** those, because no manifest ever meant to write one and the run-time failure gives an author nothing: every request fails with `HOST_NOT_ALLOWED: 999.999.999.999 is not in this plugin's allowedHosts [999.999.999.999, …]`, a message whose list contains the entry that was supposed to match.

A private address is only **warned** about, because it is a real host an author may have had a reason for.

A `*.` entry is judged by what it can match rather than by what its suffix parses to: `*.1.1` is kept, because `hostAllowed` accepts by `host.endsWith('.1.1')` and `192.168.1.1` really does — while `*.1.2.3.4.5` is refused, since a dotted quad has four parts and a name may not end in a number.

- **`handles`** is held to `contracts/yonto-types/` (`src/yonto-types.js`), and every reason is named at once.
  A name outside `contracts/yonto-type-name.schema.json`'s grammar is refused by the manifest schema, which quotes the grammar.
  `lint` refuses a short id with no schema there, `plugin`, and a handler that exports `getSubSources`, declares `catalogsAreRemote` or says `provides: "source"`.
  It also refuses a `configSchema` missing a claimed type's required property, declaring a property as another field type than its `x-yonto-field`, or leaving a `const` out of a `choice`'s options.
  Somebody else's reverse-DNS type is not checked, because nothing here describes it.
- **`linkLogin`** is held to `contracts/link-logins.json` (`src/link-login.js`, and `LinkLogins.kt` on a television, both walked through `conformance/link-login/manifests.json`).
  `lint` refuses a service no host knows, an `allowedHosts` admitting any host the service's account lives on, exactly or through a `*.` entry, one declared twice, and one beside `hostsFromConfig`, `runsFetchedCode`, `handles`, a `cookieLogin` or a `browserCheck`.
  It refuses a call to `yonto.session` from a plugin with no `linkLogin`.

## `doctor` on a repo

Given an address rather than a directory, `doctor` reads the index there the way the app will (`src/index-reader.js`, held to the app's `IndexReader` by `conformance/index-reading/`): it asks with `User-Agent: okhttp/5.5.0`, which three disguised 仓s insist on, follows redirects, stops at 1 MiB and 30 s, takes off the disguise, and prints the dialect, every entry a source would be made of with its type, and what it skipped and why.
It fails when nothing in the document could become a source, the way an empty listing fails for a plugin.
It reads live and takes no `--record` or `--replay`; it does not yet run any entry through a handler, which needs the handlers (kangzj/yonto#615, phase 5), and it does not check a `#sha256=` on the address.

## What `doctor` is for

A plugin that silently returns an empty list is this project's most common failure — a site changes its markup and the plugin keeps "working", returning nothing, on a television, with no logcat.
So `doctor` walks the contract the way the app does, feeding each step from the one before, and **reports a successful-but-empty result as a failure rather than a pass**.

Five behaviours are deliberate and should not be "fixed":

- A step whose input never arrived is **skipped, not blamed**. If the listing came back empty, `getMediaDetail` had no id to ask for; calling it a bug would send an author hunting in the wrong function.
- A method the plugin does not export is **skipped**, and for the six in `conformance/optional-methods.json` — `getFilters`, `getRecommendations`, `checkHealth`, `getImageHeaders`, `onImageHeadersRefused`, `getSubSources` — that is not a failure. A source with no filters means an empty list and the app supplies one; `getImageHeaders` and `onImageHeadersRefused` are how a source says its artwork needs a header and is told that header was refused, and most sources need neither. The list is read rather than written here, because it was written in two places once and drifted (kangzj/yonto#330). This is what lets the contract grow without breaking a published plugin.
- Every failed or blocked request prints **the headers it actually sent**. A hotlink-protected host answering 403, and a CDN that 404s without a same-origin `Referer`, are both undebuggable without them.
- A step whose call said `yonto.partial(reason)` prints the sentence under it, marked `◐`, as a television shows it under the row; `run` prints it to stderr beside the answer. Only for `getMediaList`, `search` and `getMediaDetail`, and cleaned as a television cleans a line, so a sentence that is only control characters prints nothing (`src/partial.js`).
- Everything the plugin wrote to `yonto.log` is printed **under the step that provoked it, at every level**, marked `·` so it reads as the plugin's voice rather than as `doctor`'s `⚠`. A step reports what a call *returned*; the plugin's own line is often the only thing that says *why*, and it used to be thrown away. The XPTV loader is where that showed: every catalog whose program fails refuses in one sentence naming the catalog, and the line naming the cause — `fetch failed` against a site that has gone — went nowhere. Filtering `info` out is not an improvement; that level is where `index names 81, readable 81` lives, which is the one thing a `doctor` run on an index is being asked (kangzj/yonto#374, kangzj/yonto#360).
- **Loading is a step**, called `load`, and it is the only one that is not a contract method.
  Both hosts defer a module body to the first call, so a body that throws takes the whole run with it — and it used to leave the command with one sentence and nothing else, dropping the lines the body had already written and the clock warnings `doctor` had already worked out.
  A plugin whose module will not evaluate is the one whose own words are worth the most, so `✗ load` carries them the way every other step carries its own (kangzj/yonto#439).

It also says where a television will show something other than what came back, and only then.
A title carrying a control character or a bidi override gets `⚠ summary.title carries U+0001 in 2 of 20, which a television removes`, and a tab or line break in a one-line field is said to become a space.
What is cleaned, and in which fields, is `conformance/display-text.json`, the same record the app is tested against, so the warning cannot describe an app that no longer exists (kangzj/yonto#487).
And a filter group that opens on an option says which, under `getFilters`: `排序 opens on 最热 (hot)` (kangzj/yonto#526).

## The pieces

```
src/manifest.js      validate a manifest, naming the field at fault
src/contract.js      validate a method's answer, naming the JSON path
src/contract-version.js
                     the lowest contractVersion a plugin's own source can declare,
                     the newest any host speaks and the oldest any host runs
src/errors.js        PluginError + the code constants
src/build.js         the one silenced esbuild every command builds a plugin with
src/host/            the yonto.* surface a plugin sees
  fetch.js             allowedHosts enforced BEFORE the request reaches the transport
  crypto.js            md5/sha1/sha256/hmac, AES-CBC, base64, hex
  store.js             a per-plugin KV with a TTL
  index.js             assembles yonto.{config,fetch,store,crypto,encoding,text,sleep,now,log,error,session}
  session.js           yonto.session: the account's servers, and each server's bound credential
  link-sign-in.js      the one link sign-in engine, reading a service from contracts/link-logins.json
  mask.js              a held credential, masked in answers and redacted in what a plugin says
src/transport/       live · record · replay — one interface, three behaviours
src/engines/quickjs.js  bundles a plugin, runs it on QuickJS, calls one method
src/doctor.js        the battery
src/link-login.js    a manifest's linkLogin: the registry, what lint refuses, a link record's reach
src/link.js          `link`, and doctor's check of a service
src/index-reader.js  reads a 仓, XPTV or Yonto index, as the app's IndexReader does
src/repo-doctor.js   `doctor <repo-url>`: the bounded fetch and the report
src/format.js        the ✓/✗ report
src/bundle.js        esbuild + header + zip + sha256
src/header.js        the manifest in a plugin file's own opening comment
src/conformance.js   runs conformance/ and compares against expected.json
```

Each host function exists because real code in the app needs it, not because it seemed useful: `crypto` and `encoding` for the 仓 config decoder (base64, then hex, then AES-CBC), `text.decode` because plenty of MacCMS sites serve GBK, `store` because a 仓 config is kept on disk for three days.

## Things that will bite you

- **A plugin runs on QuickJS here, the same engine a television runs.** The engine bundles `<id>-plugin.js` with esbuild and evaluates it in QuickJS (`quickjs-emscripten`), not in Node — so `URL`, `URLSearchParams`, `TextDecoder`, `Buffer`, `console`, `setTimeout` and `Intl` are absent, and so is every regex feature and `Intl`-backed format QuickJS lacks. Reach for `yonto.sleep`, `yonto.now`, `yonto.log`, `yonto.text.decode` and `encodeURIComponent`.
`Date.now()` exists in the engine but nothing can wind it, so a rule measured in elapsed time reads `yonto.now()` instead — that is the clock both hosts hand in and both can move, and `doctor` warns if you reach for the global. That warning is a text search, so it fires on the call written in a comment too; over-reporting is the safe direction for a guard, and the lexer that told them apart was silently blind in three separate ways before this replaced it.
`lint`'s contract-version check reads the same sources and goes the other way, because it *refuses* rather than warns: over-reporting there would force an author to declare a version they do not need, and a plugin that declares too high refuses apps that could have run it. So it strips comments and string bodies first — and having been blind once itself, in a way that read a quote inside a regex as a string running to the end of the file, it hands the source back unstripped — and says so — when a quote is left open or an export cannot be followed. One string is read rather than stripped: a `yonto.error` code written out (`{ code: 'UNREACHABLE' }`, `fail('MISCONFIGURED')`) places the plugin where that constructor arrived, because a hand-built one is honoured like the constructor's and an older app turns either into `METHOD_THREW`. The code reaches a thrown value through too many shapes to recognise the raise, and missing one is the dangerous direction, so every such string counts except one the plugin only compares against (`===`, `!==`, a `case`); a legal comment counts nothing. Do not add a polyfill: a plugin that passes `doctor` has to be a plugin that runs.
- **`conformance/globals.json` is what proves the two builds agree.** The WASM build is not the build `quickjs-kt` ships, so the recorded device surface is asserted against this one on every run. `Atomics` is the one known difference — quickjs-kt's build enables it, the published WASM does not — and it is named in `test/engine.test.js` so a second one cannot appear quietly.
- **A call is bounded the way a television bounds it.** Its own JS may run for 20 s in all, added up over its runs; time spent waiting on `yonto.fetch` or `yonto.sleep` is not counted, so a plugin can still work on an answer that came back late. Once 20 s of wall clock have passed, a new `yonto.fetch`, `yonto.sleep` or `yonto.store` call is refused with `TIMEOUT`, but one already waiting is not cut. A request gets 15 s to connect, 20 s of silence while reading and 60 s in all, and a call that never settles is ended at 85 s. The numbers are in `conformance/limits.json`, which the device is held to as well.
- **A call crosses into the engine as JSON and its answer comes back as JSON**, the way `JsRuntime.call` hands QuickJS a string and reads one back. A method that returns a `Map`, a function or anything else JSON cannot carry loses it here exactly as it would there.
- **A 3xx is followed by the host, never by the transport.** undici is asked for `redirect: 'manual'` and so is OkHttp, and `yonto.fetch` walks the chain itself — because a redirect is otherwise the one way a request leaves the hosts a plugin is allowed to reach, and **the allowlist is checked again at every hop**. What that buys an author: `response.url` is where the body actually came from, `response.location` is where a 3xx points (resolved, because QuickJS has no `URL` to resolve `/elsewhere` with), `redirect: 'manual'` hands the 3xx back untouched, a POST redirected 301/302 (or anything but HEAD redirected 303) continues as a GET with no body and without the headers that described one, and `Authorization` and `Cookie` are dropped when a hop leaves the origin — another host, another port, or `https` to `http`. A chain longer than 20 hops, or 60 seconds, is `REDIRECT_REFUSED` rather than a spin. `src/host/redirect.js` and `PluginRedirect.kt` (with `PrivateHost.kt` for `isPrivate`) are the same rules twice, and `conformance/host-api` runs a real chain through both.
- **`hostsFromConfig` turns the allowlist off for the plugin that declares it, and it is not a shortcut.** A manifest may declare it only when the servers are named inside something the viewer pointed the source at — an XPTV catalog's program names sites no manifest could know. Then `allowedHosts` may be empty and nothing is checked, on either host. Every other plugin names its hosts, and a `url` config field is how a viewer's own server gets added; reach for that first. A plugin with the flag must send nothing of a viewer's to what its config names. Even then there is a floor: the device's own network — loopback, RFC1918, link-local, `.local` — is refused for such a plugin unless a viewer named that address themselves in a `url` field. `conformance/hosts-from-config` is a second suite for exactly this — it reaches a host no manifest names and follows a redirect to another — and is what holds the two hosts to one reading of the flag.
- **`runsFetchedCode` is a disclosure, not a permission, and `lint` cannot check it.** A plugin that downloads further code and runs it — `xptv-js` runs the catalog's JavaScript at `ext` — declares it, and the install dialog gains a line saying so. That is all it does: it grants nothing, it refuses nothing, and egress is still the two rules above. `lint` reads a plugin's own source, and the code this is about arrives while the plugin runs, so the version floor it raises is taken off the declaration alone and there is nothing here to catch an author who leaves it out. **Absent therefore means nobody said so, never that this tool found otherwise.** It costs `contractVersion` 11.
- **`playbackTokens` is the fourth manifest fact, and the one whose absence costs a title rather than a line.** A source that may answer a playback option carrying a `pan` share or a `track` token instead of a `stream` declares it, because nothing in its code says so — a returned shape is neither a call nor an export, which is the whole reason `MANIFEST_FACTS` exists. Unlike `runsFetchedCode`, an app too old for it does not merely say less: it decodes the option with `stream` required, so one share among forty episodes fails the whole detail. It costs `contractVersion` 12. **`lint` does refuse one thing here**: a plugin that exports `getStream` and does not declare the fact, because a `track` option is the only thing that would ever call it. The converse is not checkable and is harmless — a plugin declaring the fact and emitting no token has a floor it does not need.
- **The store is a cache.** Entries take a TTL and Settings' Clear cache empties every plugin's store, so keep a fetched document or a page there and nothing a viewer would mind losing — what they typed lives in their profile and reaches the plugin as `yonto.config`.
- **A redirect off `allowedHosts` is refused now, where it used to be followed.** The clients followed on their own before, checking nothing, so a plugin could be carried anywhere its source pointed. If a source 301s between domains — `example.com` to `www.example.com`, or a mirror — the manifest has to name both, or the configured `url` field has to hold the one that answers. This is the one behaviour change a published plugin can notice.
- **`Set-Cookie` never comes back in `headers`.** Two cookies folded into one comma-joined string cannot be split apart again, because an `Expires` date contains a comma — so the host drops `set-cookie` from `headers` and hands every value back as `response.setCookie`, an array, empty when there were none. This is the one header HTTP's own folding rule excepts, and the first thing a source that logs in will need.
- **A test that reads what is not published goes in `test/private/`**: the `ddys` or `iyingshi` plugin, `xptv-js`'s recordings or the site. The export leaves that directory out and runs the rest of `npm test` in the public tree on its own, so a test elsewhere that reaches one of them fails `export.sh --check`.
- **A fixture plugin must never live under a directory named `test`.** Node's default test patterns include `**/test/**/*.js`, so it would be executed as a test. They live in `test-plugins/`.
- **A temp directory is removed by the code that made it.** In a test, or for anything kept until the process ends, make it with `scratchDir` (`src/scratch-dir.js`), which removes it on exit and on a SIGINT, SIGTERM or SIGHUP nothing else listens for; `buildIndex` removes its own in a `finally`. `npm test` fails a run that leaves anything in its TMPDIR, naming what it found. Left alone, a directory per store per test piled up to 700,000 entries in the shared `$TMPDIR` and made every temp-dir creation crawl (kangzj/yonto#734).
- **`expected.json` must be byte-identical on a Mac and on a television.** No conformance case may derive its value from a clock, a locale, a path, or an unguaranteed ordering. That is why the concurrency case asserts ordering and not elapsed time — and why it cannot prove the fetches overlapped, only that `Promise.all` preserved input order.
- **Fixture identity is `sha256(url + "\n" + body)`.** Generate fixtures with `fixtureName`, never by hand, or a plugin's requests will not find them.
- **Do not sanitise a captured page.** The fixtures keep the ad network's scripts and both sidebars on purpose, so the leak assertions are live rather than vacuous.
- **`bundle` targets `es2020` / `platform: neutral`** because the output has to run in QuickJS, which has no Node builtins and no DOM. Do not "improve" those settings.
- **A plugin is one `.js` file, with its manifest in a `yonto-plugin` header comment.** `bundle` writes that file, plus a zip carrying exactly it — the zip is an inbound shim for whoever would rather send one thing than paste one, and nothing past the door ever sees one. The working tree keeps a `src/` folder so a plugin reads like any other JS package while it is being authored, and the entry file is the shippable artifact for any plugin that imports nothing, which is every one of ours.
- **The header is read as text, never by evaluating the module.** `allowedHosts`, `hostsFromConfig`, `configSchema`, `provides` and `contractVersion` decide where a plugin may go and what installing it does, so learning them by running it inverts the order those exist in.
- **`provides` says whether the plugin is a source or a kind of source, and it is required.** `"source"` means it knows its own address — ddys and iyingshi each name one site — so installing it writes that profile out of the manifest's own defaults and makes it active, asking nothing. `"source-type"` means the viewer names the instance, as a Jellyfin or a 仓 does, so installing it ends on the form where they can and there may be several. Declared rather than read off `configSchema`, because a plugin whose fields are all optional may still want each source added deliberately. `lint` holds the word to the truth from the other side: a `source` carrying a required field with no `default` is refused (a `bool` is never in that set: it is one of two strings and a device answers `false` for one nobody touched), since an install that promised to ask nothing cannot have a question in it.
- **A manifest key the schema does not know is refused**, at the top level, in a `configSchema` field and in a choice's option: `lint` names the key and the nearest known one, and an enum it refuses lists the values it takes. A typo such as `hostFromConfig` or `requried` otherwise lints green and silently means the opposite of what its author believes. The device stays lenient and drops the key, so a manifest from a later contract still installs on an older television; `contracts/README.md` has the split.
- **An empty `allowedHosts` is legal, and means "nothing but what a `url` config field contributes".** It is what a source with no site of its own declares — a Jellyfin lives only where its owner put it, unlike ddys, which has a real default site *and* a `siteUrl` field. A manifest with *no* `allowedHosts` key is still rejected: that is an author forgetting rather than saying none.
- **A plugin cannot invent an error code.** Only `NOT_FOUND`, `UNAUTHENTICATED`, `UNAVAILABLE` and `MISCONFIGURED` are honoured; anything else stays `METHOD_THREW`. The `PluginError` pass-through sits ahead of that check so a plugin cannot forge `HOST_NOT_ALLOWED` or `TIMEOUT` either.

## Writing a plugin

Start at the `write-a-source-plugin` skill (`.claude/skills/write-a-source-plugin/SKILL.md`): it has a skeleton that lints clean, the rules a manifest is held to, and the order to read the contracts in.

A manifest plus one ES module that default-exports the four required methods — `getCategories`, `getMediaList`, `getMediaDetail`, `search` — and any of the seven optional ones it needs (`contracts/content-source-http.md`'s *What it must export* has the table).
`plugins/iyingshi/` is the worked example for a site being scraped, and its `AGENTS.md` shows what a plugin should carry about that site; `plugins/jellyfin/` is the worked example for a third-party API and for a server the viewer names.

Set `probeQuery` in the manifest to something the source actually has, or `doctor`'s search step will report an empty result that is really just a bad query.
`doctor` lists and pages the first category `getCategories` answers; if that one has no second page (a 推荐 shelf), set `probeCategory` to the id of one that does, or the next-page step passes without asking anything. A plugin whose categories depend on the active catalog has no fixed id to name, and leaves it out.

### What a viewer's answers look like

`configSchema` is the form the app draws for a source built on this plugin, and the answers arrive as `yonto.config`, keyed by field id.
Every value is a string, whatever the field's type: a `bool` is `'true'` or `'false'`, a `choice` is the id of an option the manifest still lists (a saved answer naming one a later version dropped is treated as unanswered), and a `url` arrives normalised the way the app normalises every address a viewer types — a scheme filled in when it was left off, because `192.168.1.50:8096` is what gets typed on a remote.

**`'false'` is a truthy string**, so compare a bool to `'true'` rather than testing it: `if (yonto.config.adult)` is true with the switch turned off.

A text, secret, url or choice field a viewer left blank is **absent**, not empty, so `yonto.config.siteUrl || DEFAULT_SITE` is the idiom for a field with a fallback.
Declare `required: true` for one that has none, and the form will not save without it.
A bool has no blank state — it is always one of its two strings — so `required` means nothing there.

### Paging a listing

Most sites page by number, and a plugin for one needs nothing here: answer `getMediaList` with an array and read `options.page`.

For a source whose API hands out an opaque token instead, declare `"pagination": "cursor"` in the manifest and answer with a page:

```js
return { items, nextCursor: next };   // null only when there is no page after this one
```

The host hands that token back as `options.cursor` when it asks for the page the token names, so `options.cursor` is either **absent — meaning the first page** — or a token this plugin issued for exactly the page being asked for.
Never both anything else: being asked for page 5 with no cursor cannot happen, because a host that holds no token walks there from the page it does hold.

The one rule that buys: `nextCursor` must be null **only at the end of the listing**, since that is how a host knows the walk is over.

It costs no contract version: every host that runs plugins has paged by cursor since version 1.

`doctor` always asks for page 2, the way a television would: by number, or with page 1's cursor when the manifest declares `"pagination": "cursor"` (kangzj/yonto#331).
An empty page 2 passes, since that is a category that fits on one page.
A page 2 that answers page 1 again fails, and so does a cursor handed straight back: Browse drops titles it has already shown and stops when nothing new arrives, so a television silently shows that category cut short.
A `nextCursor` from a plugin that does not declare cursor paging is refused, because a television pages it by number and never hands the cursor back.
Under `--replay`, a page 2 nobody recorded is skipped, not blamed, including when the plugin caught the missing fixture and raised its own error.

A `url` field is also the one thing that widens `allowedHosts`, and only to the host of the value a profile actually carries — the port and the case are not part of it, and neither is any suffix.
A `default` reaches that value by being shown in the form and saved with it, never on its own: a plugin nobody has configured reaches only the hosts its manifest names.
Give a plugin that talks to a self-hosted server exactly one `url` field and read every address off it; a hostname that arrives any other way is refused with `HOST_NOT_ALLOWED`.
