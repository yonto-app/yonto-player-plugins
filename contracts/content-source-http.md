# Content Source HTTP Contract (v1)

The app talks to exactly one content provider at a time through this contract.
The provider is a black box: any service that implements these endpoints
can be plugged in by pointing the app at its base URL — nothing in the app
needs to know how the provider stores, licenses, or sources its catalog.

If no base URL is configured, the app falls back to a small built-in catalog
of openly licensed demo videos (`SampleContentAdapter`) so it is always
runnable out of the box.

## Transport

- All endpoints are namespaced under `/v1` so the contract can evolve with a
  `/v2` without breaking existing deployments.
- Requests: `Accept: application/json`. Responses: `Content-Type: application/json`.
- Authentication (optional): `Authorization: Bearer <token>`, where `<token>`
  is configured alongside the base URL. Servers that don't require auth
  ignore the header.
- Unknown JSON fields are ignored by the client. New optional fields can be
  added to any response without a version bump.
- `type` fields are transmitted as plain strings, not a closed enum. An
  unrecognized value is mapped to a safe default (`MOVIE`) by the client
  instead of failing — this lets a server introduce new content types
  without breaking older app builds. A value the client *does* recognize is
  matched **case-insensitively**, so `SERIES`, `Series` and `series` are the
  same type to it; nothing is trimmed, so a leading or trailing space makes
  it an unrecognized value again.

## Endpoints

### `GET /v1/categories`

Top-level browse categories (e.g. genres, curated shelves).

```json
{
  "categories": [
    { "id": "action", "name": "Action", "thumbnailUrl": "https://.../action.jpg" }
  ]
}
```

`thumbnailUrl` is optional.

### `GET /v1/categories/{categoryId}/filters`

Optional. The ways a listing of this category can be narrowed, in the order
to offer them: each filter is a named group of mutually exclusive options.

```json
{
  "filters": [
    {
      "id": "genre",
      "name": "Genre",
      "options": [ { "id": "action", "name": "Action" }, { "id": "drama", "name": "Drama" } ]
    },
    { "id": "year", "name": "Year", "options": [ { "id": "2024", "name": "2024" } ] }
  ]
}
```

- `200` with `"filters": []` means the category offers none.
- `404` is treated the same way, so a server that predates this endpoint
  keeps working: the app shows the listing with no filters.
- A filter `id` must not be `page` — it becomes a query parameter of the
  media list, below. Option ids are opaque to the app and sent back verbatim.
- Only fetched when the user browses the category (never for the Home
  screen), and cached for the session.
- `init` (optional, contract 13) names the option a group's listing is
  already on, by one of that group's own option ids — a listing ranked by
  plays, a site that serves one region. The app opens the group on it and
  sends its id like any choice, and such a group has no "All": its listing
  is never unrestricted, so a source that has an unrestricted state offers
  it as an option. An `init` the group does not offer, or an empty one, is
  refused by the CLI and ignored by the app.
  A source still gets only ids it offered, so it does **not** fall back to
  `init` when handed one it does not recognise, as XPTV's scripts are told
  to: that would be defending against a host bug and hiding it.

### `GET /v1/categories/{categoryId}/media?page=1`

Titles within a category, paginated. `page` is 1-indexed; omit for page 1.

The user's choice in each filter group is sent as a query parameter named by
the filter `id`, holding the chosen option `id`: `?page=1&genre=action&year=2024`.
A group the user left on "All" is omitted; a group with an `init` always has a
choice, and it is sent. The app never sends an id it wasn't offered for that
category through the filters endpoint.

```json
{
  "items": [ /* MediaSummary, see below */ ],
  "page": 1,
  "hasMore": true
}
```

- `200` with `"items": []` and `"hasMore": false` signals the end of the list.
- `404` if `categoryId` does not exist.

### `GET /v1/media/{mediaId}`

Full detail for one title, including how to play it.

```json
{
  "id": "big-buck-bunny",
  "title": "Big Buck Bunny",
  "type": "MOVIE",
  "posterUrl": "https://.../poster.jpg",
  "backdropUrl": "https://.../backdrop.jpg",
  "year": "2008",
  "rating": "PG",
  "genres": ["Animation", "Comedy"],
  "synopsis": "A giant rabbit deals with three bullying rodents.",
  "playbackOptions": [
    {
      "label": "Play",
      "stream": {
        "url": "https://.../stream.m3u8",
        "mimeType": "application/x-mpegURL",
        "headers": { "X-Custom-Auth": "..." }
      }
    }
  ]
}
```

An option carries **exactly one of `stream`, `pan` or `track`**, and the field
is what says who turns it into something playable:

```jsonc
{ "label": "第12集", "stream": { "url": "https://…", "mimeType": "…", "headers": {} } }
{ "label": "合集",   "pan":    { "share": "https://pan.quark.cn/s/…", "password": "1234" } }
{ "label": "第12集", "track":  "<opaque, this source's own>" }
```

- `stream` plays as it stands and nothing redeems it.
- `pan` is a cloud-drive share the **host** opens, with no plugin running. It is
  `{ share, password? }` and it names no drive: which client opens it is decided by
  the share URL's own host, so that nothing a plugin writes chooses which of the
  host's code runs. A host that speaks no client for that host refuses the option
  with a sentence saying so. The app speaks 夸克网盘 (`pan.quark.cn`), UC网盘
  (`drive.uc.cn`, `fast.uc.cn`) and 天翼云盘 (`cloud.189.cn`, `h5.cloud.189.cn`)
  and no other drive yet; the CLI holds no drive account and opens none.
- `track` is a token only this source can read, redeemed by asking this source's
  own [`getStream`](#getstreamtoken) at play time. It is a string, bounded at 2048
  characters, and it is opaque: a host must never look inside one. Declare
  `playbackTokens` in the manifest to emit either of these — see
  [A source whose option is not a URL yet](#a-source-whose-option-is-not-a-url-yet).

There is no `kind` field and there will not be one. A `kind` would be a
plugin-written string selecting which of the host's code runs; a field name is read
by the host's own parser and cannot be.

- `mimeType` defaults to `application/x-mpegURL` (HLS) if omitted; the app
  also recognizes `video/mp4`.
- `headers` (optional) are attached to the player's HTTP data source for
  that stream only — use it for a signed-URL scheme, a session cookie, or
  a bearer token scoped to the CDN rather than the API. Each name is an
  RFC 9110 token and each value printable ASCII, space or tab; a host
  refuses a stream carrying any other (see "Media the app fetches for a plugin").
- Multiple `playbackOptions` render as multiple choices in the UI (e.g.
  different cuts, mirrors, or qualities); TV episodes are modeled the same
  way today (one option per episode) until a dedicated `/seasons` endpoint
  is warranted.
- `line` (optional) names the mirror / CDN line an option is served from
  when the same episodes are offered on several. The app shows the distinct
  lines as a top-level choice and one line's episodes at a time; list the
  options line by line so auto-play continues on the same line.
- `season` (optional) is which season of a series the option belongs to, as
  an integer. The app lists a line's episodes in one headed section per
  season, in the order the seasons are first seen; omit it for a title that
  isn't divided into seasons and the options are listed as one plain run.
  It groups only — the `label` should still say what the option is on its
  own, since the player's title bar and History show it with no heading
  beside it.
- `404` if `mediaId` does not exist.

### `GET /v1/search?q=<query>`

```json
{ "items": [ /* MediaSummary */ ] }
```

- Empty or whitespace-only `q` is never sent by the client; a server can
  assume `q` is non-empty.
- `200` with `"items": []` for no matches.

### `GET /v1/recommendations` (optional)

```json
{ "items": [ /* MediaSummary */ ] }
```

- What the source ranks highest right now, best first: a hot list, its
  top-rated titles, an editor's picks. The app's Home carousel shows them with
  their rank, in the order given and without dropping any — a title with no
  artwork draws a flat field rather than being left out, because removing it
  renumbered the ones below it and the app would have been publishing its own
  positions as the source's (kangzj/yonto#269).
- Optional: `404` means the server has no ranking, and the app falls back to
  page 1 of each category's listing. `200` with `"items": []` means the same.
  Not "the latest": this endpoint is the only place ordering is promised, and
  `media?page=1` promises none (kangzj/yonto#283).

### MediaSummary shape

Used inline in the media-list and search responses:

```json
{
  "id": "big-buck-bunny",
  "title": "Big Buck Bunny",
  "type": "MOVIE",
  "posterUrl": "https://.../poster.jpg",
  "backdropUrl": "https://.../backdrop.jpg",
  "year": "2008",
  "rating": "PG"
}
```

All fields except `id`, `title` are optional.

### Text the app shows

The app removes C0 control characters, U+007F and the bidi embeddings,
overrides and isolates (U+202A–U+202E, U+2066–U+2069) from every field a
viewer reads: a title, `year`, `rating`, `genres`, `synopsis`, an option's
`label` and `line`, and the `name` of a category, filter, filter option and
library, and a health `summary`. The same holds for a plugin's answers.
TAB, LF and CR become a space in all of them but `synopsis`, which keeps them.
Ids, URLs, headers, tokens and cursors are handed back as sent.

## Errors

| HTTP status  | Client-side meaning                                  |
|--------------|-------------------------------------------------------|
| `401`, `403` | `ContentSourceException.Unauthenticated`               |
| `404`        | `ContentSourceException.NotFound`                      |
| other `4xx`/`5xx`, network failure, malformed JSON | `ContentSourceException.Unavailable` |

The client applies per-request connect/read timeouts and never retries
automatically — retry is a UI-level action (the app always shows a Retry
button on failure).

### Yonto plugin method arguments

A plugin's methods mirror `ContentSourceAdapter`, with one exception noted below,
and what a host hands each of them is part of the contract rather than each host's
own business:

| Method | Arguments |
|---|---|
| `getCategories()` | none |
| `getFilters(categoryId)` | the category's `id` |
| `getMediaList(categoryId, options)` | the category's `id`, then **one options object** — `{ page, filters, cursor }`, `page` 1-indexed, `filters` a map of filter `id` to chosen option `id`, `cursor` absent unless this source handed one out (see below) |
| `getMediaDetail(mediaId)` | the title's `id` |
| `search(query)` | the query, verbatim |
| `getRecommendations()` | none |
| `checkHealth()` | none |
| `getSubSources()` | none — which one is active is the host's to say, and it says it through `yonto.subSource()` rather than as an argument here |
| `getStream(token)` | **a `track` this source itself issued**, verbatim — the string off one of its own `playbackOptions`, never anything a host composed |
| `getImageHeaders()` | none — the one method with no `ContentSourceAdapter` counterpart, since what it answers is used by the app's image loader rather than by the source interface |
| `onImageHeadersRefused(refused)` | **the headers that were refused** — the map this source last returned from `getImageHeaders()`, exactly as it went out |

`getMediaList` takes an options object rather than two more positional
arguments so that a later option can be added without every published plugin
having to count its parameters — and because a host that passed them
positionally would be handing `{ page }` a number.

This was worth writing down: the Android adapter passed
`(categoryId, page, filters)` while `tools/plugin-cli` passed
`(categoryId, { page, filters })`, so a plugin that read `page` had it under
`doctor` and `undefined` on a television. Nothing caught it, because the only
plugin that existed ignored every argument after the first. Each host now pins
its own caller against this table — `PluginArgumentShapeTest` on the device,
`test/doctor.test.js` in the CLI.

### A listing that pages by cursor

A plugin whose source hands out an opaque token rather than a page number says so
in its manifest, `"pagination": "cursor"` (the default is `"page"`), and answers
`getMediaList` with a page instead of a bare array:

```json
{
  "items": [ /* MediaSummary */ ],
  "nextCursor": "eyJvZmZzZXQiOjIwfQ=="
}
```

`nextCursor` is opaque — whatever this source needs handed back to produce the
page after this one — and null or absent **only when there is no page after this
one**. A host hands it back in the next call's options as `cursor`, for the page
it names and no other.

Declared rather than inferred, because a page that names no next one means "the
listing ends here" from a cursor source and "I have never heard of a cursor"
from every other. A host guessing between those would either ask a cursor source
for a page number it cannot answer, or fetch a page-numbered source's first page
to find out something its manifest could have said.

**It costs no contract version.** Cursor paging arrived while version 1 was the only
version, and before any released build could run a plugin at all, so every host that runs
plugins honours it and `contract-versions.json` has no entry for it.

So a host asks a `page` source for the page it wants, in one request, exactly as
it always did. It asks a `cursor` source with the token it was given, and when it
holds no token for the page wanted — a listing page cached across a restart is
the ordinary way that happens — it walks forward from the nearest page it does
know and throws the pages between away. Answering an empty list instead would be
indistinguishable from a listing that ran out.

This is additive: every plugin that returns an array keeps working unchanged, and
`ContentSourceAdapter.getMediaList(categoryId, page, filters)` does not change,
so nothing above the adapter learns that a cursor exists.

The HTTP contract above is unchanged: `/v1/categories/{categoryId}/media` still
pages by number and reports `hasMore`.

### Yonto plugin errors

A Yonto plugin (`tools/plugin-cli`, `plugins/*`) doesn't speak HTTP, so it
has no status code to carry the distinctions above — it signals failure by
throwing. `yonto.error.notFound(id)`, `yonto.error.unauthenticated(message)`,
`yonto.error.unavailable(reason)`, `yonto.error.misconfigured(reason)`,
`yonto.error.unreachable(reason)` and `yonto.error.challenged(url)` each return an
`Error` whose `code` is `NOT_FOUND`, `UNAUTHENTICATED`, `UNAVAILABLE`, `MISCONFIGURED`,
`UNREACHABLE` or `CHALLENGED`; a plugin throws the one that fits. A host maps each onto the same exception the
table above maps HTTP statuses to:

| Yonto code      | App exception                            |
|--------------------|-------------------------------------------|
| `NOT_FOUND`         | `ContentSourceException.NotFound`          |
| `UNAUTHENTICATED`   | `ContentSourceException.Unauthenticated`   |
| `UNAVAILABLE`       | `ContentSourceException.Unavailable`       |
| `MISCONFIGURED`     | `ContentSourceException.Misconfigured`, reason `INCOMPLETE_CONFIG` |
| `UNREACHABLE`       | `ContentSourceException.Unavailable`, marked `serverDidNotAnswer` |
| `CHALLENGED`        | `ContentSourceException.Challenged` where the host admits it, and `Unavailable` otherwise |

**`misconfigured` is about the source's own form, and arrived in contract
version 6.** Raise it when a field the manifest's `configSchema` offers is blank
or holds something the source will not take, and nothing a retry or a new
session can do will help — a Jellyfin profile saved with an API key and no user
id is the case it was added for (kangzj/yonto#281). Do **not** raise it for
a credential the server refused: that is `unauthenticated`, and the two send a
viewer to different places. A plugin cannot choose among
`Misconfigured.Reason`'s other values, which are verdicts a host reaches about a
profile rather than anything a source can know; what the plugin supplies is the
sentence, and the app renders it under "needs attention / edit the source in
Settings".

An older app does not know this code and reports it as `METHOD_THREW`, so a
plugin that raises it must declare `contractVersion` 6 — `lint` works that out
from the call, or from `'MISCONFIGURED'` written anywhere in its code other
than as a value it only compares against, and says so.

**Its sentence is read by a viewer, under the same rules as `unavailable`'s
`reason`**: verbatim, in the language of the source, never a status code, a URL
or anything else meant for a log, and nothing translates it. Two differences
worth knowing. It is read **twice** — on the error screen *and* as that source's
row in Settings, which is where a viewer goes to fix it — so keep it to one
sentence that fits a row. And `unauthenticated(message)` is under those rules
now too: the app used to drop it, which is why some plugins passed an id there
(kangzj/yonto#281). It is read twice as well, but on the Settings row it
goes on a line of its own under the row's fixed status line rather than in place
of it — *Login: Expired* for 低调影视, whose line is the one offering to log in
again, and *Connection: Authentication failed* for any other source
(kangzj/yonto#459); an `unauthenticated()` with no message leaves the row
with the fixed line alone.

**`unreachable` is the plugin's word, and arrived in contract version 16.**
`yonto.error.unreachable(reason)` says the server this source reads did not
answer, where `unavailable` cannot tell that from a server that answered and
refused. The app maps it to `ContentSourceException.Unavailable`, the same
screen and the same `reason` rules as `unavailable`, and marks it
`serverDidNotAnswer` so that whatever wraps the source can decide to rest that
server for a while rather than ask it on every screen (kangzj/yonto#615).
`reason` is optional, as `unavailable`'s is.

It is a plugin's verdict, not a host's, so a host honours it as it honours
`unavailable`: taken as the plugin gives it, whether or not a host function
failed in that call, and never checked against the host's own record of which
requests failed. That record is what keeps the host's codes (`HOST_NOT_ALLOWED`,
`REQUEST_FAILED`, `REQUEST_INVALID`, `REDIRECT_REFUSED`, `STORE_REFUSED`, `RESPONSE_TOO_LARGE`
and `TIMEOUT`) the host's (below), and it has no say here. A plugin can only grey its own source with it,
which is why nothing checks it.

**`CHALLENGED` asks for a browser, and arrived in contract version 17.** A plugin
throws it, with the URL that answered with the check as its message, when it recognises
the page it was given as a browser check — Cloudflare's *Just a moment…*, a 加速乐
captcha, a Turnstile box — rather than the page it asked for:
`throw yonto.error.challenged(url)`. A hand-built
`Object.assign(new Error(url), { code: 'CHALLENGED' })` is honoured the same way.

It is a request, not a verdict. The host offers the viewer a browser check only where all
of these hold, and reports the call as `Unavailable` otherwise, with a log line naming the
rule it failed (`conformance/browser-checks.json` holds both hosts to the wording):

- a `browserCheck` capability in the manifest covers the URL's site (see *A site behind a
  browser check*, below);
- the URL is `https` and not a private address, whatever the manifest or the viewer said;
- `yonto.fetch` reached that site, on any hop, during the call that raised it;
- it is not the site of the plugin's `cookieLogin`;
- the URL carries no user name or password, which `yonto.fetch` would not send either.

A browser will open only when the viewer presses something, never from inside a call: the
call ends with the refusal like any other failure, and the screen, the Settings row or the
editor's Test is to offer the check. So a plugin may raise it as often as it likes, and the
worst it earns is a source that says it needs a check. **The browser itself is not built yet
(kangzj/yonto#359's viewer phase):** an admitted challenge shows as needing a check,
naming the site, with nothing yet to press.

An older app does not know `CHALLENGED` and turns it into `METHOD_THREW`, a generic error
where a way back should be, so a plugin that raises it declares `contractVersion` 17 — which
its `browserCheck` capability already requires.

A **transport failure** is `yonto.fetch` rejecting with `REQUEST_FAILED`,
which from contract 16 means exactly that the request went out and no usable
answer came back: the connection was refused or reset, the name did not
resolve, TLS failed. Everything else `yonto.fetch` refuses has a code of its
own (*What `yonto.fetch` answers*, below), so a plugin reads the code and
needs nothing more: `REQUEST_FAILED` from `yonto.fetch` becomes `unreachable`,
and any other code does not (kangzj/yonto#651). One that lets
`REQUEST_FAILED` through is not marked, because the host cannot know which of
the plugin's servers mattered. No other host function rejects with
`REQUEST_FAILED` from contract 16: a store write the host refuses is
`STORE_REFUSED` (kangzj/yonto#663).

An older app does not know `UNREACHABLE` either, and would report it as
`METHOD_THREW`, an ordinary outage with the plugin's sentence lost. So a plugin
that raises it must declare `contractVersion` 16; `lint` works that out from
the call, or from `'UNREACHABLE'` written anywhere in its code other than as a
value it only compares against (`===`, `!==` or a `case`), and an older app
refuses the plugin with *Needs a newer Yonto*.

A plugin that scrapes a site over `yonto.fetch` sits in the same place a
native adapter does relative to that site's own HTTP responses, so it maps
that site's status codes exactly as the app's own shared HTTP client
(`HttpJsonClient`) does — a viewer cannot tell that a source is a plugin
rather than a built-in adapter, which means the two must fail identically
given the same response:

| Site's HTTP status | Raise                       |
|----------------------|------------------------------|
| `401`, `403`          | `unauthenticated(message)`   |
| `404`                 | `notFound(id)`                |
| any other non-`2xx`, or a body the plugin can't parse | `unavailable(reason)` |

This holds even where it reads oddly for a given site — a source with no
login of its own still maps a `401`/`403` to `unauthenticated` — with one
exception: a plugin that covers the site with a `browserCheck` and recognises
the page as a check raises `challenged` instead. A Cloudflare or WAF challenge
answers with exactly those statuses, and before contract 17 the mapping was the
one route a plugin had; now it is the route for a plugin that declares nothing.
So on a challenge a plugin and a built-in adapter do diverge, on purpose: the one
built-in adapter left, the HTTP transport, reaches a server its owner runs and
has that server to solve this on.

- Raise `notFound(id)` when the id a method was given — a media id, a
  category id — doesn't exist on the source.
- Raise `unauthenticated(message)` when the source's own session, cookie, or
  token has expired or was rejected, so the app can say so instead of showing
  a generic error: *login has expired* for 低调影视, whose Settings row offers
  to log in again, and *refused access* for any other source, which is sent
  to its editor. Pass a message saying what to do when editing the source
  can't fix it, since the message wins over that fallback.
- Raise `unavailable(reason)` for anything else the plugin can't recover
  from itself: the site is unreachable, its markup no longer matches what
  the plugin expects, or it answered with something the plugin can't parse.
- Raise `unreachable(reason)` instead when the server did not answer, and
  asking it again soon would get the same: a transport failure (above), or a
  status the table above sends to `unavailable`. It is `unavailable` with one
  more fact, so a viewer is told the same thing, and a plugin that has no use
  for the difference keeps raising `unavailable`. See *`unreachable` is the
  plugin's word*, above. Not for any of these, because the server was never
  asked or did answer:
  - `TIMEOUT`. It means this call's budget ran out, and once it has the host
    refuses requests it never sends, so a site the call did not reach in time
    would be rested for the call's slowness (kangzj/yonto#560).
  - A request the plugin could not build, which nothing sent: a query
    `encodeURIComponent` refused (a `URIError`, kangzj/yonto#293), or an
    empty or malformed URL or a charset the host does not decode
    (`REQUEST_INVALID`).
  - A redirect chain the host gave up on (`REDIRECT_REFUSED`). The server
    answered, with redirects.
  - A body over 16 MB (`RESPONSE_TOO_LARGE`). The server answered, with more than
    a plugin may read.
  - An answer the plugin could not parse, or one that says the request failed
    in its own words, such as a MacCMS `{"code":0}` with a `2xx` status. The
    server answered.
- `reason` is what a viewer sees, verbatim, when it is non-null (`UiError.Unreachable.reason`,
  rendered as the error body in place of the generic fallback copy) — it must read as a
  sentence written for a viewer, never a status code, a URL, or anything else meant for a
  log. Put diagnostics a bug report would want in a `yonto.log` call before throwing,
  the way `cause`'s message is for the log on the app's own HTTP client
  (`ContentSourceException.Unavailable`, above) rather than for `reason`.
- **`reason` is in whatever language its author wrote it in, and nothing translates it.**
  A host tells a plugin nothing about the viewer: there is no locale on the `yonto`
  surface and there is not going to be one. So a plugin picks one language and a viewer
  reading another gets a sentence they may not be able to read, under a headline the app
  *has* localised — which is what the bundled Chinese sources do today, and it is accepted
  rather than a bug to be fixed (kangzj/yonto#230, decided by Jasper 2026-09-21).

  The reasoning is that a plugin's sentence is the only thing on that screen which knows
  *why* the source could not answer — which site of a 仓 is resting, that a search is not
  supported, that a config names no usable site — and losing that to make every error
  translatable would cost more than it buys, for an app whose sources are
  Chinese-language sites and whose viewer reads the language they chose those sources in.

  What follows for a plugin author: write `reason` in the language of the source you are
  scraping, and **name the part of the source that failed rather than the source** — the
  headline above it is already `Can't reach <source>`, so a `reason` that opens with the
  source's name says it twice. `xptv-js` gets this right with `This source's website isn't available right now.`,
  which names the part of the source that failed, its site rather than its program; `ddys`
  and `iyingshi` both get it wrong today with
  `低调影视暂时无法访问` and `爱影视暂时无法访问` under a headline that already said so
  (kangzj/yonto#248).

  Keep it short, but a second sentence earns its place when it says something only the
  plugin could know — that a source of several libraries has others to try, say, because
  nothing else on that screen knows it.

  What follows for the app: `Unreachable.reason` is opaque. Never parse it, never branch on
  its contents, and keep every sentence the app itself owns in `strings.xml` where it is
  translated. This is about *that* `reason` only — `UiError.Misconfigured.reason` is a
  different thing with the same name, an enum the app is meant to switch on, and
  `ErrorMessages.kt` does so deliberately.
- A host accepts a thrown value as one of these by duck-typing on its `code`
  property, not by checking where it came from: `yonto.error.notFound(...)` is a
  convenience constructor, and a plugin's own hand-built `{ code: 'NOT_FOUND' }` (or a
  `PluginError` re-thrown) is honoured identically. A host that instead brands the objects
  its own constructors return — so that only *its* `NOT_FOUND` is recognized — diverges
  from every other host silently, which is exactly what `conformance/` exists to catch.
- A code the host doesn't recognize, and a plain `Error` with no code, is
  reported as `METHOD_THREW` instead — a plugin cannot invent a new code.
- Nor can it borrow one of the host's. A call that ends in `HOST_NOT_ALLOWED`,
  `REQUEST_FAILED`, `REQUEST_INVALID`, `REDIRECT_REFUSED`, `STORE_REFUSED`, `RESPONSE_TOO_LARGE` or
  `TIMEOUT` keeps that code
  only if a host function answered that same call with it; otherwise it is `METHOD_THREW`, whatever the thrown value carries
  and whatever the plugin did to the realm around it. A plugin re-throwing the host's
  error, or repeating its code, in the call the host reached it is reporting the host's
  verdict, which is allowed. A module body the host stopped for time is the one `TIMEOUT`
  with no host function behind it (kangzj/yonto#342). `UNREACHABLE` is not one of
  these: it is the plugin's own code, and stands on the plugin's word (above).
- A host function handed an argument it cannot use throws a `TypeError` naming the
  function and the argument (`yonto.sleep: ms must be a number`), and one that fails
  inside throws a plain `Error` in a sentence. Neither carries a code, so uncaught it is
  `METHOD_THREW`; neither names the host's implementation language.
  Both hosts meet these two rules, and `conformance/host-verdicts/` holds them to the same
  verdicts and the same words (kangzj/yonto#342). A `REQUEST_FAILED` from `yonto.fetch` is
  the host's sentence too, naming the host and why it gave no answer: its certificate isn't
  trusted, its certificate has expired, it could not be found, it refused the connection,
  it did not answer in time, or it could not be reached (kangzj/yonto#645). Each host's own
  tests hold it to those words, since no conformance case can fail a TLS handshake on both.
- `getMediaList` raising `NOT_FOUND` past page 1 means the listing ran out,
  not an error: that is how the app paginates, and a host recovers it as an
  empty page rather than surfacing it. On page 1, `NOT_FOUND` still means
  the category itself doesn't exist.

### An answer that is incomplete

Between throwing, which fails the call and takes its answer with it, and `yonto.log`,
which no viewer sees, a plugin can say that what it is returning is incomplete:
`yonto.partial(reason)`, called during a call that then returns normally. A listing that
some of the servers behind it did not answer is the case it was added for
(kangzj/yonto#357). It arrived in contract version 14.

- **The answer is still the answer.** Nothing about the call fails, and the host renders what
  came back exactly as it would have without the sentence.
- **`reason` follows the rules for `unavailable`'s**: verbatim, in the language of the source,
  one sentence that fits under a row, never a status code, a URL or anything meant for a log.
  Nothing translates it. The app cleans it like any other line a viewer reads (above).
  Name the part that is missing — `四个站点中有一个没有回应，结果可能不全` — rather than the source.
- **It belongs to the call it was said in.** The last one said wins; a string that is blank
  once cleaned (a lone BEL is), or anything that is not a string, takes it back. Blank is
  Kotlin's `isBlank`: spaces and line breaks, but not U+FEFF, U+200B or U+2060, which show as
  an empty note. The next call starts with none, so a plugin
  that reports on every call replaces one sentence rather than queueing several. A call that
  throws shows none of what it said on the way.
- **Where it shows.** Under the header of what it describes: a Home shelf (`getMediaList`,
  page 1), the Browse grid (`getMediaList`; a later page's sentence replaces the grid's, and a
  later page that says nothing leaves it), Search results (`search`) and a title page, under
  its year and genres (`getMediaDetail`). A host drops it from every other method, and
  calling it there is not an error.
- **It lasts as long as the answer it describes.** A host that remembers an answer remembers
  its sentence with it, and the next answer — with a sentence or without — replaces both.
- The CLI's `run` prints it beside the answer and `doctor` under the step that said it, for
  the same three methods and cleaned the same way. `tools/plugin-cli/conformance/partial/`
  holds both hosts to these rules.

## A source that is several

Some sources are not one library but a handful of interchangeable ones.
A TVBox 仓 is a document naming dozens of CMS sites, each with its own films and its own
genre tree; a viewer wants one of them at a time, and wants to say which.
Such a source exports `getSubSources()`:

```json
{
  "items": [
    { "id": "suoni", "name": "索尼资源", "available": true },
    { "id": "liangzi", "name": "量子资源", "available": false }
  ],
  "activeId": "suoni"
}
```

and reads `yonto.subSource()`, which answers the id the viewer chose for this source, or
`null` before they have chosen one.

- `available` defaults to true and means reachable *now*.
  A source that already knows one of its libraries is not answering says so, and a host
  offers that one greyed instead of letting a viewer pick a wall.
- `activeId` is the library this source is actually reading, which is not always the one it
  was handed: a chosen library that cannot be reached falls through to one that can.
- A host offers no picker for a list of one library that is available, since there is nothing
  to choose; a lone one that is not available is still offered, because picking it is how it
  is asked for again.

**There is no `selectSubSource`.**
A source is a function of its configuration and its sub-source, and a host switches by
writing the new id down beside the profile and building the source again — which is what it
already does when a configuration field is edited.
So nothing mutates a running plugin, no method has to be called before the others, and no
answer cached under the old sub-source can outlive the switch.

Two rules follow, and both outlive the plugin they were written for:

- **A host shows `activeId` and never stores it.**
  What it stores is what the viewer picked.
  A fallback written down is a choice nobody made, and it would cost a viewer their own
  library permanently because it was unreachable for a minute.
- **A media id stays resolvable whichever sub-source is active.**
  Watch history, Continue Watching and the television's own Watch Next row hold ids taken
  under one sub-source and ask for them under another, so a source that partitions its
  library carries the part in its ids — `<site key>|<vod id>`, say.
  Category ids carry no such rule: the rebuild throws them away with the adapter that
  issued them.

**`getSubSources` is answered from what the source already knows, unless the source has
said otherwise in its manifest.**
A host may ask it on a dialog's opening frame either way, and what differs is what the host
owes the viewer while it waits.

The default is the free call, and it is a requirement on the source rather than an
observation about the one that exists.
It is what lets a picker ask again as it opens — the marks it draws are otherwise as old as
the last library load, and a library whose rest ended in between shows greyed and unpickable
until something else happens to reload (kangzj/yonto#159).
A source may of course have *learned* what it knows over the network earlier; what it may
not do is go and ask when this is called.
There is nowhere to put that wait: the list is already on screen, so there is nothing to
show a spinner over, and a viewer watching a drawn list sit still has been given a freeze
rather than a wait.

### A source whose library list is itself remote

Some sources cannot answer from what they know, because what they offer *is* a document
somewhere else — an XPTV or TVBox index lives at a URL, and a source pointed at one has
nothing to list until it has read it.
`yonto.store` is a cache and a host empties it whenever it needs to, so "read it once and
keep it" is not an answer: a viewer who cleared their caches would open the picker of a
perfectly healthy source and be shown nothing at all.

Such a plugin declares **`catalogsAreRemote: true`** in its manifest, and that declaration
buys it exactly one thing: `getSubSources` may go and ask.
What it costs is that the host now has a wait to show, so the picker is allowed to open with
no list in it and say that it is loading — which is only honest where there was no list to
freeze, and is why the declaration is per-source rather than a blanket relaxation.

Three rules come with it, and they are what keep the relaxation from swallowing the rule:

- **The declaration is a fact about the source, not a mood.**
  A plugin that declares it must still answer from cache when it has one; the licence is to
  fetch on a miss, not to fetch every time.
  A picker re-asking on every open is the case the free call was written for, and it has not
  gone away.
- **A wait is shown only over an empty picker, never over a drawn list.**
  Where the host already has libraries to draw, it draws them and lets the answer replace
  them when it lands.
- **The ordinary call bound applies, unchanged.**
  This is a call like any other and the twenty seconds below is its ceiling. A dialog is a
  worse place to spend them than most, which is an argument for a source keeping its index
  warm elsewhere — `checkHealth` is a call a host already makes where no viewer is waiting
  on a dialog, and an index fetched there is an index the picker does not have to fetch.
  How far that may be leaned on is *What `search` and `checkHealth` mean here*, below.

A host that meets `catalogsAreRemote` on a manifest older than its own build reads the
conservative answer — absent means `false`, the free call, which is what every source
written before this meant.
An **older host** never meets it: `lint` refuses `catalogsAreRemote` below contract 8, and a
host refuses a manifest whose `contractVersion` is newer than it supports, so an app from before
version 8 refuses the plugin at install rather than running it without the wait.

It was written for `plugins/tvbox`, whose `getSubSources` answered from the site list its
runtime already read and reached `yonto.fetch` only on a runtime that had read nothing over a
cold store, which is the case the declaration exists for (kangzj/yonto#397). That plugin
was retired on 2026-09-24, when the app began reading 仓s itself (kangzj/yonto#615), and
the declaration stays for any source whose library list is remote;
`tools/plugin-cli/test-plugins/sub-sources` is what both hosts' tests run it through.

What this deliberately does **not** promise is freshness. A cooldown that ended is noticed,
because that is a fact the source already holds. A library that recovered early, or died
since the source last spoke to it, is not — finding that out is a probe, one request per
library, and that is `checkHealth`, which a host runs where a viewer is not waiting on a
dialog. See `docs/design/2026-09-20-the-picker-asks-again.md` for why the cheap half is
worth having on its own. That holds where a library is one request; where it is a
third-party plugin to fetch and compile it does not, and the next subsection says what
`checkHealth` answers instead.

Both are optional, and a source that is one library exports neither.
**This is a plugin-only surface**: there is no `/v1/sub-sources`, because an HTTP provider
whose libraries sit behind different base URLs is two profiles rather than one source, and a
shape nothing implements is a shape nobody can be held to.

### What `search` and `checkHealth` mean here

Both look like a place to ask every library at once, and only one of them survives a source
whose libraries are code.

A 仓's sites are interchangeable mirrors of one CMS corpus, so asking all of them is one
corpus searched fourteen ways at fourteen HTTP requests.
A library that has to be **fetched, compiled and run** before it can answer a word is not
that.
An XPTV index names 84 of those, and the same fan-out over them is 84 downloads plus 84
compiles plus 84 scrapes, inside one twenty-second call and one 64 MiB realm.
So what follows is about what a library costs to ask rather than about which document a
source read.
Where a library is one request the `checkHealth` half does not apply, and a source may
probe every library; the `search` half applies to it all the same, since
kangzj/yonto#569.

**`search` goes to the active sub-source and to nothing else.**
Whatever `getSubSources` reports as `activeId` is the library searched, because that is the
library Browse is showing.
The 仓 lost this argument next door already: `getRecommendations` was pooled across every
site until kangzj/yonto#148, and was narrowed because *"a hero carousel drawn from
catalogs the rest of the app is not showing is a row a viewer cannot get back to"*
(*catalogs* there is what this contract now calls libraries).
A search result is the same shape and a step worse: a viewer who finds a title in a library
they are not reading has to switch library to see anything else from it.

A capped fan-out is the obvious alternative and it is refused.
A cap of four is four fetch-compile-runs inside one twenty-second call, which is four times a
cost nobody has measured once; it picks the four on the viewer's behalf; and four strangers
compiled into one realm is four times the blast radius of a realm that is not a boundary.
A viewer-chosen subset is the better shape of the two, and it is still a fan-out.
A set chosen for which libraries the picker offers answers a different question when it is
spent as a search list, and **an empty set means every option**: a viewer who chose nothing
would be handing search all 84.
If breadth is wanted here later it wants a measurement of one library's search first, and
this is the rule to re-open with it.

**A source of many libraries reports on its list, not on its libraries.**
`checkHealth` answers how much of the library list is usable — for an index, how many entries
this source can offer as libraries against how many the document names — and `usable` is false
when that is none.
It probes no library, fetches no library's code and compiles nothing.

Two reasons, and the second is the hard one.
A host runs `checkHealth` on **every** switchable profile when a viewer opens Settings, a few
at a time and each building its own runtime (`MainViewModel.probe`), so whatever this costs
every source pays on a screen a viewer opens casually — and a slow one holds up the sources
queued behind it.
And whether a given library is up is `available`'s business, which is one request per
library: the subsection above says that does not belong on a dialog's opening frame, and a
status line is not a better place for 84 of them.

**Nothing here overrules a source whose libraries are one request each.**
How many of them answer is the right thing to report there, because a library is one request
and the count is the number a viewer wants.
The rule is that a source reports what it can ask cheaply, and for an index that is the
index.

**A `summary` is drawn verbatim, so write a sentence** (kangzj/yonto#418).
Settings puts it in the status line exactly as it arrives, with no frame around it, because
the app has no noun to lend one — it cannot know what a source it has never met is counting.
There is no exception: `plugins/tvbox`, which answered a bare `<up>/<total>` the app framed
with *Sites:*, was retired on 2026-09-24 and the frame went with it (kangzj/yonto#615).
Anything answering `12/14` puts `12/14` on the row, which is a number with no noun in
the column a viewer scans for a verdict.
Until #418 that did not matter, because `SettingsScreen.statusLine` gated the line that reads
a summary on the plugin id and every other source's was computed, carried across the bridge
and dropped into *Connection: OK*.

The precedent for drawing it bare is `misconfigured`'s sentence, above: that one is already
read on this same row with no frame in front of it, for the same reason — which field is
blank is the source's to say and no fixed line can (kangzj/yonto#281).
And like every other string a plugin writes for a viewer, a `summary` is in the language of
the source and nothing translates it (kangzj/yonto#230, Jasper, 2026-09-21).
So: one sentence that fits a row, and never a bare count.
`可以读取的片库 12/14` is one, as the retired `plugins/xptv` answered it (kangzj/yonto#448).

**One third-party library compiled at a time, and one per call.**
A call compiles the one library it needs and no others: none for `getSubSources` or
`checkHealth`, the active one for `search`, `getCategories`, `getFilters`, `getMediaList` and
`getRecommendations`, and for `getMediaDetail` the one its media id names — which is not always the active one, because *a media id stays resolvable
whichever sub-source is active* is above and stays true.
Between calls a source keeps at most one, and a call wanting a different one replaces it.

**Nothing is torn down at that bound**, because there is nothing to tear down: dropping a
compiled library drops a reference, and whatever it left on the realm stays there.
Which is why the number is one rather than five — it bounds how many strangers share a realm,
not how much memory they use, and a source wanting real separation wants another runtime,
which a host builds per source and not per library.
What the bound costs is that opening a watch-history row from a library that is not the
active one pays a fetch and a compile inside that call, and the Browse call after it compiles
again; a library's source text belongs in `yonto.store` beside the index for exactly that,
so the second compile is usually not a second download.
kangzj/yonto#383 — one plugin delegating to another, which is what a cloud-drive
resolver is — is two compiled at once by construction, and this is the rule it has to argue
against rather than one it may quietly outgrow.

**A source answers `search` with `[]` only when it put the query to something.**
An empty list reads as *searched and found nothing*, and a source that asked nobody has not
searched — kangzj/yonto#229, where a 仓 whose sites were all resting told a viewer
exactly that.
So where the active library cannot be reached, cannot be compiled, or has no search of its
own, `search` raises `unavailable(reason)` naming that library, under the rules `reason`
already carries.
A 仓 is no exception: it searches the one site being read, so a site that is resting and one
with no search are both this source not searching, and in both the viewer's move is to switch
library.

**What `catalogsAreRemote` may lean on.**
The subsection above offers `checkHealth` as a place to keep a remote library list warm, and
that stands — warming the list is exactly the network a `checkHealth` here does.
It is an optimisation and never a precondition, so `getSubSources` has to be correct and
inside its own budget on a box where `checkHealth` has never run.
Three things stop it being more than that.
It is optional and a host may never call it, and a plugin that does not export it gets the
host's default, which is a `getCategories` (`ContentSourceAdapter.checkHealth`) — on a source
like this, a library compiled to answer a status line.
Nothing orders it before the picker: the probe is launched per profile in the background as
Settings opens, and a viewer may open the picker in the same second.
And what survives the call is the store, which is a cache a host empties when it likes — the
sentence that made *read it once and keep it* not an answer in the first place.
What a module keeps in memory is no more than that: a host may start a source's realm over
between calls, and the device does once its async host calls have used a share of its memory, or
once the realm, module state included, is using most of it (kangzj/yonto#543, #703). A
module holding most of the memory limit is loaded again on nearly every call.
So an index fetched in `checkHealth` is an index the picker probably does not have to fetch,
and *probably* is the whole of the promise.
The better warm was the `multi` chooser in the editor, which read the index because a viewer
pressed a button on a screen with somewhere to put a spinner, and so had the ordering
`checkHealth` lacks. It was withdrawn (*A field that holds a set*), so there is no better warm
today.

**None of this costs a contract version.**
Nothing a plugin calls or exports changes — what changes is what two existing exports are
allowed to mean — so `contracts/contract-versions.json` is untouched and a host that has
never heard of these rules behaves exactly as it did.

## Media the app fetches for a plugin

A poster goes to the app's image loader and a stream to its player. Neither speaks
`yonto.fetch`, so neither can be authenticated the way an API call is, and a plugin
whose media is behind its own login has two ways to say so:

- **`stream.headers`** — sent with that stream, by the player.
- **`getImageHeaders()`**, optional — a flat `{name: value}` map sent with every image
  this source returned.
- **`onImageHeadersRefused(refused)`**, optional, contract 3 — the host telling this source
  that the headers it last gave were refused, handing back the map that went out. It
  answers `{"renewable": true|false}`: true when the next `getImageHeaders()` can win
  something new, false when only the viewer can replace that credential.

  It is handed `refused` so that it need not forget anything it has since renewed: a source
  whose own traffic met a 401 first has already stored a live credential, and a source that
  compares what it holds against what was refused can say `renewable: true` without
  throwing that away. Without the argument the only implementation available is to forget
  unconditionally, which costs a login in the case that was already working — and on a
  server that replaces a session per device, that login invalidates the credential other
  calls are carrying.

A host applies `getImageHeaders()` only to the hosts that profile's allowlist already
admits — `allowedHosts` plus its `url` config fields, minus any `*.` entry, because a
wildcard admits a family of hosts and a token is not something to hand to a family. The
check is per request and per redirect hop, so an image URL that bounces off those hosts
carries nothing. The hosts are compared in canonical form on both sides — see "What a host
is" — so a profile configured at `http://media.example.com./` signs the pictures it asked
for rather than none of them. An image carries the signature of the source it is drawn for,
and only that one: where two profiles name one server, each profile's posters carry its own
headers, a refused poster asks only its own profile to sign again, and a profile that signs
nothing there sends nothing and has no refusal to answer for (kangzj/yonto#341). A refusal
is still recorded and shown by host, so every profile claiming that host is flagged.

**A source is told when its artwork is refused, rather than merely asked again.** Artwork
is fetched by the app's image loader, outside every request this source makes, so a source
recovers from a refusal of its *own* traffic and never learns about one of a poster's. Asking
again does not close that: a source answers `getImageHeaders()` from whatever it cached, and
a credential revoked on the server still matches everything the source can check — so the
same header comes back whenever nothing else has renewed it, which is precisely the case
where artwork is the only thing that knows. `onImageHeadersRefused(refused)` is what a source's own
401 recovery looks like from the outside, made reachable by the one caller that cannot do it
for itself, and handed the credential in question so a source that has since renewed need
not discard what it won. A source that does not export it is asked anyway and behaves as it did before
contract 3; one that answers `renewable: false` is not asked again, because spending a call
on a credential it cannot change only postpones the same refusal.

**A `hostsFromConfig` plugin therefore cannot have signed artwork**, and that is a decision
rather than an omission. Such a plugin has no allowlist by design, so there is no set of
hosts to send a header to: its pictures come from the CMS sites its config names, which are
precisely the hosts no manifest admits. `getImageHeaders()` from such a plugin is collected
and applied to nothing.

The alternative was signing whatever it may fetch, and that is wider than it sounds: for this
plugin class nothing in the manifest bounds where a request goes either, so a config file
written by a stranger would decide where a viewer's token is sent. There is no third rule
that bounds it, because there is nothing to check a list of hosts against.

So an author who needs signed pictures needs a manifest that names the hosts they come from.
`lint` says so when a manifest declares `hostsFromConfig` and exports `getImageHeaders`,
because the runtime failure is a poster that 401s and nothing that logs it.

**`stream.headers` go to the stream URL's own host and to the hosts the manifest's
`allowedHosts` names, and to no other.** A `*.` entry is matched as the allowlist matches it,
a subdomain and never the name itself. Hosts are compared in canonical form, the port does
not matter, and neither does a move up to https; a step down from https to http sends
nothing, to a listed host too. The check is per request and per redirect hop, so a redirect
to any other host, and a playlist's segments or keys on one, go without them
(kangzj/yonto#730). A host that answers 401 or 403 to a request sent without them is
named to the viewer as that, not as a title that isn't available.

Only what the manifest wrote, never the reach its config adds: a `url` field's host, or
anything a `hostsFromConfig` or `runsFetchedCode` plugin may fetch, is somewhere the plugin
may *ask*, not somewhere its viewer's token should follow the player. So an author whose
stream's segments or redirects land on a CDN that wants the same headers lists that CDN in
`allowedHosts`, where a review sees it. Nothing measured needs it today (taiav.com's
playlist names segments on `v16cdn.snmovie.com`, which serves them without).

**A linked source's server credential goes on its posters and streams too, from the host.** For
a plugin whose `linkLogin` the host runs (see *A login the viewer finishes elsewhere*), the
image loader and the player each ask, on every hop, whether a server is bound to exactly that
scheme, host and port for the source the picture or stream belongs to, and send its credential
in the service's `serverHeader` there, its value template filled, over any header of that name
`getImageHeaders()` or `stream.headers` set; a redirect to anywhere else, an `http` hop to an
`https` binding and a playlist's segment on another host carry nothing of it. The bindings are
read as they are when the hop is made, so a server bound after the source was built signs the
next poster and stream, and one that moved stops being sent it at once; a source that has made
no call yet since the app started has its session read, and its reach checked, on the first such
hop. A bound host counts among the hosts a refused poster is claimed by, a refusal there marks
that server's binding stale as `yonto.session.refused()` does, and
`onImageHeadersRefused(refused)` is still handed only the map `getImageHeaders()` returned,
since the plugin never had the host's credential. A typed address is sent the credential only
once the server there has said it is the bound one, which a `yonto.fetch` to it asks. A poster
or stream URL carrying a credential the host holds is not fetched.

Prefer either to signing a URL. Jellyfin's 12.x server dropped its `api_key` query
parameter, which is what made this necessary — but a URL is also the thing that ends up in
a log, a cache key and a bug report, and a header is not.

**What a header may contain is checked, for both kinds.** A name is an RFC 9110 `token`
and a value is printable ASCII, space or a tab (`$defs/headers` in the schema). That is what
the host's HTTP client will send as written, and nothing else is a header — `X-A\r\nInjected`
is one request pretending to be two. A host refuses a stream carrying any other, as it refuses
any malformed answer, and drops such an entry from `getImageHeaders()`, sending the rest.

## What a plugin is

**One `.js` file, with its manifest in a header comment at the top.** The manifest is the
object `manifest.schema.json` validates; only where it is written is part of this contract.

```js
/* yonto-plugin
{ "kind": "content-source", "id": "jellyfin", "name": "Jellyfin", "version": "1.4.0",
  "contractVersion": 3, "provides": "source-type", "allowedHosts": [],
  "configSchema": [ ... ] }
*/
const PAGE_SIZE = 500;
export default { async getCategories() { ... } };
```

Four rules, enforced the same way by both hosts:

- The comment opens the file. A BOM and leading whitespace are allowed, nothing else is.
- The manifest is everything up to the first comment terminator.
- The search for that terminator stops after 64 KB, so a hostile file cannot make a host
  scan a megabyte for one that is not there.
- `bundle` refuses a manifest whose serialised JSON would contain a terminator — the one
  sequence that could cut a header short into something that still parses as JSON.

**It is a module, and it may await at the top level.** Both hosts evaluate it as an ES module
once per runtime, so a top-level side effect happens once however many calls follow
(kangzj/yonto#531). They evaluate it inside the first call and wait for it before running that call's
method, so a module body that awaits something of its own is ready by the time a method is asked for anything,
and the first call's budget pays for the body's JS (see *What a call may spend*).
A top-level `await` that rejects is the module body throwing, and is reported as one.
What it awaits must be its own: a plugin must not read `yonto` while it is being evaluated,
awaited or not — see `yonto.sleep` at module scope under *What a call may spend*.
Decided 2026-09-23 (kangzj/yonto#457); the CLI used to refuse to build it while the
device ran it.

**The header is read as text, never by evaluating the module.** That is why it is a comment
and not an export: `allowedHosts`, `hostsFromConfig`, `configSchema`, `provides` and
`contractVersion` decide where a plugin may go and what installing it does, and learning
them by running the plugin inverts the order
those exist in. It also keeps the source editor's picker cheap, since listing what a box can
run never starts a runtime.

**Both doors sniff the bytes.** `PK\x03\x04` is a zip; anything else is decoded as UTF-8 and
read as a headered file. A raw gist serves `text/plain` and a release asset serves
`application/octet-stream`, so a viewer pasting a link somebody gave them should not have to
get the extension right. A zip carries **exactly one entry, `source.js`, headered** — the
same file, compressed. A zip with a separate manifest in it is refused rather than accepted:
two places that can disagree about where a plugin may reach is precisely what the header was
chosen to avoid.

### What it must export

Four methods are required, because a host calls them with nothing to fall back on. The rest
are optional, and a host that finds one absent carries on as the table says.
`tools/plugin-cli/conformance/optional-methods.json` is the list both hosts are held to, and
`lint` refuses a plugin missing a required one.

| Method | | When absent |
| --- | --- | --- |
| `getCategories` | required | — |
| `getMediaList` | required | — |
| `getMediaDetail` | required | — |
| `search` | required | — |
| `getFilters` | optional | no filters |
| `getRecommendations` | optional | no ranking; Home builds its hero from the shelves |
| `checkHealth` | optional | healthy if `getCategories` answers |
| `getImageHeaders` | optional | artwork is fetched unsigned |
| `onImageHeadersRefused` | optional | the host asks `getImageHeaders` again instead |
| `getSubSources` | optional | one library, no picker |
| `getStream` | optional | a `track` option fails as unavailable; `lint` refuses the export without `playbackTokens` |

**There is no way to say "this source has no search".** A source without one still exports
`search`, and throws `yonto.error.unavailable(reason)` with a sentence that says so.
Answering `[]` instead tells a viewer the source searched and found nothing.

## What a host is

Every gate a request passes — the allowlist, the private-address floor, the check that a
redirect has not left the hosts a plugin may reach — asks about a *host*, and a URL can
spell the same one many ways. `http://127.1/`, `http://2130706433/`, `http://0x7f000001/`
and `http://0177.0.0.1/` all reach loopback. So a host extracts a URL to one canonical
string, once, and every later question asks only about that string.

The canonical host of a URL is:

- its host lowercased, with the port dropped and an IDN name punycoded;
- with one trailing dot stripped — `example.com.` and `example.com` are the same host, and
  an `allowedHosts` entry matches both;
- with an IPv4 literal in any spelling folded to dotted-quad form, leading zeros removed;
- with an IPv6 address unbracketed and compressed per RFC 5952, and an IPv4-mapped address
  folded to its dotted quad, so `::ffff:192.168.1.1` is `192.168.1.1`;
- or **nothing at all**, in which case the request fails as `REQUEST_INVALID` (or, for a
  URL a server redirected to, `REDIRECT_REFUSED`) and the string widens no allowlist. A URL whose scheme is not `http` or `https` names no host. Neither
  does a host that ends in a number but is not a valid IPv4 address: `999.999.999.999`,
  `1.2.3.4.5` and `4294967296` are not hosts, and are not domain names either.

An IPv4 literal is recognised and folded by this rule — the WHATWG URL Standard's, written
out here so both hosts implement one algorithm rather than each inheriting whatever its URL
library happens to do:

1. Split the host on `.`.
2. A part is a *number* when it is `0x`-prefixed hexadecimal (`0x` alone is zero),
   `0`-prefixed octal, or decimal. ASCII digits only; a sign is not a number.
3. If the last part is not a number, the host is a domain name and is returned unchanged.
4. Otherwise the host was meant to be an IPv4 address, and anything that is not one is not
   a host: more than four parts, any part that is not a number, a leading part above 255,
   or a last part not below `256 ^ (5 − parts)`.
5. The address is the last part plus each leading part shifted by its position, written as
   a dotted quad.

A `*.` entry in `allowedHosts` is a name suffix, never an address — an IP address has no
subdomains — so its suffix is canonicalised as a name and nothing in it is folded.

`conformance/hostnames.json` records the canonical host of every spelling that has mattered,
and both hosts are held to it. A disagreement there is a plugin that passes `doctor` on a
laptop and does something else on a television, which is the failure that file exists to
make loud.

## The private-address floor

A plugin may not reach the television's own network because its manifest asked to. That is
the viewer's decision, and a viewer makes it by typing an address into a `url` config field.

At every hop, a host asks two questions, in this order:

**Is it reachable?** Only when the manifest's hosts are enforced — a `hostsFromConfig`
plugin skips this, which is what the flag means. The canonical host must be named by
`allowedHosts`, exactly or through a `*.` entry, or be a host the viewer typed.

**Is it on the viewer's own network?** Always, for every plugin. A private host is refused
unless the viewer typed it. Private means loopback, `0.0.0.0/8`, RFC1918, link-local,
`100.64.0.0/10` (carrier-grade NAT, and Tailscale's addresses), `198.18.0.0/15`
(benchmarking space), `::1`, `::`, `fc00::/7`,
`fe80::/10`, and the names `localhost`, `*.localhost` and `*.local`. An
IPv6 address carrying an IPv4 one — `::ffff:a.b.c.d`, which extraction folds to a dotted
quad, and `::a.b.c.d`, which it does not — is whatever that IPv4 address is, and so is one
that carries an IPv4 address for a translator or a tunnel to deliver to: NAT64's
`64:ff9b::/96` (the last 32 bits), 6to4's `2002::/16` (bits 16 to 47) and Teredo's `2001::/32`
(the client's mapped address in the last 32 bits, inverted, which is where a relay delivers).
NAT64's local-use `64:ff9b:1::/48` is private whole, since where it carries the IPv4 address
depends on a prefix length only its operator knows.

The floor is additive. An `allowedHosts` entry still means everything it meant; what it no
longer does is permit a private address as written on its own. A *name*, allowed or not, is
never checked for what it resolves to (*What a name resolves to*, below).

**What *typed* means for a repo.** A catalog source made from a repo's entry has values the
viewer did not type: the repo's. Each such `url` value makes its host reachable, exactly that
host, and does not open the floor, with one exception: the host the viewer typed as the repo's
address. That is the canonical host of the address as the viewer saved it, before any
redirect, compared as the floor compares hosts, on any port, and it counts only for a value of
that repo naming it. So a repo on `192.168.1.60` may name catalogs on `192.168.1.60`, and not
`192.168.1.1`; a repo typed on the open web whose fetch was redirected to a private address
exempts nothing; and a hop from the typed host to another private host is refused, as it is
for a `url` field. A value the viewer typed over a repo's is the viewer's. The repo's own fetch,
of its document and of every redirect it answers with, is under the same floor, with only the
typed host exempt. A plugin declares nothing for any of this, and never sees the repo.
All of this is about the host as written.

**What a name resolves to** is not checked, by any host (Jasper, 2026-09-26). Only the host
as written is floored: a name is reached wherever it resolves, and a proxy the viewer
configured is used as the system configures it. Until that date a name nobody who may point
one at the viewer's network wrote connected only to public addresses (kangzj/yonto#334);
iOS offers no hook to check where a name resolves, and the device and the CLI dropped the
check to keep one rule on every platform.

**Artwork a plugin supplied is under the same floor** (kangzj/yonto#679). A poster or
backdrop URL is the plugin's word, and the image loader, not `yonto.fetch`, fetches it, so
without this a plugin could have the television send a request anywhere on the viewer's network
by naming it as a poster. The device follows every hop of such an image itself: a private
address as written is refused unless the floor exempts it, with the plugin's own exemptions
(what the viewer typed, and a repo value on the repo's typed host, so a LAN Jellyfin keeps its
posters). A refused image does not load, and nothing else changes. Not under it: artwork
of a source no plugin backs (the bundled sample catalog, an HTTP-contract server the viewer
typed). The image caches keep a source's
copies apart from another's. A Watch Next row on the TV launcher names Yonto's own
`content://` address for its poster, never the plugin's URL, and Yonto serves the bytes
through the same floored path, so the launcher never fetches an address a plugin chose
(kangzj/yonto#693).

### A field that holds a set

**Withdrawn** (kangzj/yonto#440). Version 10 added `type: "multi"` with
`optionsFrom: "subSources"`: a field holding a set of the source's own libraries, chosen in the
editor from what `getSubSources` answered. Nothing ever read the set it stored — the half that
would have narrowed what a viewer sees never shipped — so a viewer was asked a question whose
answer went nowhere, and the type is gone from the schema, the editor and the CLI.

The CLI refuses a manifest declaring one outright (`lint`, `run` and `doctor` alike). An app
from version 10 up to this change draws its chooser; an app after it installs the plugin and
draws the field as a text box, which is what any type a build does not know gets.
If choosing libraries up front comes back, it comes back with the code that reads the answer.

**A field with no answer is no key at all, on both hosts.** Every answer is trimmed, and one
that is empty after that is left out of `yonto.config` rather than handed over as `""`, so
`yonto.config.x || FALLBACK` and `'x' in yonto.config` say the same thing wherever a plugin
runs. A `bool` is the exception by design: always present, and always `'true'` or `'false'`.
`tools/plugin-cli/conformance/config.json` is the record both hosts are held to; they used to
disagree on the empty answer, on whitespace and on a bool that was neither word
(kangzj/yonto#414).

**A plugin reads only what its manifest declares.** A saved value no field declares, an
answer to a question the plugin has since stopped asking, reaches it on neither host. A field id
is a letter and then letters, digits or `_`, and an app refuses a manifest declaring one that is
not.
`tools/plugin-cli/conformance/host-config.json` is the record both hosts are held to; in the
CLI, a `_` key in `YONTO_PLUGIN_CONFIG` or `doctor.json` is passed as the host's.

**A viewer typed it** is narrower than **it came from config.** A `configSchema` field of
`type: "url"` may carry a `default`, the editor seeds the form with it, and a viewer who
taps Save has stored a host without having typed one — that is the manifest naming a host,
in the one way a `hostsFromConfig` manifest can. So a `url` field's host is the viewer's
word only when **the host it names differs from the host the `default` names**; naming the
same host as the default is the manifest's word. A source that records which values the
viewer typed (the app's catalog sources, whose other values came from a repo or a migration)
uses that record instead: only a typed value is the viewer's word, whatever the default says.

Hosts, not the strings they were written as. What is stored is a URL the editor normalised,
with a missing scheme filled in because `192.168.1.50:8096` is what gets typed on a remote —
so a `default` of `192.168.1.1:8080` is stored as `http://192.168.1.1:8080` and never equals
the string it came from. A host comparing those two strings would call a manifest's own
default a viewer's word and exempt it from this floor, which is the floor defeated by a
spelling.

**A stored `url` value has no trailing slash on its path.** Most are an address a plugin
appends its own paths to, so `https://site/` and `https://site/api/` are stored as
`https://site` and `https://site/api`, and `${siteUrl}/list` is never `//list`; a query or
fragment is left as written. A `url` that names a document (a TVBox 仓, an XPTV index) loses
its slash too and is fetched as stored, which a server holding it at `/tv/` normally answers
with a same-host redirect that `yonto.fetch` follows. Both hosts hand a plugin the value this way (kangzj/yonto#351). A value saved
before that rule arrived keeps its slash until the source is edited, and an older app never
drops it, so a plugin that appends to one still strips it itself — every plugin here does.

A stored `url` value always names a host in the canonical form above: the editor refuses
one that does not, so `999.999.999.999`, `08` and `example.123` never reach a profile even
though each is a URL as far as an ordinary parser is concerned. `lint` refuses the same
spellings in `allowedHosts` and in a `url` field's `default`, so an author meets the rule on
their own machine rather than through a viewer who cannot save the form. For the same reason a `default` is read by the bare-host rule above while the
stored value is read as a URL.

The exemption is a host, not a chain. A viewer typing `http://192.168.1.50:8096` exempts
that host: `192.168.1.50/a → /b` is followed, and a redirect to `192.168.1.1` is refused.
Same rule as dropping `Authorization` when a hop leaves the origin.

The check is on the literal the request names, never on a resolved address. No host resolves
a name to decide this: the check runs per hop and it blocks, and resolving an
attacker-supplied name is a different question. `lan.example.com` with an A record on the LAN
is not caught, by either host, deliberately.

Both refusals are `HOST_NOT_ALLOWED`. The floor's message names the canonical host:
`<host> is a private address, and nothing the viewer typed names it`.
`conformance/private-floor/` holds both hosts to every case above — a manifest-named private
address, the same one written as an integer, a `default` a viewer never changed and one
written without a scheme, the address a viewer typed, and a redirect off it.


## A source that runs code it fetched

Some sources do not only read a stranger's data, they read a stranger's *program*.
An XPTV catalog is a JavaScript file at an address, and reading that catalog means fetching
that file and running it — so what a viewer agreed to install is not the whole of what will
run on the box.
Such a manifest declares **`runsFetchedCode: true`**, and the install dialog gains a line
saying so.

**Nothing verifies it, and the contract says that rather than implying otherwise.**
`lint` reads a plugin's own source; code fetched at run time is not in that source and no
scan can reach it. So the field is a self-declaration: it documents an author's intention,
and it is worth having only because the install confirmation is the whole of the trust model
and the alternative is silence.

Which fixes what may be concluded from it, in both directions:

- **Declared** means the author says this plugin downloads and runs code, and the viewer is
  told before they agree. That is the case the field exists for.
- **Absent** means *nobody said so*. It is not a host's finding that the plugin does no such
  thing, and no later decision may treat it as one — a plugin that fetches and runs code
  without declaring it is an author's dishonesty and passes every check there is.

It is a disclosure rather than a permission: declaring it grants nothing, and leaving it out
forbids nothing. Egress is still `allowedHosts` and `hostsFromConfig`; the floor is still the
floor. What changes is only what the dialog says.

**On an older app the install is refused rather than quieter, and that is the outcome worth
having.** The ordinary rule for an addition is that a host too old for a key drops it and goes
on, which here would mean a viewer agreeing to a dialog that says less than the truth. The
version gate is what stops that: `lint` will not let a plugin declare this key below 11, and a
host refuses any `contractVersion` outside the range it ships with, so a build that cannot draw
the second line does not install the plugin at all. For a disclosure that is the right way
round — a refusal is visible and a shortened dialog is not — and it is why this is recorded as
a version rather than left as a silent field.

The degrade rule still governs the key itself, for the manifest `lint` never saw: a key on a
plugin declaring an older version is dropped and nothing throws. Such a plugin is an author's
mistake rather than a host's problem, and it fails the same way as any other undeclared
surface.


## A source whose option is not a URL yet

Some sources cannot answer a URL when the detail page is built.
A cloud-drive share is a folder that has to be opened; a catalog that scrapes its own
episode page has to go and fetch it, and a signed URL fetched an hour early is a wall by
the time somebody presses play.
Resolving every option before returning is what this avoids: a round trip **per option**
on every detail view, inside one call's budget, behind a runtime that runs one call at a
time.

So an option may carry a `pan` or a `track` instead of a `stream` — see
`GET /v1/media/{mediaId}` above for the shapes — and such a manifest declares
**`playbackTokens: true`**.

**It is a manifest fact because nothing else can see one.**
A host places a plugin's contract floor from three things: a host function it calls, a
method it exports, and a manifest fact.
`getStream` is an export and places itself; a `pan` option is none of the three, because
nothing in a plugin's source says it will return one.
Same shape as `cookieLogin.hostHeld`, `catalogsAreRemote` and `runsFetchedCode`,
and it is recorded in `contracts/contract-versions.json` under exactly the name a host
emits — a name that is not in that record reads as version 1, silently.

**An older app fails loudly rather than quietly, which is why this is a version.**
A host that predates this decodes `playbackOptions` with `stream` required, so a single
share among forty episodes fails the whole title rather than costing one row. The version
gate turns that into a refusal at install, where it is visible.

**`lint` refuses a plugin that exports `getStream` and does not declare `playbackTokens`**,
because a `track` option is the only thing that could ever call it. The converse is not
checked: a plugin declaring the fact and never emitting a token has a floor it does not
need, which costs nothing.

### `getStream(token)`

Optional. Given a `track` this source issued, answer the `stream` it stands for:

```jsonc
// getStream("…") ->
{ "url": "https://…", "mimeType": "video/mp4", "headers": { "Referer": "https://example.test/" } }
```

- **It returns a stream, never an option.** An option could carry another token, and
  nothing would bound the redemption.
- **A source that cannot produce a URL throws** — `yonto.error.unavailable(message)`
  with a sentence naming what failed — rather than answering with an empty or absent
  `url`. An answer without one is a malformed result, and a host reports it as such.
- **The host does not cache it.** A redeemed URL is short-lived, so a host redeems again
  rather than replaying one, and it runs the call with its own fetch cache bypassed: a
  signed URL scraped out of a cached page is expired before it is used.
- **A redemption happens inside a press**, which for a source that also declares
  `runsFetchedCode` means a stranger's program runs at play time as well as at read time.
  That is a fact about the playback path rather than about any one plugin, and it is why
  it is written here and not as a second disclosure key: a viewer who has agreed that a
  source downloads and runs a program cannot act differently on *when* it runs.


## What `yonto.fetch` answers

```js
const response = await yonto.fetch(url, { method, headers, body, encoding, redirect });
// { status, url, location, headers, setCookie, body, bodyBase64 }
```

A response is answered, never thrown, whatever its status: a 404 is a `status` to read.
A fetch rejects only when it has no answer it can hand back, and the code says which:

- `REQUEST_INVALID`: the plugin built a request the host will not send. The address is
  empty or not a URL, or `encoding` names a charset the host cannot decode with, or the
  request breaks a rule of the WHATWG Fetch standard (below). All are checked before
  anything is sent, so a mistyped charset costs no request to the site.
- `HOST_NOT_ALLOWED`: a gate refused a host, on the first hop or any redirect.
- `REDIRECT_REFUSED`: the host gave up on a redirect chain. A hop pointed at something that
  is not a URL, at a scheme the host does not fetch, at a URL that names no host or at one
  carrying credentials, or the
  chain ran past 20 hops or 60 seconds. The server answered; the host would not follow.
- `TIMEOUT`: the call's budget for requests ran out.
- `RESPONSE_TOO_LARGE`: the body handed back would be larger than 16 MB (below). The server
  answered; the host would not read it all.
- `REQUEST_FAILED`: the request went out and no usable answer came back — the network
  failed, or the TLS handshake did. From contract 16 that is all it means from
  `yonto.fetch`, on both hosts, which is what
  lets a plugin turn it into `unreachable` by its code alone (kangzj/yonto#651).
  Before 16, the first and third of these were `REQUEST_FAILED` too.

**The request rules are Fetch's** (https://fetch.spec.whatwg.org/), so both hosts refuse the
same requests in the same words, where undici and OkHttp each refused their own set and
surfaced it as `REQUEST_FAILED` (kangzj/yonto#651). The lists are
`tools/plugin-cli/conformance/request-rules.json`, which both hosts are held to, entry by
entry. A request is refused when:

- its method is not an HTTP token, or is a forbidden method: `CONNECT`, `TRACE`, `TRACK`;
- it is a GET or a HEAD with a body;
- its URL carries a user name or a password;
- a header name is not an HTTP token, or a header value holds anything but printable ASCII
  and tabs. This one is stricter than Fetch, which takes any byte but NUL, CR and LF,
  because OkHttp cannot send more; so a `Referer` carrying `搜索` has to be percent-encoded;
- a header is one of Fetch's forbidden request-headers: `Accept-Charset`, `Accept-Encoding`,
  `Access-Control-Request-Headers`, `Access-Control-Request-Method`,
  `Access-Control-Request-Private-Network`, `Connection`, `Content-Length`, `Cookie2`,
  `Date`, `DNT`, `Expect`, `Host`, `Keep-Alive`, `Set-Cookie`, `TE`, `Trailer`,
  `Transfer-Encoding`, `Upgrade`, `Via`, any name starting `Proxy-` or `Sec-`, and
  `X-HTTP-Method`, `X-HTTP-Method-Override` or `X-Method-Override` naming a forbidden
  method. The host owns the connection, the length and the transfer.

Fetch forbids `Cookie`, `Origin` and `Referer` too, and a plugin may set all three: Fetch
forbids them so a page cannot speak for the browser, and a plugin is no page. Sites check
`Origin` and `Referer`, shipped plugins and recorded XPTV catalogs send them, and a
`Cookie` a plugin sets goes out under the rule in *A login the host drives*. The record says
which plugin sends which.

Before sending, a host also does what Fetch does: a method that is `DELETE`, `GET`, `HEAD`,
`OPTIONS`, `POST` or `PUT` in any case is sent upper case, and any other as the plugin
spelled it; a string body with no `Content-Type` is sent as
`text/plain;charset=UTF-8`; and a POST, PUT or PATCH with no body is sent with an empty one.
A redirect to a URL carrying credentials is `REDIRECT_REFUSED`.

- `status` is the HTTP status of the response handed back. Redirects are followed unless
  `redirect: 'manual'`, so this is the last hop's.
- `url` is the URL that response came from, which after a redirect is not the one asked for.
- `location` is the response's `Location` header resolved against `url`, whatever the status,
  or `null` when it has none this host would fetch — resolved because a plugin has no `URL`
  to resolve `/elsewhere` with.
- `headers` is keyed by **lowercase** name on both hosts, whatever the server sent and
  whichever transport carried it, so `response.headers['content-type']` is how a header is
  read. Each name appears once: a header sent more than once is one name, its values joined
  with `, `. `set-cookie` is not among them: two cookies folded into one header cannot be
  split again, because an `Expires` date contains a comma.
- `setCookie` is every `Set-Cookie` the response carried, whole and in order, or an empty
  array — empty, too, on the site whose session the host holds (*A login the host drives*).
- `body` is the response decoded as text, as UTF-8 unless `encoding` names another charset.
  `bodyBase64` is the same bytes undecoded, for a page `encoding` cannot describe. It is asked
  of the host when first read, so a body crosses into the realm once unless a plugin wants its
  bytes, and it can be read only during the call that made the fetch: kept for a later call,
  reading it throws `bodyBase64 can only be read during the call that fetched it`, with no
  code. A call keeps at most 64 MB of its bodies unread (four at the limit below,
  `conformance/limits.json`'s `unreadBodyBytesPerCall`), dropping the oldest first, and a
  dropped body's `bodyBase64` throws the same. Read it where the response arrives, as
  `plugins/maccms`, `plugins/tvbox` and `plugins/xptv` do. It is still listed among the response's keys, and a copy
  (`JSON.stringify`, a spread) reads it like any other field (kangzj/yonto#333).
- A body is handed over up to **16 MB** (16,777,216 bytes). A larger one rejects the fetch
  with `RESPONSE_TOO_LARGE`, `the response from <url> was larger than the 16 MB a plugin may
  read`, and neither host buffers more of it than one byte past the limit (Jasper,
  2026-09-23, kangzj/yonto#333). `tools/plugin-cli/conformance/limits.json` holds both
  hosts to the number.
  A realm holds `body` as the decoded text, so what has to fit is that text, and its
  characters decide the cost. Text that decodes to ASCII or Latin-1 reads as `body` and
  `bodyBase64` both at 16 MB, and so does UTF-8, whose wider characters take several bytes
  each. A body that decodes to one character a byte above U+00FF takes twice the memory as
  text: on a television 16 MB of windows-1251 Cyrillic runs out of memory (14 MB reads), and
  a body that is not text at all (an image, a zip) decodes to a U+FFFD a byte and runs out
  from 12 MB (10 MB reads). The CLI reads all of these at 16 MB, because turning that much
  text into the realm's string costs the device more, so `doctor` passing such a body over
  10 MB does not mean a television can read it. `conformance/fetch-body/` holds both hosts to
  16 MB of ASCII and 10 MB that is not text.

## A plugin's store

`yonto.store` is where a plugin keeps what it worked out and would rather not work out
again — a site's current key, a 仓's config document. Values cross as JSON text, and the
host has no business reading them.

**One namespace per source, not per plugin.** Two profiles of the same plugin — two 仓, two
Jellyfin servers — share nothing and cannot read each other's keys. The reason is deletion:
removing a source removes what its plugin kept for it, and that is only decidable if the
namespace is the source's. Keys are the plugin's own shape (`config:<url>` for the 仓), so
a host that namespaced by plugin could not tell which of them belonged to the profile that
went, and emptying the namespace would take another profile's work with it.

What this costs is two profiles of one plugin re-deriving something genuinely shared. That
is one extra fetch, and no more than that, because everything in the store is a cache a
plugin can rebuild. Which is also what lets a host empty it whenever it needs to: Settings'
Clear cache does, and so does deleting the source it belonged to.

So a plugin may keep a credential of its own here — it dies with the source that carried
it — but it should not need to, and it must not keep a *viewer's* session here: the store
is a cache by contract, and Clear cache is not a log-out. A key a viewer typed belongs in
the profile, where they can see it and the editor can change it. A session a login
captured belongs to the host, and never reaches the plugin at all — see *A login the host
drives* below, and *A login the viewer finishes elsewhere* for a sign-in whose credential the
host keeps through Clear cache for the plugin in `yonto.session`, which is the place for it.

**A store has a size, the same on both hosts** (kangzj/yonto#341): a key of up to 1,024
characters, a value of up to 1,048,576 characters of the JSON text it crosses as, and 256 keys
per source. A write past any of them is refused with `STORE_REFUSED` (`REQUEST_FAILED` before
contract 16), naming the limit, and
writes nothing; overwriting a key the store already holds is never refused for the count, and
a key whose ttl has passed is dropped before the count is taken. The reason is the read, not
the disk: a host loads a store whole, so a plugin caching per title without bound would make
every later read, the first one at launch included, pay for all of it. Since a store is a
cache, a refused write is one to log and carry on from, as a failed fetch of something
optional is.

A key holding a lone surrogate is refused the same way, on both hosts (kangzj/yonto#611):
the device's store writes one as `?`, so after a restart `x\ud800` would have answered a get
for `x?`. A surrogate pair is one character and is kept. A key that is not a string is a
`TypeError` from `get`, `set` and `remove` alike (kangzj/yonto#667).

`ttlSeconds` is seconds and may be fractional; the value expires at the millisecond the clock
reads plus that, truncated. One that is not a finite number (`NaN`, `Infinity`) is a
`TypeError`; a huge one is a long ttl on both hosts rather than an overflow into the past, and
a hugely negative one has already expired.

A source that has not been saved yet — the editor testing a configuration before anything
is written down — gets a store that never reaches the disk. It lasts while that same
configuration is being tested, so a second Test reads what the first wrote (a refusal, say),
and an edited configuration starts from an empty one (kangzj/yonto#818).

## What bounds one call

**One source runs one call at a time**, however many runtimes a host builds for it.
The device builds more than one for a saved source — Home's, and the status probe's — and
holds all of them to one call at a time between them, since two calls at once would each read
the source's store before the other wrote it (kangzj/yonto#820).
A host may have several calls outstanding to a source — a screen loading while a dialog
asks — but the source answers them in turn, so **a slow call is a slow source**: everything
else queued behind it waits, whatever it was for. That is not a property of any one export.
A ceiling below is per call and starts when the call begins rather than when it was made, so
what a caller waits is its own budget *plus* everything ahead of it, and nothing here bounds
the queue.

What that costs is worth designing against rather than discovering. A source that fetches
inside `getSubSources` holds up the `getCategories` behind it, and the screen a viewer is
looking at is the one that waits.

**No call is privileged here**, `checkHealth` included: it takes the same turn as any other,
and a host may well have it and a screen's load outstanding together. What differs is only
who is waiting — `checkHealth` runs for a status line rather than in front of a viewer — so a
source with a document to read is better reading it there than on the first call a screen
happens to make. That moves the wait off the screen; it does not remove it, and a document
read on every call would still be a source that is slow for everything.

A host owes a ceiling on a call, and one mechanism is not enough for it:

- **A synchronous loop** — `while (true) {}` — is ended by an interrupt, and by nothing
  else. Nothing yields, so no deadline is ever consulted and no race can win.
  Both hosts count only the time the call spends running JS: every run is armed with what
  the call has left of the budget, and time parked in a host function is not counted
  (kangzj/yonto#478 on the device, #513 in the Node host).
  `tools/plugin-cli/conformance/call-budget/` holds both to that.
- **A call that keeps parking** — `while (true) { await yonto.fetch(…) }` — is ended by
  a deadline checked at the host-function boundary: once the call's budget of wall clock
  has passed, every async host function refuses to start, with `TIMEOUT`. The boundary is
  the one place with a complete view of such a call, because every resumption crosses it.
  A host whose interrupt is opcode-polled cannot see it any other way: a loop like that
  executes a handful of opcodes per turn, so the poll is roughly a thousand turns away and
  the call runs for as long as a thousand parks take (measured on the device, and the same
  thousand whatever the budget said).
- **One park whose length the plugin chose** — `yonto.sleep(ms)` — is refused when it
  asks for more than the call has left, because a park already begun is not cut.

**A park already begun is never cut at the boundary**, which is the rule that keeps a slow
network working: one request may take as long as the transport allows it — a minute on the
device, deliberately generous for a television a room away from its router — and it is the
*next* thing the call asks for that is refused. So the worst case for one call is its
budget plus one slow request. Both hosts give one request the same bounds: 15 s to connect,
20 s of silence while reading, and 60 s in all (`tools/plugin-cli/conformance/limits.json`).

**A call that has stopped being a call** — one that returns `new Promise(() => {})` — does
none of the things the bounds above need it to do, so both hosts end it on the wall clock at
its budget plus one slow request plus five seconds: 85 s.

**A host may queue a call's requests** rather than send them all at once — the device sends
eight of a source's at a time. A queued request has already started, so it is never refused
as late, and it ends by the budget plus one slow request like any other: one still waiting
or in flight then fails with `TIMEOUT`, so the call returns what it has. A call that ends,
however it ends, cancels the requests it left.

**A call is not over while a host function it started is still out.** A method that answers
with a `yonto.fetch(…).then(…)` it never awaited has its answer held until that request is
answered and the work on it has run, on both hosts, and that work is spent from the same
call's budget (quickjs-kt's `evaluate` waits for every async host call; the Node host has
done the same since review of kangzj/yonto#630). So what a plugin leaves running is
never charged to the call after it.

## A login the host drives

A plugin that reads a site behind a login declares where that login is:

```json
"capabilities": [
  { "type": "cookieLogin", "url": "https://site.example/", "cookieName": "session" }
]
```

**The session belongs to the host, and the plugin never sees it.** A host that can drive
that page opens it, keeps what the browser came back with beside the viewer's profile, and
attaches it to requests itself. Nothing of it reaches `yonto.config`, and there is no
`configSchema` field for it to land in — the `writesTo` that used to name one is gone, and
a manifest declaring it is refused.

That is a boundary, not a tidy-up, and it is worth stating exactly what it buys: what the
plugin can no longer take is the *credential* — the thing that keeps working after the app
is closed, on another machine, for as long as the session lives. It still calls
`yonto.fetch`, still receives the body that session unlocked, and can still send that
body anywhere its own allowlist admits. Containing the content is not attempted here.

**Where it is attached**, in both hosts, identically:

- to the capability's own **host and scheme** — `https://site.example/` means `site.example`
  over https, and a request to the same host over http carries nothing, because a
  television permits cleartext and a session on the wire is a session given away;
- **per redirect hop**, not per call: a chain that leaves the site drops it and a chain
  that comes back carries it again, for the same reason the allowlist is checked per hop;
- as `Cookie:`, **over whatever the plugin put there** — any spelling of that header a
  plugin sets is removed first, so a plugin can neither hand itself a session nor suppress
  the real one.

**And where it is withheld.** On that same site, `yonto.fetch`'s answer carries an empty
`setCookie`, whatever the site sent.
A response is also something a plugin is given, and attaching a credential on the way out
while handing it back on the way in is the same credential in the plugin's hands one call
later: a site that re-issues its session on an authenticated response — ordinary behaviour
for a WordPress gate on a refresh, and something a plugin can go looking for rather than
wait for — would hand over exactly the thing the paragraph above says it cannot take.
`HttpOnly` and `Secure` do not help, because those are instructions to a browser and a
plugin host is not one.
Withheld by **site**, not by whether a session happened to be attached to this request: a
logged-out request and a logged-in one to the same host must come back the same shape, or
the difference is an oracle telling the plugin whether a session exists.
Empty rather than absent, because this contract promises an array and a plugin reading
`.length` should not meet `undefined`.
Every other host's `Set-Cookie` reaches the plugin as it always has.

The stored credential is the whole `name=value; …` string the browser handed back and is
sent as captured. A value with no `=` in it is one somebody pasted by hand, and
`cookieName` is the name it goes under — that field's only job.

The host does not follow a rotation either: nothing on the response path writes the stored
credential, and no host function a plugin can call could have. A site that rotates its
session therefore logs the viewer out when the held copy stops being accepted, and 重新登录
is the way back. That was true before the withholding and is unchanged by it — what changed
is that the host is now the only thing that *could* follow one, which is where any fix for
it belongs.

**It costs a contract version.** A plugin declaring a host-held `cookieLogin` on an app
from before this arrived runs logged out and says nothing, which is the silent direction,
so `contracts/contract-versions.json` records it as `cookieLogin.hostHeld` and `lint`
refuses a manifest that declares one below that version.

**What a host decides for itself is which login pages it can drive.** Knowing a gate means
knowing how to tell "logged in" from "still on the form", which is a fact about one site
that no manifest carries — so a host may answer a capability naming a site it knows and
ignore every other, and the Android app does exactly that today.
`contracts/driven-logins.json` lists the pages it drives, by capability type: a `cookieLogin`
at `https://ddys.app`. `pointerLogin`, which was in the schema and deferred, is refused since
contract 17: a type both hosts accepted and ignored was a trap, and a page that needs real clicks
is what every host browser is already for.

`lint` warns about a login capability naming any other page, because both hosts accept it and a
television never offers it.

### A site behind a browser check

```json
"capabilities": [
  { "type": "browserCheck", "url": "https://site.example/" }
]
```

A `browserCheck` names a site where the plugin may send the viewer to pass a browser check,
and it arrived in contract version 17. With `url` it names one `https` site, by host and
scheme; with `"fromConfig": true` and no `url` it covers any public `https` site, and only a
plugin that declares `hostsFromConfig` may use that form. A plugin may declare several `url`
forms, one per site, for a source with mirrors.

It is not a login: there is no account, no cookie name known in advance, and nothing to log
out of. What the check wins is the host's, held beside the profile and sent back only to the
site that issued it, the way a `cookieLogin`'s session is, and never read by the plugin.

**Half built (kangzj/yonto#359).** A television records which sites each call reached,
so a challenge that passes the rules above shows as needing a check, and it holds and sends a
clearance as below. The browser a viewer passes the check in, and the rerun that proves it,
are the viewer phase, still to come, so nothing on a television writes a clearance yet.
Declaring a `browserCheck` needs `contractVersion` 17 all the same, and it is what the install
dialog discloses. See `docs/design/2026-09-23-a-challenge-the-viewer-clears.md`, and
*`CHALLENGED` asks for a browser* above for how a plugin asks.

Once a viewer has passed a check at a site, `yonto.fetch` does three things on every hop to
that site, by scheme and host exactly (on any port, as a browser scopes a cookie, but not a
subdomain and not the same host over `http`), for as
long as a `browserCheck` in the manifest still covers it and it is not the `cookieLogin` site:

- it sends the cookies the check won in the `Cookie` header, replacing any the plugin set of
  the same name and keeping the plugin's others;
- it sends the `User-Agent` the check was passed under, the television browser's own, in place
  of the plugin's, since a clearance is only good under the agent it was won with;
- it leaves out of `setCookie` every cookie of those names that site sets, and hands the
  plugin every other one.

So a plugin can tell a clearance is held, and what its cookies are called, but never read one.
A plugin whose parser was written against another agent's layout may read nothing after a
check; the television will say so on the empty state. The CLI does the same with a clearance an
author copied from their own browser, given as `YONTO_PLUGIN_CLEARANCE`,
`YONTO_PLUGIN_CLEARANCE_UA` and `YONTO_PLUGIN_CLEARANCE_SITE`, and
`tools/plugin-cli/conformance/clearances.json` holds both hosts to these rules.

`lint` refuses one with both `url` and `fromConfig` or neither, a `fromConfig` one on a plugin
without `hostsFromConfig` or beside any other `browserCheck`, one that is not `https`, one at a
private address or at a host `allowedHosts` does not admit, one on the site of the plugin's
`cookieLogin`, and one site named twice. The install dialog and the Plugins row say, per site,
that the plugin may ask the viewer to pass a check there, and for the `fromConfig` form, at any
site it chooses.

### A login the viewer finishes elsewhere

```json
"allowedHosts": ["*.plex.direct"],
"capabilities": [{ "type": "linkLogin", "service": "plex.tv" }]
```

A `linkLogin` names a service the host signs in to, and nothing else: the television shows a
short code, the viewer types it at the service's page on a phone, and the host asks the service
until it says yes. It arrived in contract version 18. `contracts/link-logins.json` is the list of
services, and each one there is data both hosts' one sign-in engine reads
(`contracts/link-login.schema.json`): where the sign-in starts and is polled and what each request
sends (a form or JSON body where the service wants one), what its answers look like (outcomes told
apart by status, by a field present, or by a field equal to a JSON string, number or boolean), where
the account's list of servers is and which of its fields is a credential or says the account owns
the server, what a server at a typed address is asked about itself, and which header each credential
goes in and how its value is written (`Bearer {credential}`, or the bare credential). A new service
is a new entry there, and a changed one is an app release; a plugin chooses none of it, because a manifest that could name the fields could
name the wrong ones. See `docs/design/2026-09-24-a-code-the-viewer-links.md`.

**The host holds the account and talks to it alone.** The credential the sign-in wins is kept
beside the profile, and goes on the host's own request for the account's servers and on nothing
the plugin writes. The plugin cannot reach the account at all: each service declares the domain
its account is on (`plex.tv` for Plex), every host its sign-in or discovery asks is at or below
it, and `lint` refuses a manifest whose `allowedHosts` admit that domain or any name below it,
exactly or through a `*.` entry, so `www.plex.tv` as much as `clients.plex.tv`. A television reads
such a `linkLogin` as absent. Every request the host makes for
it carries an identifier of the host's own for this source, which is never the plugin's
`installId()`.

**What the plugin has instead is `yonto.session`**, present only for a plugin whose `linkLogin`
a host runs:

- `yonto.session.linked()` is true while the host holds the account's credential for this
  source, so a plugin can raise `unauthenticated` before asking a server that would refuse it.
- `await yonto.session.servers()` is the account's servers as the host builds them:
  `[{ name, id, owned, connections: [{ uri, address, port, protocol, local, relay }] }]`, with no
  credential field in any entry whether or not one was bound, `owned` false for every server of a
  service that declares no owner, a server the host could not read
  left out, and every held credential masked out of every string. The host asks the account when
  its copy is older than ten minutes or a refusal marked it stale, and never more than once a
  minute per source, whatever the plugin asks; a copy is kept for the life of the process. With
  no session, or once the account has refused it, it answers `[]`. An account that cannot be read
  rejects with `REQUEST_FAILED`, or `TIMEOUT` when the call's requests ran out of time.
- `yonto.session.refused()` says a server rejected the credential attached to a request in
  this call. The host marks the list stale, so the next `servers()` asks the account again, and
  drops nothing: only the account refusing the credential the host itself sent drops the session.

**Where a server's credential goes.** For each server the account can use and does not own, and
whose credential is not the account's own, the host binds the server's credential to:

- each connection's `uri` host, port and `https` scheme, when the plugin's `allowedHosts` admit
  the host;
- the address the viewer typed into a `url` field, over the scheme and port typed, when it is an
  IP literal and a connection's `address` and `port` are that address and port. A typed name is
  never matched by what it resolves to, a manifest's default or a repo's value binds nothing, and
  before the first request carrying it the host asks the server's identity there, without a
  credential, and binds only if it names that server.

At most 32 hosts are bound. `yonto.fetch` puts the bound credential in the service's header,
written as the service declares it, on each hop to exactly that scheme, host and port, over any spelling of that header the plugin set,
and takes `Range` and `If-Range` off that hop, so an answer cannot hand a credential back in two
halves. Any other hop, a redirect off the bound host included, carries whatever the plugin set,
except that a hop to another origin (scheme, host or port) drops the plugin's own spelling of the
service's server and account headers, as it drops `Authorization` and `Cookie`, so a token the
plugin sends its own server does not follow that server's redirect.
The image loader and the player attach it the same way, per hop, to the source's posters and
streams, and keep their ranges, since what they fetch never reaches the plugin (*Media the app
fetches for a plugin*).
A server of the viewer's own is reached with the token they typed, which the plugin reads and
sends as any typed key.

**What the plugin is handed back.** Every held credential — the account's and every server's —
is replaced by `yonto-held-credential` wherever `yonto.fetch`'s answer carries it: `body` and
`bodyBase64` (masked as bytes, then both read from those), `headers`, `setCookie`, `url` and
`location`, and the words of any refusal the host builds. It is looked for as the service wrote
it, JSON-escaped (with and without `\/`), percent-encoded and form-encoded; a credential transformed any other
way is not found, which is why keeping the plugin off the account is the boundary and this is
the second line. Each of `body` and `bodyBase64` is masked when the plugin reads it, with
the credentials held then: `body` as `yonto.fetch` answers, and `bodyBase64` when it is first
read, so a credential the host learns in between is masked there too. A
`yonto.fetch` URL that carries a held credential is refused as `REQUEST_INVALID` before anything
is sent, and a redirect to one as `REDIRECT_REFUSED` before it is followed, wherever it points; a
poster or stream hop whose URL carries one is not made either. What a plugin says crosses into the host with every
held credential replaced by `‹credential›`: `yonto.log`, a thrown error's message, a `reason`
and `yonto.partial`. `tools/plugin-cli/conformance/link-login/` holds both hosts to all of this.

**Every service's answers are held to the same rules**: a code of 1 to 16 ASCII letters, digits,
`-` and single spaces; an expiry of 10 seconds to an hour, the answer's where it carries one and
the service's own where it does not; a credential of 8 to 4,096 printable
ASCII characters; a URL or QR `https`, under 2,048 characters and on the service's visit site or
below it, the visit address shown in place of one that is not. Anything else is a failed start,
not a sign-in. The poll interval is clamped to 2 to 60 seconds, a service's "slow down" (RFC 8628's
`slow_down`) widening it by the step the service declares within the same clamp, and a sign-in stops
asking after 30 minutes whatever the service says.

**How long it lasts.** The session survives Clear cache and turning the source off, and goes
with the source when it is deleted or saved on another plugin. It is kept with a record of the
service, the hosts its account was on and the plugin's `allowedHosts`, and a source built from a
plugin whose reach has grown, or whose service's account has moved, drops it rather than follow
it. A plugin of the same reach, from anywhere, keeps it.

**Where a viewer signs in.** Both hosts hold a session, list the account's servers and attach,
mask and redact as above, and a television's image loader and player attach too. A television
offers the sign-in from a press only, never because a plugin asked: the source editor's account
row, **Log in** on the source's page in Settings, and **Log in** on the error screen. A plugin
that raises `unauthenticated` while the host holds no session for it reads *Not logged in*, with
the site to log in at, and never *expired*; one that raises it while a session is held reads as a
login that expired. The sign-in screen shows the code, where to type it, a QR of the service's
link and a countdown where the code has an expiry, asks every interval (wider after a `slower`
answer), takes a new code when one expires, and stops after half an hour; Back ends it and keeps
nothing. A session won in the
editor is the saved source's, under the id the form settled when it opened, and is kept on Save.
The CLI signs in with `eval "$(yonto-plugin link)"`, which prints one line for the shell and
everything else to stderr; `run` and `doctor` then read the session from
`YONTO_PLUGIN_SESSION`, which is environment only, like `YONTO_PLUGIN_CREDENTIAL`. The
install dialog and the Plugins row say *May ask you to log in at* the service's site.

`lint` refuses a `linkLogin` naming a service no host knows, one whose plugin's `allowedHosts`
admit the account's domain or a name below it, one declared twice, one on a plugin declaring `hostsFromConfig`,
`runsFetchedCode` or `handles`, and one beside a `cookieLogin` or a `browserCheck`, which would be
two host-held credentials on one source with no merge rule. It refuses a call to
`yonto.session` from a plugin with no `linkLogin`, since there is none there on any host.

## A source, or a kind of source

A manifest says which of the two it is, in `provides`:

```json
"provides": "source"        // this plugin is a source: ddys, iyingshi
"provides": "source-type"   // this plugin is a kind of source: jellyfin, emby
```

A **source** knows its own address. 低调影视 is one site, the manifest carries it as a
`siteUrl` default, and the form a viewer would be shown has nothing in it they could
answer differently — so installing the plugin writes that profile and makes it active,
having asked nothing. A **kind of source** lives only where its owner put it: a Jellyfin,
a 仓's config document. Installing one can add nothing until somebody names a server, so it
ends on the form where they can, and there may be several such sources on one box.

**The field is required, and a host that meets a manifest without it reads
`source-type`.** Those are not in conflict. An author has to decide, so the schema refuses
a manifest that leaves it out and `lint` refuses it again with the file's name. A plugin
packaged before the field existed has to stay installable, and `source-type` is what every
such plugin already was — it is the reading under which installing means exactly what it
meant before this existed.

**Declared, not inferred.** `configSchema` almost answers it — a plugin with no required
field nothing defaults is one an install could add — and the two agree today for every
plugin here. They are still different questions: a plugin whose fields are all optional may
want each source added deliberately, and only its author knows that. What the inference is
good for is catching a declaration in a lie, and that is where `lint` uses it: **a
`source` carrying a required field with no `default` is refused**, because an install that
promised to ask nothing would then have had a question, and the profile it wrote would
fail at its first request naming a field nobody was shown.

A `bool` is never such a field, whatever it declares. It is one of two strings, a form has
no third thing to show, and a host answers `false` for one nobody touched — so a required
`bool` with no default installs exactly as `source` promises. Both halves of the CLI
exempt it, `lint` and `doctor` alike; exempting it in one was a manifest that linted clean
and then would not run.

It costs no contract version. Nothing a plugin *calls* or *exports* changes, which is what
`contracts/contract-versions.json` records, and a host that has never heard of `provides`
goes on behaving as it did — so a plugin declaring it is not thereby refused by an older
app.

## What a source is called on this box

`yonto.installId()` returns a short opaque string that names **this plugin running for
this source, on this television**. The same source gets the same answer tomorrow, after a
restart, and after Clear cache. Two sources get different answers, and so do two
televisions.

**Two plugins never get the same answer**, even for the same source and even before a
source is saved. What a host hands a plugin reaches somebody else's JavaScript, which may
send it wherever that plugin's manifest lets it reach, so an answer two plugins shared
would let their authors recognise one television between them.

It exists because a plugin has nowhere to keep such a thing. `yonto.store` is a cache —
a host empties it whenever it needs to, and deleting a source empties that source's — so a
plugin that minted an identity and kept it there was somebody new every time a viewer
cleared their caches. `plugins/jellyfin` sends it to a Jellyfin server as a device id, and
the server keeps one session per device: a fresh id left the old session in the viewer's
device list with nothing on the television able to reach or revoke it.

What it is **not** is a device identifier. It says nothing about the hardware, it is
different in every app that could ask, and it cannot be read back into a profile — a host
answers it by hashing the source's own id with a random that install made once, kept
somewhere no cache clear reaches. A plugin that needs to be recognised by a server should
send it; a plugin that wants to know which television it is on should not, because this
will not tell it.

A host that has no such notion still owes a non-empty string that does not change while it
runs, and that is still the same string the next time it runs. `tools/plugin-cli` derives
one from the plugin's own directory: an author gets the same answer every run and a
different one in somebody else's checkout, so two of them working on one plugin do not
arrive at a shared demo server as the same device.

## Parsing markup

`yonto.html.load(markup)` returns cheerio's `$` over that markup. It is real
`cheerio/slim`, not a subset of it: `find`, `attr`, `text`, `each`, `first`, `eq`, `html`,
`map`, `length`, `toArray`, and jQuery's own `:first`, `:last`, `:eq(n)` and
`:contains(text)` all work, because they are cheerio's own implementations rather than
reimplementations of them.

A subset was the other option and it does not survive contact with the job. A host can
enumerate the selectors the plugins it knows about happen to use; it cannot enumerate the
ones a plugin it has never seen will use, and running somebody else's plugin unedited is
what this was built for. The alternative already in the tree was forty-eight hand-written
regexes across two plugins, each one a small bet on a site's whitespace.

**It is a parser, not a browser, and not a licence.** There is no `window`, no `document`,
no layout, and nothing on the page is executed — a `<script>` is text like any other text.
It does not fetch: a plugin hands it markup it already has, and `yonto.fetch` is still
the only way out. And it is the one library a host ships. The realm's global surface is
exactly what `conformance/globals.json` records, unchanged by this — the parser reaches a
plugin as `yonto.html.load` and `yonto.xml.load` and by no other name, so a plugin cannot
reach cheerio's module, its version, or anything else npm would have given it.

**It compiles on first use.** The first `yonto.html.load` or `yonto.xml.load` in a
runtime pays for the parser — tens of milliseconds on a television — and every call after it
is free. A source that never parses markup never pays at all, which is most of them, because
an API-backed source reads JSON. So the cost falls on the plugins that want it, once per
runtime rather than once per page: a plugin that parses six listing pages pays for one.

**`yonto.xml.load(markup)` is the same parser in XML mode** (version 15), for a body that
is XML rather than a page: a CDATA section is text, a self-closing `<pic/>` closes itself, a
`>` inside a quoted attribute stays in the attribute, and an element nests inside one of its
own name. HTML mode gets the first two wrong, which is why this is not `html.load` read
carefully. Only the five XML entities and numeric references are decoded, as XML defines
them: an `&nbsp;` outside a CDATA section stays as written. Names are case-sensitive, so
`$('name')` does not match `<Name>`, which HTML mode lowercases. It is a separate name
rather than an options argument on `html.load`, so a plugin reaches XML mode and nothing
else of cheerio's option surface, and it shares `html.load`'s one compile — whichever is
called first pays, and the other is free.

Both hosts hand the realm the same bundle, built by one script from one pinned version, and
`conformance/host-api`'s `html`, `htmlPseudos` and `xml` cases hold them to the same parse of
the same markup. Neither host implements `load` itself — the realm does, out of source the host
supplies — which is why `src/host/surface.js` records it separately as a realm function.
It was the first such entry, `yonto.cryptoJs` (version 9) is the second, `yonto.xml.load`
(version 15) the third and `yonto.jsEncrypt` (version 20) the fourth; the test of
whether something belongs there is not that it is a parser, it is that what it returns is an
object with methods rather than data, which cannot cross the bridge.

## Hashing and ciphers

`yonto.crypto` is five primitives, string in and string out: `md5`, `sha1`, `sha256`,
`hmacSha256` and `aesCbcDecrypt`.
They cover a plugin that signs a request or reads a config somebody encrypted with a key it
already has, and they are the whole of what a plugin needs most of the time.

**`yonto.cryptoJs()` returns real CryptoJS** for the times they are not.
Version 9, and it is the same arrangement as the parser for the same reason: a facade over
those five cannot express what plugins modelling somebody else's obfuscation actually do.
There is no encryption in them at all, `aesCbcDecrypt` is CBC by its name, and
`CryptoJS.enc.Utf8.parse` returns a `WordArray` — an object with methods — which a host
function cannot hand back across the bridge.
A survey of 120 XPTV plugins for kangzj/yonto#410 found `AES.encrypt`, `mode.ECB`,
`lib.WordArray.create` and `lib.CipherParams.create` all in live use.

So the two live side by side and neither is going away.
Reach for `yonto.crypto` when it is enough: it is five calls rather than a 71 KB
compile, and a hex digest is a string rather than an object to convert.
Reach for `yonto.cryptoJs()` when you need the library — and note it is the library, so
its shapes are its own: `CryptoJS.MD5(s)` is a `WordArray` where `yonto.crypto.md5(s)` is
a hex string.

**It compiles on first use**, once per runtime, out of source the host does not hand over
until it is asked for — so a source that never calls it never pays, and a source that calls
it six times pays once. The bundle is built by one script from one pinned version, handed
to the realm inside a function so the realm gains no global, and
`conformance/host-api`'s `cryptoJs`, `cryptoJsOnce` and `cryptoJsRandom` cases hold both
hosts to the same fourteen results over the same inputs.
It is one of the entries `src/host/surface.js` records as a realm function, beside `html.load`
and `xml.load`, for the reason they are: neither host implements it in its own language.

**`yonto.jsEncrypt()` returns the `JSEncrypt` class** (jsencrypt 3.5.4, MIT), for the plugins whose
sites wrap what they serve in RSA: `new (yonto.jsEncrypt())()`, then `setPublicKey` or
`setPrivateKey` and `encrypt` or `decrypt`, and `getKey()` for the raw `doPublic` a site that
signs with its private key makes a plugin reach for.
Version 20, built and compiled on first use exactly as `yonto.cryptoJs()` is
(`scripts/build-jsencrypt.mjs`), and held to both hosts by `conformance/host-api`'s `jsEncrypt` and
`jsEncryptOnce` cases.
Its padding is random and its source is `Math.random` where crypto-js's is, so the rule above holds
for it: nothing a viewer's privacy rests on may depend on it.

**`lib.WordArray.random` is not a secure random source.**
crypto-js 4.2.0 looks for one, finds none in the realm, and throws; Yonto backs it with
`Math.random` through the bundle's own banner, which is what makes the passphrase form of
`AES.encrypt` work at all.
`tools/plugin-cli/vendor/crypto-banner.js` says what that does and does not promise, and
the short version is the rule: **nothing a viewer's privacy rests on may depend on it.**
A plugin never sees the viewer's session — the host holds it — and what a scraper encrypts
is a request body for somebody else's API.
A key, a token, or a nonce that must not repeat is not something to generate here.

## A string the host turns into bytes

Where the host makes bytes of a plugin's string — what `md5`, `sha1`, `sha256` and
`hmacSha256`'s message hash, what `base64Encode` encodes, and a `yonto.fetch` URL and
body — it writes UTF-8, and an unpaired surrogate is one U+FFFD, as `TextEncoder` writes it.
A surrogate pair is the character it encodes.
So `md5('a\ud800b')` is the hash of `a\ufffdb` on both hosts, never of `a?b`.
`conformance/host-api`'s surrogate cases hold both hosts to it.

## A plugin's clock

`yonto.now()` returns the host's idea of the current time, in epoch milliseconds, as a
number. A host owes a finite one: anything else arrives as `NaN`, and a plugin comparing
against `NaN` fails every test silently in the safe-looking direction — a site that never
rests, a cache that never hits.

A plugin measuring anything in elapsed time — how long a site that stopped answering is
rested, how long a stored config is trusted — reads it rather than `Date.now()`. The
engine's clock is inside QuickJS and no host can move it, so a rule written against it can
be proven to start and never proven to finish: a site that goes down and never comes back
passes a suite written that way.

The store's TTL is measured against the same clock, so a plugin and its store never
disagree about the time. Most of a host's own deadlines are not: a redirect chain's budget
and an engine interrupt are the host's business and stay on the real clock, or a test that
froze this one would hang instead of timing out.

**The call deadline is the exception, and reads this clock on purpose** — a rule measured
in elapsed time can only be tested by a test that can wind the clock past it, and a
deadline tested by sleeping is a deadline tested flakily. What that costs is named rather
than hidden: a test that freezes this clock *during* a call does not get the deadline, and
the call runs until something on the real clock ends it — the engine's interrupt on the
Node host, the wall-clock ceiling on the device. Bounded, and slower than expected rather
than hung.

Both hosts take the clock the way they take a transport and a store, and the conformance
suite runs them wound to the same instant — a host answering from its own wall clock reads
as a different number there.

Adding `now` was additive in one direction only, and the same is true of every host
function after it: a plugin that *calls* one is not installable on an app that lacks it. It
passes the `contractVersion` gate, then dies at the first call with
`yonto.now is not a function` — which a viewer reads as a plugin that broke rather than as
an app too old to run it, so the blame lands on the plugin's author.

A plugin that *exports* something an older app does not know to call fails more quietly
still. `getImageHeaders` is optional, so an app that has never heard of it simply does not
ask, and a plugin relying on it loses its artwork rather than failing: grey posters beside a
catalogue that works.

Both are the same question asked at install time — *can this app run this plugin?* — and
`contractVersion` answers it.

**A host speaks a range of versions, not one.** It accepts a manifest whose `contractVersion`
falls inside it and refuses one outside, naming the version. A version above the range is
the one refusal an app update would fix, so the Android app says exactly that, with the
newest version it runs. A range rather than an equality
because the two ends ship separately: an app has to keep running every plugin it always ran,
so the newest supported version moves whenever the surface grows, and the oldest moves only
when support is genuinely dropped — which is a decision about breaking installed plugins,
not a tidy-up. Comparing for equality meant no version could ever move, because the first
bump would have refused every plugin written against the one before; that is why every
forward-compatibility question used to be pushed into fields alongside it instead.

**A plugin declares the oldest version that can run it**, not the newest that exists. What
forces it up is calling a host function or exporting a method that arrived later. Declaring
more than you need is not an error but costs you: an older app refuses a plugin it could
have run.

**Version 2** added `yonto.now()` and the optional `getImageHeaders` export.

**Version 3** added the optional `onImageHeadersRefused(refused)` export — a host telling a
source that the artwork credential it gave was refused, and handing it back, which is the
only thing that lets a source renew one when its own traffic has not met the refusal first.
It also added `yonto.installId()`, which is what a source is called on this box.
Two names arriving in one version is the record working as designed rather than a version
spent twice.

**Version 4** added the optional `getSubSources` export and `yonto.subSource()` — a source
that is several interchangeable libraries, and the host saying which of them the viewer
picked. See "A source that is several".

**Version 5** added `cookieLogin.hostHeld` — a manifest fact rather than a call or an
export, and the first of those to be recorded. A plugin written for a host that holds the
session runs logged out on an older app, and silently: nothing fails, the source simply
answers as a stranger. That is what a version number is for, and it is why a manifest fact
can force one. See "A login the host drives".

**Version 6** added `yonto.error.misconfigured(reason)` — a source saying that a field its
own `configSchema` offers is blank or holds something it will not take, which no retry and
no new session can help. The paragraphs under the error table above are where it is set
against `unauthenticated`; the table itself lists both and draws no line between them.

**Version 7** added `yonto.html.load(markup)` — real cheerio in the realm, so a plugin
reads markup with selectors instead of regexes. See "Parsing markup". A plugin that calls
it on an older app passes the gate and dies at the first call with
`cannot read property 'load' of undefined`, which is the ordinary shape of a host function
arriving and the reason this is a version rather than a field.

**Version 8** added `catalogsAreRemote` — a second manifest fact, the same shape as version
5's. It says `getSubSources` may have to read a document before it can answer, and what it
buys is the wait a host may then show over an empty picker. An older app refuses a plugin that
declares it, at the version gate, since `lint` requires contract 8 for the key. "A source whose library list is itself remote" above
is where the rule is.

**Version 9** added `yonto.cryptoJs()` — real CryptoJS in the realm, for the plugins whose sites encrypt what they serve. See *Hashing and ciphers*. A plugin that calls it on an older app passes the gate and dies at the first call with `yonto.cryptoJs is not a function`, which is the ordinary shape of a host function arriving and the reason this is a version rather than a field.

**Version 10** added the `multi` `configSchema` field type and `optionsFrom` — the first field
that holds a set, and the first whose options come from the source rather than from the
manifest. An older app renders it as a text box holding the raw array, which is why the
encoding is legible rather than compact. Withdrawn in kangzj/yonto#440 (see "A field that
holds a set"): the version number stands, and the record no longer dates anything to it.

**Version 11** added `runsFetchedCode` — a third manifest fact, the same shape as version 8's
and the first whose whole value is what it puts on a screen.
It says this plugin downloads further code and runs it, and what it buys is a second line on
the install dialog.
Unlike version 8's, this one is not softer on an older app: a host that cannot draw the second
line refuses the plugin outright on the version gate, which for a disclosure beats installing
it under a dialog that says less.
"A source that runs code it fetched" above is the rule, including that and the part about what
the declaration is not.

**Version 12** added the option that is not a URL yet: `playbackTokens`, a fourth manifest
fact, and `getStream(token)`, the optional export that redeems a `track`.
Two entries in the record at one number, because they can diverge later and one key could
not — a change to `getStream` alone would have to be recorded against `getStream`.
One number today, because a host that redeems a share and not a track, or the reverse, is
a host nothing needs.
*A source whose option is not a URL yet* above is the rule, including why the shape is a
field name rather than a `kind`, and why an older app's failure is loud rather than silent.

**Version 13** added `init` on a filter group — the first piece of surface that lives in a
method's answer rather than in a call, an export or the manifest, so the record keys it
`getFilters.init`. Nothing in a plugin's source says it answers with one, so `lint` cannot
require 13; what it does is accept a declaration of exactly 13 from a plugin that exports
`getFilters` without calling it higher than needed, and say why.
An older app drops the key and shows "All" over the listing, which is what it always did,
so declaring 13 buys the opening choice rather than protecting against a failure.
The `getFilters` bullets above are the rule.

**Version 14** added `yonto.partial(reason)` — a source saying an answer is incomplete, and
why, without failing the call. A plugin that calls it on an older app passes the gate and
dies at the first call with `yonto.partial is not a function`, which turns a listing that
was only incomplete into one that failed, so this is a version rather than something an
older app may ignore. "An answer that is incomplete" above is the rule.

**Version 15** added `yonto.xml.load(markup)` — the markup parser in XML mode, for sources
whose API answers XML. See "Parsing markup". A plugin that calls it on an older app passes
the gate and dies at the first call with `cannot read property 'load' of undefined`, the
same shape as version 7.

**Version 16** added `yonto.error.unreachable(reason)` — a source saying the server it reads
did not answer, which the app marks so it can rest that server. An older app does not honour
the code and turns it into `METHOD_THREW`, an ordinary outage that drops the plugin's
sentence, so this is a version rather than a code an older app may pass over. "Yonto plugin
errors" above is the rule.
The same version gave `yonto.fetch` two rejection codes, `REQUEST_INVALID` and
`REDIRECT_REFUSED`, so that `REQUEST_FAILED` from it means only that the server gave no
usable answer. They arrived together on purpose: a plugin turning `REQUEST_FAILED` into
`unreachable` must be right on every app that has `unreachable`, and on an app with the one
and not the others it would rest a server that redirects badly (kangzj/yonto#651).
"What `yonto.fetch` answers" above lists them. For the same reason `yonto.store.set` refusing
a value became `STORE_REFUSED` in 16 rather than later (kangzj/yonto#663): a plugin names
neither code, so no later version could gate it, and at 16 `REQUEST_FAILED` means no usable
answer from every host function.

**Version 17** added the `browserCheck` capability, and the `CHALLENGED` code a plugin raises
to ask for one with `yonto.error.challenged(url)`. An app from before it drops the capability and turns the code into
`METHOD_THREW`, a generic error where a way back should be, so a manifest that declares a
`browserCheck` declares 17. "A site behind a browser check" above is the rule. The same version
refused `pointerLogin`, which no host ever drove.

**Version 18** added the `linkLogin` capability and `yonto.session`: `linked`, `servers` and
`refused`. An app from before it drops the capability and runs the source signed out with nothing
to press, so a manifest that declares a `linkLogin` declares 18. *A login the viewer finishes
elsewhere* above is the rule.

**Version 19** added `yonto`, the global a plugin reaches the host through, as the same object
as `lantern`, the host's old name, which it kept as a deprecated alias.

**Version 20** added `yonto.jsEncrypt()` — the JSEncrypt RSA class in the realm. See *Hashing and ciphers*. A plugin that calls it on an older app passes the gate and dies at the first call with `yonto.jsEncrypt is not a function`, so a plugin that names it declares 20.

**Version 21** removed `lantern`: `yonto` is the host's only name. A plugin written for an
earlier version may call `lantern` and would die at its first call, so every host refuses a
manifest declaring less than 21 (`oldest` in `contract-versions.json`) rather than run it, and
every plugin declares 21. The versions above say when each piece of surface arrived; a plugin
declares one of them again only once something arrives after 21.

**Without a version of its own**: `yonto.fetch` hands over at most 16 MB of a body,
refusing more as `RESPONSE_TOO_LARGE`, and `bodyBase64` is asked of the host when first read
(kangzj/yonto#333). Nothing a plugin writes can need either, so a version would gate
nothing: a plugin names `RESPONSE_TOO_LARGE` only to compare against it, which places no floor,
and an older app, with no limit and an eager `bodyBase64`, runs a plugin that reads it during
its call exactly as a newer one does. `REQUEST_FAILED` keeps meaning no usable answer on every
app. What changed, changed on a newer app for a plugin that fetched more than 16 MB or read
`bodyBase64` after its call, and no number a plugin declares could have protected either.

Everything else has been there since version 1.

A version number records **when a piece of surface arrived**, and nothing else. It is not a
claim that anything was ever released at the version before it — at the time version 2 was
assigned, no build carrying the plugin host had shipped at all, so there were no version-1
hosts in the field and no version-1 plugins to protect. That does not make the number wrong:
those two pieces of surface did arrive after the contract was first written, and a host that
lacks them is a host a plugin needing them cannot run on, whether or not one ever existed.

Worth stating because the two readings lead different ways. *This is version 2 because that
is when it arrived* keeps the record honest and lets the next addition be version 3 without
an argument. *This is version 2 to protect the installed base* invites someone who finds no
installed base to renumber, and renumbering a published contract is the one thing this field
cannot survive.

`lint` refuses a manifest declaring less than 21, as every host does, and reads a plugin's
source to refuse one declaring a version older than it uses, so a plugin calling something
newer than what it declares is caught on the author's machine rather than at the call on a
television.

It reads rather than runs, so there are shapes it cannot place a name from: `const { now } =
yonto`, a spread of the namespace, a computed key built at run time, and a namespace kept
as a value — `const store = yonto.store`, whose leaf is reached through a local name.
None of those is counted as version 1, and none is reported as a call to something that
does not exist either. `lint` says it found one and that the version it printed is a floor
rather than an answer, because a scan that guesses quietly is worse than one that says what
it could not read. A plain alias of a function — `const now = yonto.now` — keeps the
dotted name and places normally.

**A plugin declares what it needs to work fully, not what it needs to start.** A plugin
that feature-detects a newer host function — `typeof yonto.now === 'function' ? … : …` —
still declares the version that function arrived in, and so still refuses to install on the
older apps its fallback was written for. That is the intended answer rather than a gap in
the check: a source that quietly does less on some televisions is the failure mode artwork
already taught us about, where a poster that never authenticates reaches no test and no
screen. An author who genuinely wants two behaviours ships two plugins, and each one says
what it is. See kangzj/yonto#95 for the two alternatives this was chosen over.

`lint` refuses a version *newer* than any host speaks too. The manifest schema bounds
`contractVersion` below and not above, deliberately — a `maximum` there would make the
format's own description carry one build's capability — so the ceiling comes from
`contract-versions.json`, which knows the newest version by knowing what arrived in it. A
manifest declaring a version past the newest the record knows is refused where its author
can still change it, rather than on every television it reaches.

This does not reach backwards. An app already on a television compares against the range
*it* shipped with, so a plugin declaring something newer is still refused there with
whatever message that build had. It helps from the release that ships it onward — which is
the argument for a range now rather than at the next surface addition.

Which surface a host has is recorded in `tools/plugin-cli/conformance/host-functions.json`,
beside the language surface in `globals.json` and for the same reason: two hosts keeping
their own lists can each be green while the lists disagree, and anything deciding whether a
plugin can run here would then trust that disagreement. Both hosts are held to that file,
and each to its own running `yonto` as well, so a function added to one and not recorded
fails on both sides.

## What a call may spend

A host bounds every call it makes into a plugin, and the bound is the same number on both:
twenty seconds of the plugin's own JS.

Both hosts end a plugin that is executing with a QuickJS interrupt, which cannot end one
that is not.
An interrupt is only checked while JS is running, so a call parked in a host function is
not being watched by it at all.
Both measure the JS time a call spends, adding up its runs and leaving out the time parked
between them, so a plugin may still work on an answer that came back late, and the call is
ended once its JS alone has used the budget (kangzj/yonto#478 on the device,
kangzj/yonto#513 in the Node host).
Everything a plugin waits on therefore has to carry a bound of its own, and the two that
park are bounded differently because they are different things.

`yonto.fetch` is bounded by the host's transport, because how long a site takes is the
site's business and cutting it short would fail a slow server rather than a greedy plugin.

`yonto.sleep` is bounded by the call's own budget, because how long a sleep takes is the
*plugin's* business and nothing else was bounding it.
The budget is spent down across the call rather than applied to each sleep: a call may
sleep for twenty seconds in total, in one call to `sleep` or in a thousand.
Asking for more than is left fails the call with `TIMEOUT` at the moment of asking, rather
than sleeping what remains and failing afterwards — the verdict is the same either way, and
this way a plugin is told while it can still do something about it.
Each call is given the budget again, so a source that rests politely between pages is not
paying for what an earlier call spent.

A plugin's module body is evaluated inside the first call, after that call has started, so
its JS is spent from that call's budget and a `yonto.sleep` at module scope from that
call's sleep budget.
The device always did that; the Node host evaluated the body before the call and refused
such a sleep, until review of kangzj/yonto#630 moved it inside.
A plugin must not read `yonto` while it is being evaluated in any case — see the CLI's
own note on that.

A ceiling on any *one* sleep would not have been a bound, which is worth writing down
because it is the obvious fix and it does not work.
`while (true) { await yonto.sleep(20) }` never asks for more than the budget, so nothing
is ever clamped; measured on a television, that shape ran for as long as the plugin liked.
See kangzj/yonto#169.

## Implementing a new provider

Two ways to add a real provider:

1. **No new app code.** Stand up any HTTP service implementing this
   contract and add it as a source from the in-app Settings screen (Add
   Source > Custom HTTP: server URL, optional auth token, Test Connection,
   Save) — no rebuild required, and it's saved as a named profile alongside
   any others so switching back and forth doesn't mean re-entering
   anything. This is the intended path — the provider is a black box
   behind HTTP. Under the hood this is `SourceConfig.HttpContract`, saved
   as part of a `SourceProfile` by `SourceSettingsRepository`, and turned
   into a `HttpContentSourceAdapter` by `ContentSourceFactory`.
2. **A plugin.** For a provider that cannot speak this exact JSON shape,
   write one: **a plugin is one `.js` file**, its manifest in a
   `yonto-plugin` header comment at the top, built and diagnosed with
   `tools/plugin-cli` from `plugins/<id>/<id>-plugin.js`. It needs no
   app code at all: a viewer picks **Plugin** in Add Source and the form
   comes from the manifest's `configSchema`. `plugins/jellyfin/` is the
   reference example — it talks to a real Jellyfin media server's own REST
   API, which predates and is unrelated to this contract.
   Implementing `ContentSourceAdapter` in Kotlin was the old route and is no
   longer one: do not add a `SourceConfig` variant, a `ContentSourceFactory`
   branch or a source-type picker case for a new provider. A provider is a
   `Plugin`, and `HttpContract` is the one variant that is not.
   `SampleContentAdapter` remains the minimal in-process example with no
   network calls at all, and is what the factory falls back to when the
   plugin runtime itself is what broke.
