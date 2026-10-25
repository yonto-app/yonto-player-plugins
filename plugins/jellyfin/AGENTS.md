# jellyfin plugin

[Jellyfin](https://jellyfin.org) is a self-hosted media server with a documented REST API.
Unlike the site scrapers in this directory, nothing here is read against anyone's will and nothing is expected to change overnight: the server is the viewer's own, its API is versioned, and a field is far likelier to be added than renamed.

This plugin is a port of `app/src/main/kotlin/app/yonto/content/adapters/jellyfin/`, which the Android app deleted when it moved this source to a plugin.
That adapter had no `AGENTS.md`; its knowledge lived in comments, and this file is where that knowledge went.
Field names and shapes below were verified against a live Jellyfin 12.x server, not read off documentation.

## Files

- `<id>-plugin.js` — the whole plugin: URL building, the twelve contract methods it exports (the five required ones, plus `getRecommendations`, `getImageHeaders`, `onImageHeadersRefused`, `getStream` for an episode and, since contract 23, `getContinueWatching`, `reportPlayback` and `setPlayed`), and the mapping from Jellyfin's item shape to the contract's.
- `fixtures/` — responses keyed by `fixtureName()` (`tools/plugin-cli/src/transport/record.js`), for `doctor --replay` and the Node test. See "Fixtures" below.
- `../../tools/plugin-cli/test/jellyfin.test.js` — a fixtures-only regression test, run by `npm test`.
- `../../tools/plugin-cli/test/jellyfin-play-state.test.js` — the play state: the reads replayed from the fixtures, the writes against a scripted server.
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

## An address with no port

A bare `192.168.1.20` is saved as `http://192.168.1.20` (`SourceUrl.normalize`), which is port 80, where a Jellyfin seldom is, and the viewer was told to check their network (kangzj/yonto#1871).
So an `http://` address with no port is tried as typed and on Jellyfin's own port, 8096, path kept, the way the server's own apps do: both are asked `GET /System/Info/Public` (no sign-in needed) at once, and the first in that order to answer with a JSON object carrying a string `Id` is used, so a router's page or another service on port 80 is passed over.
That is `reach()`, awaited before the login and before every `get()`; `url()` builds on `base()`, so images and streams carry the address that answered.
The answer is kept in `yonto.store` under `address` with the address typed beside it, so later calls and runtimes do not look again, and a `REQUEST_FAILED` forgets it so the next call does (`send()`).
When neither answers, the call fails with the typed address's own failure, the network message, and asks nothing more: a host that drops packets takes a connect timeout (15 s on the TV) per request against a 20 s call budget, so asking one after another, or asking the typed address again, ended the call as a timeout instead.
When the typed address answered with something else and 8096 did not answer, the call goes on to the typed address and fails as it always did, with *not the media server*.
An address with a port, or with `https://`, is the viewer's choice and is never tried elsewhere; an `https://` one is never tried over plain http.
The host's allowlist and the private-address floor read the host alone, so the other port needs nothing from them.
The session and the refused-credential fingerprint stay tied to the address as typed.
Emby does the same, and `tools/plugin-cli/test/default-port.test.js` holds both.

## Endpoints

| Method | Jellyfin call |
|---|---|
| `getCategories` | `GET /Users/{userId}/Views`, kept to `CollectionType` of `movies` or `tvshows` |
| `getFilters` | `GET /Items/Filters?UserId&ParentId&IncludeItemTypes` |
| `getMediaList` | `GET /Users/{userId}/Items?ParentId&Recursive&IncludeItemTypes&SortBy=SortName` |
| `getMediaDetail` | `GET /Users/{userId}/Items/{id}`, then `?ParentId={id}&IncludeItemTypes=Episode` for a series; a film's one option and each episode a `track` |
| `getStream` | `GET /Users/{userId}/Items/{id}?Fields=MediaStreams` of the film or episode, for its stream and subtitle files, then, with what the device plays, `POST /Items/{id}/PlaybackInfo?UserId` for the server's decision, then `GET /MediaSegments/{id}` for its segments |
| `search` | `GET /Users/{userId}/Items?searchTerm&Recursive` |
| `getRecommendations` | `GET /Users/{userId}/Items?SortBy=CommunityRating&SortOrder=Descending&Limit=10` |
| `getContinueWatching` | `GET /Users/{userId}/Items/Resume?Limit&MediaTypes=Video` |
| `reportPlayback` | `POST /Sessions/Playing`, `/Sessions/Playing/Progress`, `/Sessions/Playing/Stopped` |
| `setPlayed` | `POST` or `DELETE /Users/{userId}/PlayedItems/{id}` |
| a subtitle file | `GET /Videos/{id}/{id}/Subtitles/{index}/Stream.{srt\|vtt\|ass\|ssa}`, the item id twice since it is the media source id too |

`checkHealth` is **not** exported on purpose.
The Kotlin interface's default probes `getCategories()`, which is exactly what a Jellyfin source did before the port; exporting one here would change what Settings reports.

## Play state (contract 23)

The design is `docs/design/2026-10-18-play-state-and-external-subtitles.md`; this is what a real Jellyfin 12.2 (Docker, 2026-10-18) confirmed.

- **Reading.** Every item call sends `EnableUserData=true`, which the server's own OpenAPI document (`/api-docs/openapi.json`, 12.2) lists as `enableUserData` on `GET /Items` and `GET /UserItems/Resume`; `Fields` does not carry it, and `EnableUserData=false` removes `UserData` altogether. `UserData.Played` is `played`, `PlaybackPositionTicks` is `position` (ticks are 100 ns, so divided by 10 000 000, and only sent above 0), and `LastPlayedDate` is `playedAt` as the server writes it (seven fractional digits, `Z`). A series carries the `Played` the server computes from its episodes. An item the server sends no `UserData` for says nothing.
- **`id`.** Each episode option and the film's one option carries the server item id.
- **Reporting.** The three events post `ItemId`, `MediaSourceId`, `PlaySessionId` and `PlayMethod` from the stream's `session` where the server decided it (*What the device plays* below), else the item id, a `PlaySessionId` derived from the device id and the item (so the three of one play agree without state) and `DirectPlay`; and `PositionTicks`, `IsPaused`. All three answer 204. `finished` is ignored: the server decides *played* from the position on stop, and it does so against the item's length (a stop at 1195 s of 1200 s marked it played, one at 420 s kept it resumable). A 2-minute test clip was marked played by a stop 30 s in, so use clips of several minutes to see a resume point (the likely cause is Jellyfin's minimum resume duration, which was not looked up). The body fields are those of `PlaybackStartInfo` and `UserItemDataDto` in that document.
- **`setPlayed`** is `POST /Users/{userId}/PlayedItems/{id}` (played) or `DELETE` (unplayed). Unmarking clears `LastPlayedDate`, which is why the design keeps a local finish over a server's *not played*.
- **`getContinueWatching`** is `Items/Resume`, which returns the unfinished movies and episodes newest first. An episode is its series with `optionId` naming the episode, and the played-state fields are the episode's. **`Shows/NextUp` is not read**: its items have no `LastPlayedDate`, so the host could not place them in the newest-first merge. Add it when the host has a rule for an item with no date.
- **The paths are the legacy `/Users/{userId}/…` ones this plugin already uses for everything.** The 12.2 document lists only `/UserItems/Resume` and `/UserPlayedItems/{itemId}?userId=` (and `/Items`), but the legacy routes answered 200 on 12.2 and are the ones older servers have, so the plugin stays on them; the day a server drops them, every call in this file moves together.
- A failed write is `unavailable` (any non-2xx), `notFound` or `unauthenticated` like every other call; the host drops it quietly.
- Checked by driving the plugin with `yonto-plugin run` against that server: a watched mark, a resume point, the three reports, `setPlayed` both ways and the Resume list. Not checked: a Jellyfin older than 12.

## External subtitles (contract 23)

Checked on 2026-10-18 against Jellyfin 12.2 in Docker, with `Movie.en.srt` and a SAMI `Movie.ko.smi` beside a film and two `.srt` beside an episode, and played on a TV emulator.

- A stream's `subtitles` are the item's `MediaStreams` that are `Type: Subtitle`, `IsExternal` and `IsTextSubtitleStream`: the files beside the video. A track inside the file is in the stream already, and a picture format (PGS, VobSub) is not text the player can take, so neither is offered.
- **A film and an episode are each a `track`** (the manifest declares `playbackTokens`) that `getStream` redeems with the item's own answer, asking for its `MediaStreams`. A film's became one on 2026-10-24, because what the server decides to send is for one play and a detail is kept; for an episode it keeps a show's listing as small as it was: with the streams in it an episode grew from about 1.0 KB to 3.6 KB on 12.2, which a long show pays on every open. It costs one request when an episode is played, which also carries the session's current token.
- The address is `/Videos/{id}/{id}/Subtitles/{Index}/Stream.{format}`, on the stream's host, fetched with the stream's `Authorization` header (the server answered it without one too). The format is the file's own for SubRip (`subrip`), WebVTT and SSA/ASS, and `srt` for any other text format, which the server converts (SAMI was).
- The label is the stream's `Title`, else its `LocalizedLanguage` (English, Korean), else the code; `language` is the server's ISO 639-2 code (`eng`), which the player reads, and `und` is left out. `IsForced` and `IsDefault` are `forced` and `default`.
- A file the server stops serving (renamed away after the detail was read: 404) is dropped from the picker when chosen, and the video plays on.


- **`Fields` is not optional.** Jellyfin omits `Overview`, `Genres` and `ProductionYear` from a response unless they are named in `Fields`. Leaving it out is not a request error — it is silently-empty data, which is what a missing `Fields` on the detail call once caused: blank synopsis and genres against a real server, while the list view looked perfectly correct.
- **List and detail ask for different fields, on purpose.** `LIST_ITEM_FIELDS` is `ProductionYear` alone because the contract's summary carries no synopsis and no genres; asking for them would pull a paragraph per item for up to `PAGE_SIZE` items a shelf, decode it, and drop it. `DETAIL_ITEM_FIELDS` is the full set, for one item at a time. The episode listing asks for no fields at all, because an episode label is built from its name and index.
- **`PAGE_SIZE` is a cap on what Home can ever show, not just a page size.** `MainViewModel.loadHome()` only ever requests page 1 and there is no "load more" anywhere, so a title past item 500 of a library is invisible until someone searches for it by name. Raising the number is not the fix; paging in `ContentRepository` / `MainViewModel` / `MediaShelf` is.
- **Images are resized server-side or they are megabytes.** A library's posters are commonly 1000×1500+ JPEGs and Jellyfin serves the original unless asked not to. `maxWidth` keeps the aspect ratio; 480 is sized for a focused 160dp card at 2× density and 1920 for a full-bleed backdrop. A shelf scroll's smoothness on a TV box is mostly this.
- **The file as stored skips `PlaybackInfo`.** With no device (a download, its size, an older app, the source's conversion turned off) `getStream` answers `/Videos/{id}/stream?static=true` with the item id reused as `mediaSourceId`, which is correct for the single-file-per-item case (verified against a live server). A library with multiple media sources per item would need the real negotiation, and the decided stream's direct play uses the same address.
- **An episode usually has no artwork of its own**, so a backdrop falls back to `ParentBackdropItemId` + `ParentBackdropImageTags`. Without it a series' hero has a hole in it.
- **Unrated titles are dropped from recommendations, not shown.** Jellyfin sorts items with no `CommunityRating` in among the rated ones, so a "best rated" shelf would otherwise lead with titles nobody rated.
- **A non-2xx logs the status and throws `yonto.error.unavailable`, never a plain `Error`.** This file used to say the opposite, and the reasoning was almost right: a plain throw reaches the host as `METHOD_THREW` and becomes an `Unavailable` carrying the status as its *cause*, which does keep the status off the television. What it missed is what the app then says instead. An `Unavailable` with no `reason` falls back to `error_unreachable_body` — "Check the TV's network connection, then try again" — so a server answering 503 told the viewer their network was down (kangzj/yonto#264). The status goes to `yonto.log` and the throw carries a sentence, which is what `iyingshi`'s `read()` always did. 401/403 and 404 use `yonto.error.*` for a different reason: they map to distinct app behaviour (`Unauthenticated`, `NotFound`). These are `HttpJsonClient`'s rules — that is where every HTTP-backed source in the app implements them.
  A 2xx that is not a JSON object (a proxy's sign-in page, a captive portal, a mistyped address that reached some other site, or valid JSON such as `null`) is `unavailable` too, with a sentence pointing at the server URL, rather than a throw reaching the app as `METHOD_THREW` with no sentence at all (kangzj/yonto#725, #753). Emby does the same.
- **Every sentence a viewer reads is a named constant at the top of the file.** `contracts/content-source-http.md` is the rule and it is narrow: a `reason` carries no status code, no URL or path, no raw config value, and it names the part of the source that failed rather than the source — the headline above it already said `Can't reach <source>`. A sentence built with a template literal is the way that gets broken, so the constants are there to make interpolating one a visible choice rather than the obvious one.

## Intro and credits (contract 24)

A stream's `segments` come from one `GET /MediaSegments/{itemId}` made when the stream is built (`getStream`, for a film and an episode).
`Intro`, `Recap`, `Preview` and `Commercial` keep their names, `Outro` is `credits`, and `Unknown` is dropped; `StartTicks` and `EndTicks` are 100 ns ticks, sent as seconds.
Any failure of the call, including the 404 a server before 10.10 answers, is a stream with no segments and never a stream that does not play.
The call is made before the stream's token is read, because a 401 on it alone renews the session and revokes a token read earlier; it is serial, so a server that hangs on it adds up to the request timeout before the stream appears.
Only credits may have no end: any other segment whose end is missing or not after its start is dropped, since the contract reads a missing `end` as "to the end of the video".
Declared at 23, not 24: `segments` is a result field an older app drops.
Measured on the Docker Jellyfin 10.10.7 (2026-10-22): the endpoint answers `{"Items":[],"TotalRecordCount":0,"StartIndex":0}` with HTTP 200 for an item with none. Segments exist only once a provider (the Chapter Segments Provider, Intro Skipper, TheIntroDB) has filled them in by a scan, so a new title has none, and the segment fields are from the SDK's `MediaSegmentDto`, not from a real non-empty answer.
`tools/plugin-cli/scripts/write-jellyfin-fixtures.js` writes the segment fixtures; the second episode's is a 404.

## Episode numbers (contract 25)

An episode's option carries `episode`, its `IndexNumber`, beside `season`, and only when the server has both `ParentIndexNumber` and `IndexNumber`: the host asks TheIntroDB by those numbers, so the label's `S1E00` defaults for an unnumbered episode are never sent as numbers.
The plugin still declares 23, since `episode` is a result field an older app drops.

## What a copy is (contract 27)

A film's option carries `video` from its video stream in the detail's `MediaStreams`: `Width`, `Height` and `VideoRangeType` (`SDR`, `HDR10`, `HDR10Plus`, `HLG`, and every `DOVI…` as `dolbyVision`, the strongest thing the file is).
An episode carries its size alone: the listing asks `Fields=Width,Height`, which Jellyfin 10.10.7 answers on each item, and never `MediaStreams`, which would weigh every open of the show; its range is only in its own streams.
Declared at 23 still, since `video` is a result field an older app drops.
The fixtures' film is a 3840x1606 `DOVIWithHDR10` stream and the episodes 1080p and 4K, written into `write-jellyfin-fixtures.js` (kangzj/yonto#2435).

## What the device plays (2026-10-24)

The design is `docs/design/2026-10-24-a-server-converts-what-the-device-cannot-play.md`; the manifest declares `deviceProfile`, so a player's `getStream(track, { device })` asks the server to decide.

- **The request** is `POST /Items/{id}/PlaybackInfo?UserId` with `DeviceProfile`, `MaxStreamingBitrate` (200 Mbps, so nothing is converted for its size), direct play, direct stream and transcoding enabled, stream copy allowed and `SubtitleStreamIndex: -1`, so no subtitle is burned in.
- **The DeviceProfile** (`deviceProfileOf`): one `DirectPlayProfile` of the device's containers, video and audio codecs (`dts` as `dts,dca`); one `CodecProfile` per video codec, `Width`, `Height` and `VideoBitDepth` at most the decoder's and `VideoRangeType` one of `SDR`, `DOVIWithSDR` and what the screen shows (`hdr10` adds `HDR10`, `HDR10Plus` and `DOVIWithHDR10`, `hlg` adds `HLG` and `DOVIWithHLG`, `dolbyVision` every `DOVI` type), since HDR10+ and Dolby Vision play as the layer under them, none `IsRequired`, so an unknown value passes; and one HLS `TranscodingProfile`: `h264` in `ts`, or `h264,hevc` in `mp4` (fMP4) where the device decodes HEVC, so HEVC is copied rather than encoded again and AVPlayer can take it. Jellyfin encodes to the first codec and copies any it lists.
- **The answer's first `MediaSources` entry**: `SupportsDirectPlay` is the static address above; otherwise `TranscodingUrl`, on the server's base, with any `api_key` or `ApiKey` taken out, since the `Authorization` header goes with every hop on the host, and `application/x-mpegURL`. A failed or unreadable decision is the static address with no `session`. A conversion's HLS carries no subtitle track, so `subtitlesOf(item, true)` adds the text tracks inside the file, at the same `/Subtitles/{Index}/Stream.{format}` address, which the server answers by extracting the track (checked with an embedded SubRip in an MKV).
- **`session`** is `{ playSessionId, mediaSourceId, playMethod }` as JSON, `DirectPlay` or `Transcode`; the stop that carries the server's `PlaySessionId` ends its encode (the log shows *Deleting partial stream file(s)* on that call's thread). With reporting off no stop is sent, and the server ends the job when its segments stop being asked for.
- **Tone mapping** is the server's *Enable tone mapping* setting; with it on, 10.10.7 with no hardware acceleration uses `tonemapx=bt2390`. With it off, HDR is converted to H.264 untouched.
- **A resume or a far seek** restarts the encode with `-ss <place> -noaccurate_seek`, at the keyframe before the place, as for Jellyfin's own clients.
- An AVI with H.264 in it was encoded again, not copied, though its only reason was `ContainerNotSupported`; an HEVC MKV was copied. That is the server's choice.
- Checked on 2026-10-24 against the Docker 10.10.7 with an 8K HEVC clip (`VideoResolutionNotSupported`), a 4K HDR10 Main10 one (`VideoBitDepthNotSupported, VideoRangeTypeNotSupported`), an SDR 1080p H.264 MP4 (direct play), an AVI and an HEVC MKV, from the TV emulator and with `yonto-plugin run`.

## Fixtures

Built from the payloads `JsJellyfinPluginAdapterTest` already asserts against, which were themselves taken from a live 12.x server.
They are not recorded from a server in this repository, because there is none.
`ProviderIds` (the title's `ids`: `Tmdb`, `Imdb`, `Tvdb`, asked for in `Fields` on a listing and a detail) is hand-added to the movie in the generator's payloads, with invented ids (TMDB 9003, IMDb tt9000003).
The movie's `UserData` is a played mark with a date, the first episode's a resume point half way in (750 s), and the series has none, so one fixture set holds all three cases the plugin reads; the Resume list is the half-watched episode.
The film's own answer carries four subtitle streams in the shape 12.2 answers with (a default SubRip, a SAMI, a PGS file and a track inside the file), and each episode's its streams: a forced ASS for the first, none for the second.
The `PlaybackInfo` answers are the server's decisions for `DEVICE`, a 1080p SDR television: the film is converted, with a key the server wrote into its address; the first episode plays as stored; the second episode's answer is a 500. Two stop reports follow, with and without the film's `session`.

Regenerate them with `node tools/plugin-cli/scripts/write-jellyfin-fixtures.js` after changing a URL this plugin builds — fixture identity is `sha256(url + "\n" + body)`, so a changed query parameter orphans its fixture and the replay transport will report a miss rather than silently serving the old one.

If you do have a server to point at, `node src/cli.js doctor <plugin-dir> --record` against it is strictly better evidence, and `probeQuery` (`bubble`, matching the fixture) should then become a title that server actually has.
