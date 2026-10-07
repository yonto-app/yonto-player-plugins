# jellyfin plugin

[Jellyfin](https://jellyfin.org) is a self-hosted media server with a documented REST API.
Unlike the site scrapers in this directory, nothing here is read against anyone's will and nothing is expected to change overnight: the server is the viewer's own, its API is versioned, and a field is far likelier to be added than renamed.

This plugin is a port of `app/src/main/kotlin/app/yonto/content/adapters/jellyfin/`, which the Android app deleted when it moved this source to a plugin.
That adapter had no `AGENTS.md`; its knowledge lived in comments, and this file is where that knowledge went.
Field names and shapes below were verified against a live Jellyfin 12.x server, not read off documentation.

## Files

- `<id>-plugin.js` — the whole plugin: URL building, the eight contract methods it exports (the five required ones, plus `getRecommendations`, `getImageHeaders` and `onImageHeadersRefused`), and the mapping from Jellyfin's item shape to the contract's.
- `fixtures/` — responses keyed by `fixtureName()` (`tools/plugin-cli/src/transport/record.js`), for `doctor --replay` and the Node test. See "Fixtures" below.
- `../../tools/plugin-cli/test/jellyfin.test.js` — a fixtures-only regression test, run by `npm test`.
- `core/src/androidHostTest/kotlin/.../content/plugin/JsJellyfinPluginAdapterTest.kt` — the real gate. It is the deleted Kotlin adapter's own test, unchanged except for its construction, asserting against `MockWebServer`.

## Auth, and the host allowlist

Either an ordinary username and password, or a server-generated API key plus a user id — `Dashboard > API Keys` and `Dashboard > Users`.
Both of those pages belong to the server's administrator, so a viewer given an account on someone else's Jellyfin — which is most people who use one — could obtain neither and could not add the source at all (kangzj/yonto#88).
`POST /Users/AuthenticateByName` hands back an `AccessToken` and the user's id, which are those same two things; to the server they are the same kind of credential as a dashboard key, and this plugin cannot tell them apart once it holds them.
The key fields stay, and stay optional, so a profile already holding a pair keeps working untouched and nobody is made to type a password they were never given.
Only `serverUrl` is required: the editor cannot express "this pair or that one", so which credential a viewer has is this plugin's question to ask, and a profile carrying neither fails with a sentence naming both rather than a bare 401.
**Whichever it is, it goes in one place: an `Authorization: MediaBrowser Token="<key>"` header.**
A 12.x server's own OpenAPI document declares exactly one security scheme — an api key in a header of that name — and answers 401 to every other form this plugin used to use: `X-Emby-Token`, `X-MediaBrowser-Token` and `?api_key=`, on JSON and on media alike. Verified against demo.jellyfin.org/stable 12.1.0, where the legacy header failed on `/Users/{id}/Views` and this one returned the libraries. Older servers have read this header for years, so there is nothing to fall back to and no version to branch on.
A poster and a stream are fetched by the image loader and the player, neither of which speaks `yonto.fetch`, and neither can be signed in a URL any more: the stream carries `headers` on its `PlaybackStream`, and artwork is covered by `getImageHeaders()`, which the app applies to the hosts this profile is allowed to reach. The key is in no URL at all now, which is also where a URL ends up — a log, a cache key, a bug report.

This is the second time this file's assertions were the thing keeping a bug alive: `JsJellyfinPluginAdapterTest` pinned `X-Emby-Token` and `api_key=`, so a plugin that could not log in to any current server had a green suite. A fixture answers whatever it is asked; only a live server can say whether a request is one a server accepts.

`configSchema` declares `serverUrl` (type `url`), `username`, `password`, `apiKey` and `userId`, and only the first is required.
A Jellyfin source is a `SourceConfig.Plugin`, and the editor draws its form from the schema above (`SourceEditorScreen`).

### What a login leaves on the television

The password is saved in the profile like every other `secret` field — an ordinary preferences DataStore in the app's private storage, masked in the form and not encrypted at rest — and it is read at login rather than kept anywhere else.
Say so plainly rather than implying a key and a password are stored differently: they are not, and a `secret` type buys a masked widget and nothing more.

What a login wins is kept in `yonto.store` under `session` — the token, the user id, and the server and username it came from.
Stored rather than re-won per call, because a login per call is a row per call in the viewer's own `Dashboard > Devices`; invalidated by comparing those last two, because a viewer who edits either would otherwise keep reaching the old server with a credential that still happens to work.

**A refused credential is remembered, and this is the part not to unpick casually.**
Jellyfin disables an ordinary account after three failed attempts, recoverable only by the administrator this whole feature exists to avoid needing — and five calls go out before a viewer has done anything, since the status probe and Home each build an adapter and ask it for artwork headers, a health check and a listing.
The two adapters' calls take turns (a saved source runs one call at a time across its runtimes, kangzj/yonto#820), so the first refusal is stored before the other adapter's call starts; before that, saving a wrong password sent it twice at once.
So a refusal stores a fingerprint under `refused` and every later attempt with the same one is refused locally.
The fingerprint hashes the password (`yonto.crypto.sha256`), so what is stored cannot be replayed, and editing the server, the username or the password is a different credential and worth one more attempt.
The last refused fingerprint is kept for each of the ten latest server-and-username pairs, not one in all, so a viewer going back and forth between two addresses or two usernames does not spend an attempt each time (kangzj/yonto#754).
One per pair rather than a list per pair, so a right password refused for another reason (a lockout the administrator then lifts) is let go by the next attempt on that account, as it was with one slot.
The cost is also the one slot's: alternating two wrong passwords on the same account spends an attempt on each switch.
A login that works clears its own pair's refusal and leaves the others.

`loggingIn` holds the one in-flight login per runtime, because `loadHome` fans out a listing per category at once: without it a revoked token meant one `AuthenticateByName` per category, each a device row, each a failed attempt against that lockout, and — since the server replaces a session per device id — each invalidating the last, which reaches some callers as a hard refusal for a session that was merely renewed.

`deviceId` is the host's answer rather than this plugin's, so `Dashboard > Devices` can tell one box from another and logging in again replaces that box's session instead of adding a row.
It used to be minted here and kept in `yonto.store`, which is a cache: Clear cache took it, the next login opened a second session, and the first was left in the device list with nothing here able to reach it.
`yonto.installId()` is stable for this source on this box and survives a cache clear, which is the whole of what this needs (kangzj/yonto#134).

A 401 on an ordinary call renews the session and repeats the call **once** (`get`, the `retried` flag), because a login's token can be revoked server-side where a dashboard key cannot: the first refusal is a session to renew, and the retry carries a token the server accepted after it, so a second refusal is this account being refused access rather than a wrong password, and retrying past that would log in again on every attempt.
It forgets the stored session **only if it is still the refused token** (`forgetSession(refused)`). Two calls holding the same revoked token race: when the second one's 401 lands after the first has already logged in again, forgetting unconditionally threw away the renewed token and logged in a third time, and since the server keeps one session per device id, the first call's retry was refused and told a viewer with full access to check the account's permissions.
That is why `get()`'s refusal for a password profile points at the account's permissions on the server, not at the username and password: those are what `attemptLogIn` refuses, and it has its own sentence.
That recovery reaches artwork too now. A refused poster makes the host tell this plugin through `onImageHeadersRefused(refused)`, handing back the headers that went out (kangzj/yonto#133, #136). It forgets the session **only when what it holds is what was refused** — a call that met a 401 first has already stored a live one, and forgetting that would throw away the token the rest of the app is carrying and win another, which this server answers by replacing the session per device id. An api key answers `renewable: false`, because only the server's owner can replace one, and the host then stops asking.

**`allowedHosts` is deliberately empty, and `serverUrl` must stay type `url`.**
A Jellyfin has no home address — unlike ddys, which has a real default site *and* a `siteUrl` field — so there is no host this manifest could honestly name, and a placeholder would read exactly like a real entry.
What makes it reachable is the rule both hosts already apply: `PluginManifest.hostsWith` (and `hostsWith` in the CLI) widen a profile's allowlist to the host of every `url` field the viewer filled in, and to nothing else.
So a `serverUrl` that stopped being `url`-typed would leave every Jellyfin profile unable to reach its own server, and `BundledPluginsTest` asserts against exactly that.

## Endpoints

| Method | Jellyfin call |
|---|---|
| `getCategories` | `GET /Users/{userId}/Views`, kept to `CollectionType` of `movies` or `tvshows` |
| `getFilters` | `GET /Items/Filters?UserId&ParentId&IncludeItemTypes` |
| `getMediaList` | `GET /Users/{userId}/Items?ParentId&Recursive&IncludeItemTypes&SortBy=SortName` |
| `getMediaDetail` | `GET /Users/{userId}/Items/{id}`, then `?ParentId={id}&IncludeItemTypes=Episode` for a series |
| `search` | `GET /Users/{userId}/Items?searchTerm&Recursive` |
| `getRecommendations` | `GET /Users/{userId}/Items?SortBy=CommunityRating&SortOrder=Descending&Limit=10` |

`checkHealth` is **not** exported on purpose.
The Kotlin interface's default probes `getCategories()`, which is exactly what a Jellyfin source did before the port; exporting one here would change what Settings reports.

## Things that will bite you

- **`Fields` is not optional.** Jellyfin omits `Overview`, `Genres` and `ProductionYear` from a response unless they are named in `Fields`. Leaving it out is not a request error — it is silently-empty data, which is what a missing `Fields` on the detail call once caused: blank synopsis and genres against a real server, while the list view looked perfectly correct.
- **List and detail ask for different fields, on purpose.** `LIST_ITEM_FIELDS` is `ProductionYear` alone because the contract's summary carries no synopsis and no genres; asking for them would pull a paragraph per item for up to `PAGE_SIZE` items a shelf, decode it, and drop it. `DETAIL_ITEM_FIELDS` is the full set, for one item at a time. The episode listing asks for no fields at all, because an episode label is built from its name and index.
- **`PAGE_SIZE` is a cap on what Home can ever show, not just a page size.** `MainViewModel.loadHome()` only ever requests page 1 and there is no "load more" anywhere, so a title past item 500 of a library is invisible until someone searches for it by name. Raising the number is not the fix; paging in `ContentRepository` / `MainViewModel` / `MediaShelf` is.
- **Images are resized server-side or they are megabytes.** A library's posters are commonly 1000×1500+ JPEGs and Jellyfin serves the original unless asked not to. `maxWidth` keeps the aspect ratio; 480 is sized for a focused 160dp card at 2× density and 1920 for a full-bleed backdrop. A shelf scroll's smoothness on a TV box is mostly this.
- **The stream URL skips `PlaybackInfo` deliberately.** `/Videos/{id}/stream?static=true` with the item id reused as `mediaSourceId` is correct for the single-file-per-item case (verified against a live server) and saves a negotiation round trip before playback starts. A library with multiple media sources per item would need the real negotiation.
- **An episode usually has no artwork of its own**, so a backdrop falls back to `ParentBackdropItemId` + `ParentBackdropImageTags`. Without it a series' hero has a hole in it.
- **Unrated titles are dropped from recommendations, not shown.** Jellyfin sorts items with no `CommunityRating` in among the rated ones, so a "best rated" shelf would otherwise lead with titles nobody rated.
- **A non-2xx logs the status and throws `yonto.error.unavailable`, never a plain `Error`.** This file used to say the opposite, and the reasoning was almost right: a plain throw reaches the host as `METHOD_THREW` and becomes an `Unavailable` carrying the status as its *cause*, which does keep the status off the television. What it missed is what the app then says instead. An `Unavailable` with no `reason` falls back to `error_unreachable_body` — "Check the TV's network connection, then try again" — so a server answering 503 told the viewer their network was down (kangzj/yonto#264). The status goes to `yonto.log` and the throw carries a sentence, which is what `iyingshi`'s `read()` always did. 401/403 and 404 use `yonto.error.*` for a different reason: they map to distinct app behaviour (`Unauthenticated`, `NotFound`). These are `HttpJsonClient`'s rules — that is where every HTTP-backed source in the app implements them.
  A 2xx that is not a JSON object (a proxy's sign-in page, a captive portal, a mistyped address that reached some other site, or valid JSON such as `null`) is `unavailable` too, with a sentence pointing at the server URL, rather than a throw reaching the app as `METHOD_THREW` with no sentence at all (kangzj/yonto#725, #753). Emby does the same.
- **Every sentence a viewer reads is a named constant at the top of the file.** `contracts/content-source-http.md` is the rule and it is narrow: a `reason` carries no status code, no URL or path, no raw config value, and it names the part of the source that failed rather than the source — the headline above it already said `Can't reach <source>`. A sentence built with a template literal is the way that gets broken, so the constants are there to make interpolating one a visible choice rather than the obvious one.

## Fixtures

Built from the payloads `JsJellyfinPluginAdapterTest` already asserts against, which were themselves taken from a live 12.x server.
They are not recorded from a server in this repository, because there is none.

Regenerate them with `node tools/plugin-cli/scripts/write-jellyfin-fixtures.js` after changing a URL this plugin builds — fixture identity is `sha256(url + "\n" + body)`, so a changed query parameter orphans its fixture and the replay transport will report a miss rather than silently serving the old one.

If you do have a server to point at, `node src/cli.js doctor <plugin-dir> --record` against it is strictly better evidence, and `probeQuery` (`bubble`, matching the fixture) should then become a title that server actually has.
