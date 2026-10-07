# The conformance suite

`host-api/` is not a content-source plugin.
It is a probe: `getCategories` calls every `yonto.*` host function once and returns what it got back, one case per function.

Any host claiming to run Yonto plugins must produce `host-api/expected.json` exactly when it runs `host-api/<id>-plugin.js` over the fixtures in `host-api/fixtures/`.
The Node CLI proves this through `test/conformance.test.js`, which replays those fixtures through `createNodeEngine` and diffs the result against `expected.json`, case by case.
The Android runtime proves the same thing through a JVM test in Plan 2, which loads this same `conformance/` directory and asserts the same file.

That is the whole point of this suite: a host function added to one implementation and not the other has nowhere to hide.
Either it never gets exercised — and the day someone writes a plugin that needs it, the other host breaks in production — or the two implementations disagree on what it returns, and this suite is what catches that before a plugin author does.

The `concurrency` case's name overstates what it proves: `expected.json` has to be byte-identical on every host, so nothing in it may depend on a clock, and it can only assert that `Promise.all` preserved input order, not that the three fetches genuinely ran concurrently — a host that ran them one at a time, in order, would pass it just as well.

## `config.json`

What a plugin reads as `yonto.config` for what a viewer's form answered: a schema with one field of each type, and cases of what was answered and what the plugin is handed.
`test/config.test.js` walks it against the CLI's `src/config.js`, and `PluginConfigRecordTest` against the device's `PluginConfigForm.validate`.
They disagreed on an empty answer, on whitespace and on a bool that was neither word until kangzj/yonto#414; a row is added when another answer turns out to matter.

## `host-config.json`

What a plugin reads of a profile's saved values: only what its `configSchema` declares, so a saved answer to a question the plugin stopped asking reaches it on neither host.
`test/config.test.js` walks it against the CLI's `configOf`, and `PluginHostConfigRecordTest` against the device's `PluginManifest.configFor`.

## `globals.json`

The same idea for the language rather than the host API: the names a plugin may reach for without `yonto.`, recorded from the QuickJS runtime that actually runs one on a television.

`core/src/androidHostTest/.../QuickJsGlobalSurfaceTest.kt` asks the device runtime for `Object.getOwnPropertyNames(globalThis)` and asserts this file, so an engine upgrade that adds or drops a global fails a test instead of drifting quietly.
`src/engines/quickjs.js` asserts its own engine against the same file, because the WASM build of QuickJS the CLI runs is not the build `quickjs-kt` ships — so this file stopped describing what V8 had to hide and became the proof that two QuickJS builds agree.

Re-record it only for a deliberate engine change, with `-Dyonto.writeGlobals=true`, and read every added and removed name before committing.

## `yonto-type-names.json`

Which strings are a Yonto type name, by `contracts/yonto-type-name.schema.json`, the one grammar a manifest's `handles` and an index's `ext.yontoType` both `$ref`.
`test/yonto-types.test.js` walks it against the schema and against `handles`.
It exists because the two had a pattern each and disagreed on five of seven names (kangzj/yonto#646).

## `hostnames.json`

The canonical host of a URL, one recorded answer per spelling — the same idea as `globals.json`, for extraction rather than for the language surface.

A host has many spellings and one meaning: `http://127.1/`, `http://2130706433/`, `http://0x7f000001/` and `http://0177.0.0.1/` all reach loopback, and every gate a request passes asks about the host rather than the URL.
So each host extracts once, and this file is the answer both are held to — `test/hostname.test.js` walks it against the CLI's `hostOf`, and `PluginHostnameConformanceTest` walks it against the device's.

It exists because the two hosts disagreed.
WHATWG's `URL` folds all four spellings above and OkHttp's `HttpUrl` folds none of them, so one manifest had its fetch refused on a laptop and allowed on a television — the CLI/device split running backwards, with loopback at the end of it.

A `null` means the string names no host at all: the fetch fails as `REQUEST_INVALID` (or `REDIRECT_REFUSED` for a URL a server redirected to) and the string widens no allowlist.
That covers a scheme neither host will fetch and a host that ends in a number without being a valid IPv4 address, which is not a domain name either.

Add a row when a spelling turns out to matter.
Never edit one to match a host that changed — a row that has stopped being true is either a bug in that host or a change to `contracts/content-source-http.md`, and both are decisions rather than a re-record.

## `repo-typed-hosts.json`

The typed host of a repo's address, one recorded answer per spelling: the one private host a repo's values may reach (see `private-floor/`'s repo sub-suites).
The device reads it with `PrivateFloor.typedHostOf` (a scheme filled in, then `hostOf`) and the CLI with `typedHostOf` (`hostOfEntry`), two routes to one answer, so `PrivateFloorTypedHostConformanceTest` and `test/repo-typed-hosts.test.js` hold each to this file.
Its rows are the spellings a viewer can type: no scheme, a port, a bare `[::1]`, an uppercase host, a root dot, userinfo, a hex address, a scheme neither host fetches.

## `host-functions.json`

Which functions a host provides, by the dotted path a plugin calls one by — the names, where `host-api/expected.json` covers the answers.

It exists because the two hosts must agree on what the surface *is*, not only on what each function returns — `host-api/expected.json` covers the answers and says nothing about a function neither host was asked for. Anything deciding whether this build can run a given plugin needs that list in hand rather than enumerated: the decision is made before a host is built, and on the Android side before any JavaScript has run. Two hosts holding their own copies can each be green while the copies disagree, and a plugin would then pass `doctor` on a laptop and be refused on a television.

So this file is the one answer, and each host is held to it by its own running `yonto`: `test/host.test.js` walks the Node host's, and `JsHostApiConformanceTest` walks the one the Android host installs in QuickJS. Both walks recurse, so a namespace added below the two levels the surface has today cannot be invisible to them and absent from here at the same time.

Leaves only. `crypto` is a namespace rather than a function, and `config` is a value, so neither is listed or declarable.
`session.*` is a linkLogin plugin's alone, so both walks are made on one, and each host also holds a plugin with none to having no `yonto.session`.

Add to it when a host gains a function, in the same commit that adds the function to both hosts.


## `optional-methods.json`

Which of a plugin's own methods a host may find absent and carry on.

The odd one out here, and worth saying so: every other file in this directory records
something about a **host**, and is replayed against both of them. This one records something
about the **contract's plugin surface**, and is read by one side and asserted by the other —
`tools/plugin-cli/src/doctor.js` reads it to decide which missing export is a failure, and
`PluginOptionalMethodsTest` holds the device to it by building a plugin without each method
in turn and calling the one that went. There is nothing to replay.

It exists because the list was kept twice and drifted: `doctor` refused a plugin without
`getFilters` that the adapter has always defaulted to an empty list, and 爱影视 carried a
`getFilters` returning `[]` written only to get past it (kangzj/yonto#330).

Editing it is editing what the app tolerates, so the two move together: add a name here only
when the adapter really does answer without it, and the JVM test will say which of you is
wrong.

## `display-text.json`

What the app does to a source's display text before a viewer sees it — the characters it removes, the ones it turns into a space in a one-line field, and which fields of which answer get which treatment.
`src/doctor.js` reads it to warn an author, and `DisplayTextRecordTest` holds `SourceText.kt` and `ContractDtos.toDomain()` to it both ways round: every field listed is cleaned, and no field left out is.
Change the app and this file together; the test fails on either alone.

## `partial/`

What a host shows for `yonto.partial` after a sequence of calls: the last sentence wins, a blank one (as Kotlin's `isBlank` says, which U+FEFF is not) or one that is not a string takes it back, each call starts with none, a call that throws keeps none, only `getMediaList`, `search` and `getMediaDetail` show one, and it is cleaned as a line first.
`calls.json` is the record and `partial-plugin.js` the plugin it is walked through; `test/partial.test.js` walks it through the CLI's host, engine and `partialShown`, and `PluginPartialRecordTest` through the device's adapter.
The two hosts' `run`, `doctor` and screens got these rules separately the first time, and the CLI printed sentences a television never shows (kangzj/yonto#357).

## `request-rules.json`

What `yonto.fetch` refuses to send and what it changes before sending: the WHATWG Fetch standard's forbidden methods, method normalisation, forbidden request-headers, credentials in a URL, a GET or HEAD with a body, and the `Content-Type` of a string body, with the three forbidden headers a plugin may still set (`Cookie`, `Origin`, `Referer`) and why.
The CLI reads it at run time (`src/host/request-shape.js`); the device keeps the same lists in `PluginRequestShape`, and `PluginRequestRulesRecordTest` holds them to this file.
Both hosts walk every case and a generated case for every entry of every list through their own `yonto.fetch` (`test/request-rules.test.js` and that JVM test), so an entry added here is checked on both before it can drift.
It exists because the two transports each refused their own set, as `REQUEST_FAILED`, and a list kept by hand missed some every round (kangzj/yonto#651).

## `limits.json`

The numbers that bound a plugin's requests and answers, the same on both hosts: the most of a response body `yonto.fetch` hands over, the most of its unread bodies one call keeps for `bodyBase64`, and how deep a call's answer may nest.
The CLI's `src/host/fetch.js`, live transport and engine read them, `ResponseBodyLimitRecordTest` holds the device's `PluginHttpTransport.MAX_BODY_BYTES` and `MAX_UNREAD_BODY_BYTES` to them, and `PluginAnswerDepthRecordTest` its `JsRuntime.MAX_ANSWER_DEPTH`.

## `answer-depth/`

How deep a call's answer may nest: as deep as `limits.json`'s `answerDepth` is read, and one level deeper is `METHOD_THREW` in the device's sentence, refused before either host parses it, and the call after answers.
It exists because on iOS reading an answer 300 deep on a coroutine's small stack killed the app, which Kotlin/Native cannot catch.
`calls.json` is the record, run in order on one runtime, and `answer-depth-plugin.js` the plugin; `test/answer-depth.test.js` walks it through the CLI's engine and `PluginAnswerDepthRecordTest` through the device's runtime.

## `fetch-body/`

What a plugin reads of a response's body: `bodyBase64` is the bytes, asked of the host on first read and only during the call that fetched it, a body of exactly the limit comes through whole as text and bytes, one byte more is `RESPONSE_TOO_LARGE`, a body that does not decode still reads both ways at 10 MB, the most a television's realm holds of one, a call keeps its newest unread bodies up to `unreadBodyBytesPerCall` and the ones it dropped read as late, and a NUL byte is a character of `body` like any other.
`calls.json` is the record, run in order on one runtime, and `fetch-body-plugin.js` the plugin; `test/fetch-body.test.js` walks it through the CLI's engine and `PluginFetchBodyRecordTest` through the device's runtime (kangzj/yonto#333).

## `clearances.json`

What `yonto.fetch` does with a browser check's clearance the host holds: on the one site it was won at, per redirect hop, its cookies merged into the plugin's `Cookie` by name and its `User-Agent` over the plugin's, and its cookie names withheld from `setCookie`; nothing on another host, a subdomain, the same host over `http`, a site the manifest no longer covers, or the `cookieLogin` site, where the session wins.
Each case gives the manifest, the clearance, the plugin's headers and what each URL answers, and says the `Cookie` and `User-Agent` each hop carried and the `setCookie` the plugin was handed.
`test/clearance.test.js` walks it through the CLI's `yonto.fetch` and `PluginClearancesRecordTest` through the device's (kangzj/yonto#359).

## `link-login/`

A link sign-in, on both hosts: `contracts/link-logins.json` read by one engine, and what a linked plugin is handed (`contracts/content-source-http.md`, *A login the viewer finishes elsewhere*).

- `manifests.json`: which manifests' `linkLogin` a host runs, and the words for every rule one breaks. `lint` refuses with them; a television, which runs no `lint`, reads the capability as absent.
- `sign-in.json`: the requests the engine makes for a service, and how it reads each start and each poll, every rule and clamp included. Its cases name `plex.tv`, or one of its own `declarations`, which exercise what the engine reads that Plex's does not (an interval and a QR in the answer, outcomes told apart by a field). The Plex start and pending poll are recordings (2026-09-25, no account; the pin's id and code and our identifier replaced, the location blanked); a linked poll is written from Plex's documentation and says so.
- `discovery.json`: what a discovery answer becomes, the servers with no credential field and the hosts each server's credential is bound to. Its resources answer is written from Plex's documentation and says so, since no account exists to record one.
- `masking.json`: each spelling of a held credential, masked in what the plugin is handed and redacted in what it says.
- `reach.json`: whether a session linked under a record may still be used by the plugin as it is now.
- `attach.json`: where `yonto.fetch` sends a server's credential, over which of the plugin's headers, what goes from that hop, and what the plugin is handed back.
- `host-api/`: a probe of `yonto.session` and `yonto.fetch` for a linked plugin, run as `host-api/` is. Its `session.json` is the account credential the host holds, and `fixtures/host/` answers the host's own requests.

`test/link-login.test.js` and `test/conformance.test.js` walk them through the CLI's host; `LinkLoginsRecordTest`, `LinkSignInRecordTest`, `LinkBindingRecordTest`, `CredentialMaskRecordTest`, `LinkRecordRecordTest`, `PluginSessionAttachRecordTest` and `JsHostApiConformanceTest` through the device's.

## `raised/`

What a call that throws ends in: the code the caller is handed and, where the plugin's own code stands, its message.
Each `yonto.error` constructor is honoured, `unreachable` stands whether or not a host function failed in the same call (it is the plugin's word, not a host code), and a code no host knows is `METHOD_THREW`.
A `yonto.fetch` or a store write the plugin lets through ends in the host's own code: `REQUEST_FAILED` for a server that did not answer, `REQUEST_INVALID` for a request built wrong, `REDIRECT_REFUSED` for a chain the host gave up on, `RESPONSE_TOO_LARGE` for a body over the limit and `STORE_REFUSED` for a value the store will not keep, which is what holds each host's list of the codes it lets out of a call. Each host code also has a forged case, which a plugin cannot claim.
`raised.json` is the record and `raised-plugin.js` the plugin it is walked through; `test/raised.test.js` walks it through the CLI's engine, and `PluginRaisedRecordTest` through the device's runtime.
It exists because a code missing from one host's honoured list reads there as an ordinary outage, and `host-api/`'s `error*` cases only build each error without throwing it (kangzj/yonto#615).

## `host-verdicts/`

Where a call's code comes from: a host code stands only where a host function answered that same call with it, which each host records outside the plugin's realm, and a wrong argument is the plugin's own `TypeError` in one set of words (kangzj/yonto#342).
`getCategories` records what each bad argument and each host refusal says, `name: message`, and the runner then calls each method `calls.json` lists, in order on one runtime, recording the code it ended in or `answered`: the code only, since each host words its own `METHOD_THREW`.
The calls are #613's forgeries: a plugin's own throw with a host code, with `__host`, or with an `InternalError` that says `interrupted`; a real verdict recoded, or kept for a later call; the realm's `WeakSet`, `indexOf`, `includes` and `JSON.stringify` rewritten; and the call wrapper replaced, which is why that case runs last.
Beside them, the host's own verdicts stand, rethrown or not, and so does an over-budget sleep's `TIMEOUT`.
`test/conformance.test.js` runs it through the CLI's engine and `JsHostApiConformanceTest` through the device's runtime.
It exists because the CLI believed a `__host` marker any plugin could set, and passed Node's own messages through, after the device had stopped doing either.

## `limits.json` and `call-budget/`

What bounds a call and its requests.
`limits.json` is the numbers: the JS a call may run, the margin its wall-clock ceiling adds, and one request's connect, idle-read and whole-request timeouts.
The CLI's engine and live transport read them from there, and `CallLimitsRecordTest` holds `JsLimits` and `NetworkModule` to it.

`call-budget/` is the behaviour, scaled down so it runs in seconds: a loop that yields to the host between short bursts is cut once its bursts add up to the budget, a call that waits three budgets on the host and then works finishes, a loop after a long wait is cut one budget into itself, a call that answers with a request still out ends only once that request and the work on it are done, and a first call pays for the module body's JS. Each spin runs on a little past its time, so a thread descheduled across the deadline still meets an interrupt check.
`test/call-budget.test.js` walks `calls.json` through the CLI's engine and `CallBudgetRecordTest` through the device's runtime, timing each call.
The CLI cut the whole call at the budget until kangzj/yonto#513, so `doctor` failed a fan-out whose answers came back after it while a television counted them.

## `exported-then/`

A plugin that exports `then`, which makes its module namespace a thenable: a `then` that never returns, and two that hand back an object or a Proxy whose reads never return.
Both hosts import the namespace statically, the CLI through a loading module as `JsRuntime`'s bootstrap does, so no promise is ever settled with it and the `then` never runs; each case loads and answers.
Each case is its own plugin under `<case>/`; `test/exported-then.test.js` walks them through the CLI's engine and `ExportedThenRecordTest` through the device's runtime.
The CLI used to settle the plugin's own evaluation promise, which ran the `then`, and the last two hung it for good (found in review of kangzj/yonto#630).

## `private-floor/`

A plugin may not reach the television's own network because its manifest asked to — see contracts/content-source-http.md's "The private-address floor".
This suite is that rule, asserted on both hosts: a manifest-named private address is refused, a `url` field's `default` that a viewer never changed is refused, and the address a viewer actually typed is reached.

Two of the six cases are worth understanding before editing them.

`manifestNamedOddly` carries both halves of the fix at once.
The manifest names loopback as `0x7f000001` and the request writes it as `2130706433`, so the entry genuinely *does* permit the request — and the floor refuses it anyway.
A host that classified before folding the spelling would name a different address in the message, and one that never folded would let the fetch through.

`redirectOffTypedHost` is the per-hop half.
A viewer typing `http://192.168.1.50:8096` exempts that host and not the LAN behind it, so a hop from it to `192.168.1.1` is refused — a host that checked the floor only on the first hop would pass every other case here and fail this one.

The refusal messages are asserted, not just the codes, because the message carries the canonical host and that is what proves both hosts folded a spelling the same way before deciding anything about it.

Its fixtures are hand-written. `192.168.1.50` does not answer on any machine that runs this suite, which is rather the point.

Its two sub-suites run the same probe as a catalog made from a repo, which is what their `origin.json` says: the keys the viewer typed, and the repo's address as the viewer typed it (both hosts' runners read it; a suite without one is an ordinary plugin profile).
Every other value is the repo's word, which makes its host reachable and passes the floor only on the repo's typed host.

- `repo-on-the-lan/` is a repo typed as `http://0xc0a8013c:8080/index.json`, which is `192.168.1.60`: a value on that host passes on another port, a value on `192.168.1.61` is refused, a hop from the typed host to `192.168.1.61` is refused, a value the viewer typed is reached, and a public value is reached while a host nobody named is not. The address is written in hex so that a host comparing it as a string, rather than as a host, refuses the repo's own server.
- `repo-redirected/` is a repo typed on the open web whose fetch landed on `192.168.1.62`. The typed host is the literal one, before redirects, so a value on `192.168.1.62` is refused.
- `repo-typed-host-listed/` is a repo typed on `192.168.1.60` whose manifest lists `192.168.1.60` and whose values name only a public host: a request to the typed host is refused, because the exemption is a repo value on the typed host, never the typed host itself. With `repo-on-the-lan/`, whose manifest lists nothing and reaches the typed host through a repo value, it pins that rule from both sides.

The floor on the repo's own fetch is not a plugin's, so it is not here: the device holds it with `PrivateFloorTest` and the CLI with `test/repo-doctor.test.js`.


`resolved-name/` holds the rule that only the host as written is floored (Jasper, 2026-09-26, kangzj/yonto#974): each of its names resolved into the viewer's network when it was recorded, and both hosts reach it anyway, while the literal spellings beside them (IPv4, the IPv4-in-IPv6 forms, `10.0.0.1`, `127.0.0.1`, `localhost`, `x.local`) are still refused.
It runs a `hostsFromConfig` plugin, so no allowlist is in play and the floor is the only thing deciding.

## `index-reading/`

One reading of every index document, for the two readers of one: the app's `content/repo/IndexReader.kt` and the CLI's `src/index-reader.js` (docs/design/2026-09-23-the-app-reads-every-index.md, *The reader*).
Each file is a list of cases: a document (`body` as text, or `bodyBase64` for an image disguise), the dialect it is read pinned to when a repo already has one, and `expected`, which is the dialect, how many entries it named, every entry a source could be made of (key, name, yonto type, address and the config its handler is handed) and the rest counted by why they were skipped; `list` when it is a 多仓 or 多线路 list of repos instead (how many it named, each repo's name and address, and what was skipped as having no address or as named twice); or `refused` when it is neither.
`test/index-reading.test.js` walks it against the CLI's reader and `IndexReaderTest` against the app's.

Every case says where it came from in `about`.
The `recorded-*` files are real documents: box.iqinu.com and an hjys PNG as kangzj/yonto#594 recorded them (cut to the fields tvbox reads, which dropped `spider`, so they are read pinned to a 仓), XPTV's `allinone.json` as the retired `plugins/xptv`'s fixtures recorded it, 老刘备 from the same place cut to the fields read (the rest held a stranger's `user$$$pass`), and two re-cut from kangzj/yonto#572's survey, where the served bytes were first unwrapped and wrapped again to themselves with the real key, iv, image and marker.
`recorded-urls-list.json` is a 多线路 list as victor1616888/TVBOX-Q served it on 2026-09-24, whole, since none of its addresses carries a login (kangzj/yonto#786).
`synthetic.json` is written by hand, one rule a case, and says so.

Add a case when a document turns up that the two readers could read differently; never edit an `expected` to match a reader that changed.
