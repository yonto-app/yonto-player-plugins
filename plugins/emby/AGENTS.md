# emby plugin

[Emby](https://emby.media) is the self-hosted media server Jellyfin forked from in 2018, and it has a documented REST API.
This plugin is a sibling of `plugins/jellyfin/` and shares no code with it at run time: the two servers' auth, paths and one endpoint differ, and Emby's closed-source 4.x keeps moving away from Jellyfin's 12.x (kangzj/yonto#676 has the comparison).
Read `plugins/jellyfin/AGENTS.md` first: the session, the refused-credential fingerprint, the single in-flight login, the device id and the page-size cap are the same design, and that file explains why.
This one records only what is Emby's own.

Emby says a third-party client on its public API is fine, as long as it names Emby only to say it is compatible and ships no Emby code or assets (an Emby admin on the community forum, linked from #676).
Hence *Not affiliated with Emby* in the manifest's description.

## Files

- `emby-plugin.js` — the plugin: the five required methods plus `getRecommendations` and, since contract 23, `getContinueWatching`, `reportPlayback` and `setPlayed`.
- `fixtures/` and `doctor.json` — recorded from a real server, see *Fixtures*.
- `tools/plugin-cli/test/emby.test.js` — the fixtures replayed, plus a scripted server for the sign-in.
- `tools/plugin-cli/test/emby-play-state.test.js` — the play state: reads replayed, writes against a scripted server.
- `core/src/androidHostTest/kotlin/.../content/plugin/JsEmbyPluginAdapterTest.kt` — what the app makes of the answers.

Bundled in every build (`BUNDLED_PLUGIN_IDS`), and published to the yonto-app/yonto-player-plugins repo index too.

## What a real server confirmed

Checked against Emby Server 4.10.0.40 (`emby/embyserver`, arm64, in Docker) on 2026-09-24, with a throwaway admin and a four-file library of generated clips.
There is no public Emby demo server to test against (searched for one on #676; dev.emby.media's interactive API browser runs only from a server's own dashboard).
Searched again on 2026-09-24 (kangzj/yonto#754): `test.emby.media:8096` is Emby's own live server (4.7.14) but no login for it is published anywhere, and every shared account the Chinese 公益服 lists publish is dead or now needs a Telegram sign-up, so a local Docker server is still the way to test.
One trap setting that server up through its API: a library made with `POST /Library/VirtualFolders` fetches no metadata, and an item update takes genres as `GenreItems` (`[{Name}]`), silently ignoring `Genres`.

- **Sign-in** is `POST /emby/Users/AuthenticateByName` with `{Username, Pw}` and a client header, `X-Emby-Authorization: Emby Client="…", Device="…", DeviceId="…", Version="…"`. It answers `User`, `SessionInfo`, `AccessToken` and `ServerId`.
  Without a client header it answers 400. `Authorization` works as the header name too, and `MediaBrowser` works as the scheme word, but `Emby` is what Emby documents, so that is what is sent.
- **Every later call** carries `X-Emby-Token`. `Authorization: Emby Token="…"` and `MediaBrowser Token="…"` work as well; the opposite of Jellyfin 12, which answers 401 to `X-Emby-Token`.
  No token, a wrong one, or one whose session was signed out answers 401 (`Access token is invalid or expired.`).
- **An API key** (Dashboard > Advanced > Security, or `POST /Auth/Keys`) goes in the same header and reads `/Users/{id}/Views` like a login's token.
- **Signing in again with the same device id hands back the same token**, rather than replacing the session as Jellyfin does.
- **Six wrong passwords in a row did not lock a default non-admin account**, and the right one still worked after them. The refused-credential fingerprint stays anyway: it costs nothing, and a server can be set up to lock.
- **The `/emby` prefix is not required on 4.10**: bare paths answer the same. Every call uses it anyway, because it is what the spec's server URL says, and a viewer who typed an address ending in `/emby` has that stripped rather than doubled.
- **A listing leaves out `ProductionYear`, `OfficialRating` and `CommunityRating` unless `Fields` names them.** The last is where Emby differs from Jellyfin: without it every item is unrated and recommendations are empty. A detail call returns everything whether asked or not; `Fields` is sent there anyway.
- **`ProviderIds` is the title's `ids`**: `Tmdb`, `Imdb` and `Tvdb`, each present only when the server matched the title, and `{}` when it matched none (the Docker library's generated clips). A listing needs it named in `Fields`, like the rest.
- **Emby has no `/Items/Filters`** (404). Filters are `GET /emby/Genres` and `GET /emby/Years`, each with `UserId`, `ParentId`, `IncludeItemTypes` and `Recursive`, and each answers `Items` of `{Name}`. `Genres=` and `Years=` on the item listing take those names.
- **`SearchTerm` and `searchTerm` both match**, so the query binding ignores case. The plugin sends Emby's spelling.
- **Images need no token.** `/emby/Items/{id}/Images/Primary?tag=…` answers 200 without one, so artwork is unsigned and the plugin exports no `getImageHeaders`.
- **Direct play is `GET /emby/Videos/{id}/stream?Static=true` with the token in a header**, answering the file byte for byte, ranges included.
  **The item id is not a media source id on Emby**: `MediaSourceId=10` answers 400 (`Value cannot be null. (Parameter 'mediaSource')`), since the source is `mediasource_10`. Leaving `MediaSourceId` out plays the item's default source, and `PlaySessionId` is not needed either, whatever dev.emby.media's streaming page says.
  A 90-second file came back whole, a range past the one-minute mark included, from a server with no Premiere, and the emulator played it past 1:20, so the server does not cut a third-party client off at a minute.
- **Ids are short numbers** (`3` for a library, `10` for a movie). An id that is not a number answers 500, and a number nobody has answers 404.

Not checked: Emby Connect, which is not used. `PlaybackInfo` and its HLS conversion are *What the device plays*, below.

## Endpoints

| Method | Emby call |
|---|---|
| `getCategories` | `GET /emby/Users/{userId}/Views`, kept to `CollectionType` of `movies` or `tvshows` |
| `getFilters` | `GET /emby/Genres` and `GET /emby/Years`, both `?UserId&ParentId&IncludeItemTypes&Recursive` |
| `getMediaList` | `GET /emby/Users/{userId}/Items?ParentId&Recursive&IncludeItemTypes&Fields&SortBy&SortOrder`, the sort `DateLastContentAdded,DateCreated` descending unless another is picked |
| `getMediaDetail` | `GET /emby/Users/{userId}/Items/{id}`, then `?ParentId={id}&IncludeItemTypes=Episode` for a series; a film and each episode a `track` |
| `getStream` | `GET /emby/Users/{userId}/Items/{id}?Fields=MediaSources,Chapters` of the film or episode; with the device, then `GET /emby/Registrations/premiere` and `POST /emby/Items/{id}/PlaybackInfo?UserId` |
| `search` | `GET /emby/Users/{userId}/Items?SearchTerm&Recursive` |
| `getRecommendations` | `GET /emby/Users/{userId}/Items?SortBy=CommunityRating&SortOrder=Descending&Limit=10`, unrated dropped |
| `getContinueWatching` | `GET /emby/Users/{userId}/Items/Resume?Limit&MediaTypes=Video`, unfinished places only |
| `reportPlayback` | `POST /emby/Sessions/Playing`, `/Playing/Progress`, `/Playing/Stopped` |
| `setPlayed` | `POST` or `DELETE /emby/Users/{userId}/PlayedItems/{id}` |
| a subtitle file | `GET /emby/Videos/{id}/{mediaSourceId}/Subtitles/{index}/Stream.{srt\|vtt\|ass\|ssa}` |
| a conversion | the decision's `TranscodingUrl` (`/videos/{id}/master.m3u8?…`) under `/emby`, its `api_key` taken out |

A server that gives no answer is `unreachable` (contract 16); every status is an answer, so 401/403 is `unauthenticated`, 404 `notFound` and any other non-2xx `unavailable`, as is a 2xx that is not a JSON object (a proxy's sign-in page, say, or a bare `null`). Nothing rests a plugin profile today (only a catalog is wrapped by `CatalogSource`), so `unreachable` is only the more exact word. The host's own codes (`TIMEOUT`, `REDIRECT_REFUSED`, …) pass through as they are.

## The latest first (2026-10-29)

A Home shelf is a library's first page with no filters, so a listing is the latest first, and the Sort group (Recently added, Title, Year, Rating) opens on that.
On 4.10.0.40 `DateLastContentAdded` moved a series to the top when an episode was added and dated a film as `DateCreated` does; `SortOrder` takes one direction per key.
An unknown `SortBy` is an error, not a fallback.

## Play state (contract 23)

The design is `docs/design/2026-10-18-play-state-and-external-subtitles.md`. Checked on 2026-10-18 against Emby Server 4.9.3.0 (Docker `emby/embyserver_arm64v8`, a throwaway user and a library of generated 20-minute clips), driving the plugin with `yonto-plugin run`:

- **Reading.** Every item call sends `EnableUserData=true` (`false` removes `UserData`; it is on without it, as the 4.10 recordings show). `Played`, `PlaybackPositionTicks` and `LastPlayedDate` map as they do for Jellyfin (`plugins/jellyfin/AGENTS.md`). **A multi-item listing leaves out `LastPlayedDate` and `PlayCount`; a single item has them.** So a title in a list, and an episode in a series' detail, has a mark and a resume point but no `playedAt`, and the host's rule is that local progress then wins; only a film's own detail call carries the date. So once a title has local progress, the server's state can win only through a film's detail, never from a list or an episode.
- **Reporting needs a `PlaySessionId`.** Without one `Sessions/Playing` and `/Progress` answer 400 (`Value cannot be null. (Parameter 'key')`) and a `/Stopped` is accepted (204) and ignored. The plugin derives one from the device id and the item, so the three of a play agree without state; it sends no `MediaSourceId` (the item id is not one, see above, and it is not needed). A stream the server decided carries the server's own play session and media source in its `session` instead (*What the device plays*). **A stop for a play whose start the server never saw is dropped** (204, no change), which the design's skipped `start` can cause; the next full play corrects it.
- Emby decides *played* from the position on stop like Jellyfin (a stop at 1150 s of a 1200 s clip marked it played, 420 s did not), so `finished` is ignored.
- **`Items/Resume` also lists titles with nothing to resume** (a position of 0, and played ones), so the plugin keeps only `played !== true` with a position above 0. Its items have no `LastPlayedDate` either; the server's order is the recency order.
- `setPlayed` is `POST`/`DELETE /Users/{id}/PlayedItems/{id}`, both 200 with the new user data; the paths, with `/Sessions/Playing` and its two siblings, are the ones dev.emby.media's PlaystateService page lists.

## External subtitles (contract 23)

Checked on 2026-10-18 against Emby Server 4.9.3.0 in Docker, as Jellyfin's were (`plugins/jellyfin/AGENTS.md` has the rules both follow).

- The streams come from the first of the item's `MediaSources`, the default source the stream plays. A film and an episode are each a `track`, as on Jellyfin, whose `getStream` asks for its own item with `Fields=MediaSources` (a single item answered with them unasked, a listing does not; in the listing they took an episode from about 1.0 KB to 4.4 KB).
- The address names that source's own id (`mediasource_8`), which on Emby is not the item id: `/emby/Videos/{id}/{sourceId}/Subtitles/{Index}/Stream.{format}`. The server answered it without the `X-Emby-Token` header the stream carries.
- Emby calls SubRip `srt`, and converted a SAMI file to SRT as Jellyfin does. The label is `Title`, else `DisplayLanguage`; `language` is the server's two-letter code (`en`).

## Intro and credits (contract 24)

Emby keeps them as chapters, so the detail call also asks for `Chapters` (`DETAIL_ITEM_FIELDS`, `STREAM_FIELDS`).
A chapter with `MarkerType` `IntroStart` pairs into an `intro` only with the very next intro mark when that is an `IntroEnd` (an unmatched or repeated `IntroStart` is dropped), and a `CreditsStart` is `credits` with no `end`; ordinary chapters are ignored. `StartPositionTicks` is in 100 ns ticks, sent as seconds.
Declared at 23, not 24: `segments` is a result field an older app drops.
**Not measured:** the seeded Emby 4.10.0.40 accepts `Fields=Chapters` and has no markers, so the `MarkerType` names are from forum posts and 240-MP's wiki, and the fixtures' chapters are hand-written. Check them against a server with detected intros.

## Episode numbers (contract 25)

An episode's option carries `episode`, its `IndexNumber`, beside `season`, and only when the server has both `ParentIndexNumber` and `IndexNumber`: the host asks TheIntroDB by those numbers, so the label's `S1E00` defaults for an unnumbered episode are never sent as numbers.
The plugin still declares 23, since `episode` is a result field an older app drops.

## What a copy is (contract 27)

A film's option carries `video` from its default source's video stream: `Width`, `Height` and `VideoRange` in Emby's names (`SDR`, `HDR 10`, `HDR 10+`, `HLG`, `DolbyVision`, the last for every profile).
An episode carries its size alone: the listing asks `Fields=Width,Height`, which Emby 4.10 answers on each item, and never `MediaSources`; its range is only in its own media source.
Declared at 23 still. The recorded episode listing was re-keyed by hand to the `Fields` request, and its two episodes given sizes (1920x1080 and 3840x2160) the recording never asked for (kangzj/yonto#2435).

## What the device plays (2026-10-24)

`docs/design/2026-10-24-a-server-converts-what-the-device-cannot-play.md` is the design, kangzj/yonto#2434 the issue, and `plugins/jellyfin/AGENTS.md`'s section of the same name the pattern this follows; this records what Emby does differently.
Checked against the Docker Emby 4.10.0.40, with the 8K, HDR10, HLG, AVI and HEVC MKV clips of the Jellyfin check and Dolby Vision 8.1 and 5 clips made with `dovi_tool` (`generate` then `inject-rpu`, muxed by `mkvmerge`).

- **The manifest declares `deviceProfile`**, so a player's `getStream(track, { device })` posts `PlaybackInfo?UserId` with Jellyfin's DeviceProfile shape (`deviceProfileOf`), which Emby takes as it is: direct play where the file fits, else `TranscodingUrl`, an HLS conversion (`VideoResolutionNotSupported`, `ContainerNotSupported`). A film is a `track` like an episode, redeemed on Play. Anything the decision cannot answer plays the file as stored.
- **The software player's containers** (`softwareProfileOf`, kangzj/yonto#2761): where the device sends `softwarePlayer` (the Apple apps, for VLCKit), a second `DirectPlayProfile` of its containers, the video codecs it lists that the device also decodes, and its audio, so an H.264 or HEVC MKV plays as stored, only where its `VideoRange` is SDR (or unread) or a range the player's `hdr` names (none on the Mac, whose VLCKit picture shows no HDR), and never `DolbyVision`, which VLC cannot show, so those are still converted for AVPlayer. A file played as stored is `video/x-matroska` where the default source's `Container` is `mkv` (`webm` and `avi` likewise), so the player knows it from `stream?Static=true`; a `.strm` Emby never read is `strm`, and stays `video/mp4`, a hint the Apple apps read the bytes behind. Checked against the Docker 4.10.0.40 for an Apple device: the HEVC MKVs went from `Transcode` to `DirectPlay`, the Dolby Vision 8.1 and 5 MKVs and the AVI stayed converted.
- **A resumed conversion starts twice, and `StartTimeTicks` does not change it** (kangzj/yonto#2762): the first request (an fMP4's init segment) starts ffmpeg at 0, and the segment at the place stops it and starts another at `-ss` the place. Sent with `PlaybackInfo`'s `StartTimeTicks`, the address carries it and the first job still starts at 0, so the plugin sends nothing for `getStream`'s `start`. Measured on the Docker Emby with an AVI resumed at 60 s, reading the server's log.
- **The range is `VideoRange` alone.** Emby ignored `VideoRangeType`, `ExtendedVideoType` and `ExtendedVideoSubType` as conditions and honoured `VideoRange`, which it compares, ignoring case, with its own display names: `SDR`, `HDR 10`, `HDR 10+`, `HLG` and `DolbyVision` (no space, unlike the rest; the `ExtendedVideoTypes` descriptions in `MediaBrowser.Model.dll`).
- **Dolby Vision is one name for every profile**, so the plugin reads the item's `ExtendedVideoSubType` (`DoviProfile81`, `DoviProfile50`, …) and lets `DolbyVision` in for this play only when the screen shows the profile's base layer: 8.1, 7.6 and 6.1 on an HDR10 screen, 8.4 on an HLG one, the SDR-based ones (0.2, 2.2, 4.2, 8.2, 9.2) anywhere, and profile 5 only on a Dolby Vision screen.
- **Tone mapping needs Emby Premiere.** With `EnableSoftwareToneMapping` on, the log says *Tone Mapping won't be performed as it requires an active Emby Premiere subscription* and the HDR clip is converted to 8-bit H.264 untouched. So the range is a condition only when `GET /emby/Registrations/premiere`, which a plain viewer may read, says `IsRegistered: true`; an unreadable answer counts as no Premiere, and the read goes around `request`, so a refusal neither renews the login nor counts against it. It is read once per sign-in (kept with the token in memory) rather than on every play; only a settled answer is kept (a 2xx, 401, 403 or 404), so a server error or a read that got no answer is asked again next play. Whether the owner turned tone mapping on is admin-only, so a Premiere server with it off converts HDR for its range untouched, as Jellyfin does with its setting off.
- **The conversion** is H.264, with HEVC the device decodes copied (`-c:v:0 copy`) into fMP4 (`SegmentContainer=mp4`, `-hls_segment_type fmp4`) and otherwise transport stream; rate control is CRF 23 with a max rate near the source's, whatever the 200 Mbps `VideoBitrate` the address names. Its address is joined under `/emby` like every other call (bare `/videos` answers too), with the `api_key` Emby writes into it taken out; the master, variant and segments all answer to `X-Emby-Token`.
- **Subtitles**: never burned in (`SubtitleStreamIndex: -1`); a conversion offers the text tracks inside the file as files (`/Videos/{id}/{mediaSourceId}/Subtitles/{index}/Stream.srt`, which extracts an embedded one), beside the ones next to the video.
- **`session`** is `{ playSessionId, mediaSourceId, playMethod }`, with Emby's `mediasource_<id>`; reports send all three, and a stop that carries them ends the job (*Stopping ffmpeg process with q command*). A report without one is as before, with no `MediaSourceId`.
- **Emby's VOD playlist lists a last segment its ffmpeg never writes** when the file ends just past a segment boundary (a 12.02 s clip cut in 6 s segments lists three), so a player waits on it at the very end; seen with a short test clip only.

Not seen: a tone-mapped conversion (no Premiere), and a real Dolby Vision file rather than a test pattern with an injected RPU.

## Decisions for v1

- ~~Direct play only: no `PlaybackInfo` negotiation and no transcode. A file the box cannot decode fails in the player.~~ The server decides since 1.5.0 (*What the device plays*).
- No Emby Connect sign-in: its service is not in the server's spec, and it would hand back addresses nobody typed.
- An `http://` address with no port is tried as typed and then on 8096, Emby's default HTTP port as it is Jellyfin's, by `GET /emby/System/Info/Public`, which answers without a sign-in (the tutorial servers' `servers.sh` waits on it, unsigned); `plugins/jellyfin/AGENTS.md`'s *An address with no port* is the design, and this plugin repeats it (kangzj/yonto#1871).

## Fixtures

Recorded with `doctor --record` and `run … --record` against the Docker server above, signed in with an API key so no login and no password is in any of them (a request's headers are never written).
Then the recording machine's address was replaced with `https://emby.example.com` and the user id with `fixture-user-id`, in each request and body, and each file renamed to the hash of its new request; `doctor.json` names those same values, and its `apiKey` is a placeholder the replay never compares.
To re-record, point `YONTO_PLUGIN_CONFIG` at an Emby of your own with an API key and user id, record, and rewrite the address and user id the same way.
`probeQuery` is `pattern`, a title in that library.
The recording library's clips matched nothing, so their `ProviderIds` were empty: `Test Pattern` and `Blue Hour` carry invented ids (TMDB 9001 and 9002, IMDb tt9000001 and tt9000002, made up and different from each other) in the listing, search, recommendations and `Blue Hour`'s detail fixtures, and the requests were re-keyed to the `ProviderIds` field. Re-recording against a server with matched titles replaces both.
For external subtitles (kangzj/yonto#2000) the film detail (`Items/9`) and the series detail were re-keyed by hand to their `MediaSources` requests, the film's source given subtitle streams in the shape 4.9.3 answered with (a default SRT and a SAMI beside it, with a PGS file and a track inside it that are not offered), and the first episode's own answer (`Items/13?Fields=MediaSources`, `getStream`'s request) written from its recorded listing entry with a SRT and a forced ASS: hand-written in a real server's shape, not recorded.
For contract 23 the fixtures were re-keyed by hand, not re-recorded: every item request gained `EnableUserData=true` (so each file is renamed to the hash of its new request), the episode listing's two episodes got a resume point (750 s) and a not-played mark, `Test Pattern` in the movies listing got a played mark, and the Resume answer was written to match. The recorded 4.10 bodies already carried `UserData` (a played flag, no date), so the rest is as recorded.
For segments (kangzj/yonto#2285) the item requests that ask for `MediaSources` gained `Chapters` and were re-keyed by hand, and the film's (`Items/9`) and an episode's (`Items/13`) answers gained a `Chapters` array with `IntroStart`, `IntroEnd` and `CreditsStart` marks written from forum posts, not recorded.
For kangzj/yonto#2434 a film became a `track`, so `get-c2fa2b3f3e04c310.json` (the film's own `Items/9?Fields=MediaSources,Chapters`, `getStream`'s request) was written from the recorded film detail's answer, re-keyed by hand; the decision itself is tested against a scripted server, in the shape 4.10 answered with.
