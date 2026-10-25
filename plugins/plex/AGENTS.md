# plex plugin

A [Plex Media Server](https://developer.plex.tv/pms/), read through its documented API.
Like `plugins/jellyfin/`, nothing here is scraped: the server is the viewer's own and the API has an OpenAPI spec (1.2.3 when this was written).

## Two ways to a server

Every server is one library in the app's sense, the second level behind Home's badge (not one of a Plex server's own library sections, which are this plugin's categories), and a source can have both kinds at once: the typed server's library first, then one per server a login shares (Jasper, 2026-09-25).

**A server the viewer typed** (`serverUrl`, with the optional `token` beside it) is read exactly as it was before the sign-in existed.
This is how a viewer reaches their own server, since the host binds nothing to a server the account owns.
Its library is `typed`, named by its address, and is the one read when nothing else is picked, without asking `yonto.session`; its media ids are the bare `ratingKey`, as they always were.
The typed token goes to that library alone, never to a shared server's.
A login signed out, unreadable or no longer listing the picked server leaves the typed library standing alone, except that a picked shared server whose list cannot be read is `unreachable` rather than silently swapped for the typed one.
With no typed server a bare id is `notFound`: it was a typed server's, and a shared server's `ratingKey` of the same number is another title.
The token field's label says what the design's *The typed token* says: the token Plex shows an owner is usually their whole account's, and typing it hands that to the plugin by the viewer's choice.

**Or the viewer logs in with a code** (`{ "type": "linkLogin", "service": "plex.tv" }`, contract 18).
The host runs the sign-in from `contracts/link-logins.json`, holds the account token, and lists the account's servers for `yonto.session.servers()`; the plugin cannot reach plex.tv or clients.plex.tv at all (`lint` refuses a manifest that could), and asks neither.
Each server the account shares and does not own is a library (`getSubSources`, with `catalogsAreRemote`, since the list is the account's), and a shared server's media ids are `<server id>|<ratingKey>` so History finds a title on its own server whichever library is picked.
A server is reached over its `https` `*.plex.direct` connections only. With none remembered, the plugin probes them all at once with `GET /identity`, which a server answers without a token, as Plex's own clients do: one after another, two direct connections that drop packets (a friend behind CGNAT) spend the call's budget on connect timeouts before the relay is asked. The first direct connection to answer with a 2xx wins (an error answer counts as none); a relay wins only if no direct one answers within a second of it, since a relay is bandwidth-capped. The winner is kept in `yonto.store` (`connection:<server id>`) and asked straight away next time, a relay for ten minutes only so the direct ones are probed again; one that stops answering, or answers with an error, is let go and the connections probed once more, and none answering is `unreachable`.
**A television's call waits for every request it started**, so a probing call ends only when its dead connections time out (15 s on the device), while the CLI's returns as soon as the plugin does. That is why a relay is kept for ten minutes rather than probed past on every call.
The host attaches that server's own token to every request, poster and stream on those hosts, so the plugin sends no token there: not in its headers, not in `stream.headers`, not from `getImageHeaders()`, which signs the typed server alone.
A 401 or 403 from a shared server is `yonto.session.refused()` and then `unavailable`, and the next call's `servers()` asks plex.tv again; only the host's own request refused drops the login.
Signed out with nothing typed, every call is `unauthenticated` with a sentence saying to log in or type a server.
Logged in with nothing typed and no server shared (the account's only server is the viewer's own, which is never bound), every call, `getSubSources` included, is `misconfigured`: *No Plex server is shared with this account. For your own server, add its address and token by editing the source in Settings.* `misconfigured` because the viewer is logged in and what is missing is the form's server; the app shows it as *Plex needs attention* with that sentence, and the Settings row as *Needs more details*.

**Bundled as a named exception** (Jasper, 2026-09-25, kangzj/yonto#610).
`*.plex.direct` spells the address it resolves to, so this plugin's reach is effectively any address, private ones included, and it runs with no dialog because it is our own code (`docs/agents/plugins.md`, *What is decided*).
`BundledPluginsTest` holds the manifest to exactly `*.plex.direct` plus the typed host, so widening it fails there.

**What is real and what is not.**
The typed path is measured against a real (unclaimed) server, below.
Everything past a link is **unverified**: no Plex account exists, so the resources answer, a shared server accepting the token the host attaches, whether a server minds that token beside this plugin's own `X-Plex-Client-Identifier`, and how a real relay-only server behaves have never been seen.

## Auth

- A server answers with or without a token depending on how its owner set it up: an unclaimed server answers anyone, and a claimed one answers without a token only to networks listed in *Settings → Network → List of IP addresses and networks that are allowed without auth* (`allowedNetworks`).
  Otherwise every call needs `X-Plex-Token`.
- The typed token goes **only in a header**, and only to the typed server: `X-Plex-Token` on every API call, in `stream.headers` for the player, and through `getImageHeaders()` for artwork.
  Plex also reads it from a query argument of the same name, and this plugin never uses that, because a URL ends up in logs and caches.
- Artwork of the typed server is signed because it is the typed host: the host signs `getImageHeaders()` for a profile's `url` fields and never for a `*.` entry (`ImageRequestHeaders.signableHosts`). A shared server's artwork is signed by the host with the server's own token.
- A 401 or 403 from the typed server is `unauthenticated`, with a sentence that depends on whether a token is saved: check it, or add one.
  Signed out it is raised with `{ signIn: false }`, since nothing is bound to a typed server then and no plex.tv sign-in can answer it: the app shows the sentence as refused access and offers no login (kangzj/yonto#1458).
  Signed in it is not, and the plugin calls `yonto.session.refused()` first: a typed IP literal matching one of the account's servers' connections is bound to that server's plex.tv credential (`LinkSignIn.bindingsOf`), which the host sends over the typed token once `/identity` confirms the server, so the refusal may be plex.tv's.
  `onImageHeadersRefused` answers `renewable: false`, since only the viewer can replace a typed token.
- Every call also sends `X-Plex-Product: Yonto Player` and `X-Plex-Client-Identifier: lantern-<installId>`, which is how Plex tells clients apart in its dashboard.

## Endpoints

| Method | Plex call |
|---|---|
| `getCategories` | `GET /library/sections/all`, kept to `type` `movie` and `show` (a music library is `artist`) |
| `getMediaList` | `GET /library/sections/{key}/all?X-Plex-Container-Start&X-Plex-Container-Size`, 60 a page |
| `getMediaDetail` | `GET /library/metadata/{ratingKey}?includeMarkers=1`, plus `/allLeaves` for a show's episodes; a film's version and each episode a `track` |
| `getStream` | `GET /library/metadata/{ratingKey}?includeMarkers=1` of the film or episode, for its part, its subtitle files and its markers; with the device, then `GET /` and `GET /video/:/transcode/universal/decision` |
| `search` | `GET /hubs/search?query&limit=50`, keeping the `movie` and `show` hubs |
| `getContinueWatching` | `GET /library/onDeck`: an episode is its show's summary with `optionId` the episode, a movie as it is |
| `reportPlayback` | `GET /:/timeline?identifier&ratingKey&key=/library/metadata/<rk>&state=playing\|paused\|stopped&time&duration` (ms), and `X-Plex-Session-Identifier` for a play the server decided; a `stop` with `finished` then `GET /:/scrobble?identifier&key=<rk>`, so the last word is watched |
| `setPlayed` | `GET /:/scrobble` or `/:/unscrobble` with `identifier=com.plexapp.plugins.library&key=<rk>` |
| artwork | `/photo/:/transcode?url=<thumb or art>&width&height&minSize=1&upscale=1` |
| playback | the part's own `key`, `/library/parts/{id}/{changestamp}/file.<container>`: Plex's direct play |
| a conversion | `/video/:/transcode/universal/start.m3u8` with the decision's own query |
| a subtitle file | the subtitle stream's own `key`, `/library/streams/{id}`: the file as stored |

Every call sends `Accept: application/json`; without it Plex answers XML.
Everything comes back inside a `MediaContainer`, and an answer without one is `unavailable`.
Paging arguments go in the query rather than as headers, which Plex accepts too, so each page is its own fixture.

## Play state (contract 23)

Documented by Plex's API: [the PMS OpenAPI](https://developer.plex.tv/pms/) for `/:/timeline`, `/:/scrobble`, `/:/unscrobble` and `/library/onDeck`, and the metadata fields `viewCount`, `viewOffset` (milliseconds), `lastViewedAt` (epoch seconds), and `leafCount`/`viewedLeafCount` on a show.

- A movie or episode is `played` when `viewCount > 0` and there is no `viewOffset`; with an offset it is being watched (again), `played: false` and `position` the offset in seconds, as Plex Web shows it. Plex leaves `viewCount` out of an unwatched title, so none means `played: false`. A show is `played` only by its leaf counts (its own `viewCount` is 1 after one episode), and says nothing when it has none.
- Each option's `id` is the item's `ratingKey` (the episode's, or the film's own for every version of a film), bare even on a shared server, since the `mediaId` names the server.
- Reports are GETs, like everything here, through the same typed or shared path. **A write the server refuses is thrown as `unavailable` and never calls `yonto.session.refused()`**, so a friend's library that takes no writes cannot sign the viewer out of reading it. A shared write also takes any answer as final (`fetchShared`'s `anyAnswerStands`): a read treats a non-2xx from the kept connection as a dead one and probes again, which a refusing friend would cause on every report. A finished `stop` scrobbles even when its timeline failed.
- On Deck is Plex's own list, so it holds the next unwatched episode as well as the one half watched (a half-watched episode there keeps its own `viewOffset`, so it has a `position`; the unwatched next one has none and carries the show's `lastViewedAt`, which no real half-watched answer has confirmed since the recorded list is empty).
- **Measured on a real unclaimed server (1.43.4, 2026-10-18)**: `viewCount`, `lastViewedAt`, a show's leaf counts and the effect of scrobble and unscrobble. `/:/timeline` answered 200 with `playbackState: "ignore"` and wrote no `viewOffset`, with or without a session id, a prior fetch of the part or a play queue id, and `/:/progress` did not either; with no account the server has no user to record it for. So **the timeline's effect on `viewOffset`, `viewOffset` itself, and a shared server's answer to a write have never been seen**; the tests script them from the documentation.
- The fixtures are not re-recorded for state (an unclaimed server had none to record). `get-c7100431eb1bcbc3.json` is a real On Deck answer from that server, empty, with its URL rewritten to `localhost:18400` as the others are.

## External subtitles (contract 23)

Checked on 2026-10-18 against an unclaimed Plex Media Server 1.43.4 in Docker, with SRT and SAMI files beside a film and an episode, and played on a TV emulator.

- A part's subtitle files are its `Stream` entries with `streamType` 3 and a `key` of their own (`/library/streams/{id}`); a track inside the file has no `key`. The key is joined onto the server's address like a part key, so it must be a path on that host (the same check).
- **`allLeaves` and a season's `children` carry no streams** (measured, and the recorded `allLeaves` fixture has none), and only a title's own detail does. So an episode is a `track` (the manifest declares `playbackTokens`) whose `getStream` asks for that episode's detail when it is played: one request then, not one per episode when the show opens. The token is the episode's media id (`<server id>|<ratingKey>` on a shared server), so it is redeemed on its own server. ~~A film keeps its `stream`, since its detail has the streams.~~ A film is a `track` too since 1.6.0 (*What the device plays*).
- Plex serves the file as stored (`?format=srt` answered an empty body for a SAMI one), so only SRT, WebVTT and SSA/ASS are offered.
- The label is `displayTitle`, which **Plex words in the language the request asks for**: the same file is 中文 with no `Accept-Language` and Chinese with `en`. `language` is `languageTag` (`zh`).
- No token is put in a subtitle's address: it is fetched like the stream, with the typed token in the stream's headers or, on a shared server, the server's own token the host attaches per hop.

## Intro and credits (contract 24)

A stream's `segments` are the item's `Marker` entries, asked for with `includeMarkers=1` on the metadata call (`metadataOf`, so every `getStream`).
`intro` and `credits` are kept and any other type is not; `startTimeOffset` and `endTimeOffset` are milliseconds, sent as seconds.
A credits marker with `final: true` is sent with no `end`, since Plex means the end of the file; any other marker that does not end after it starts is dropped, because a missing `end` means the end of the video and only credits may.
Declared at 23, not 24: `segments` is a result field an older app drops, so the plugin keeps its older users.
**What is measured and what is not (2026-10-22, Plex 1.43.4 on the unclaimed Docker server):** `includeMarkers=1` is accepted and the answer is otherwise unchanged. That server returned no `Marker` for a row written into its `taggings` table by hand, so the `Marker` shape (`type`, `startTimeOffset`, `endTimeOffset`, `final`) is from python-plexapi's source and Plex's support pages, not from a real answer, and the fixtures' markers are hand-written in that shape. Check it against a server that has detected markers before relying on it.

## Episode numbers (contract 25)

An episode's option carries `episode`, its `index`, beside `season`, and only when the server has both `parentIndex` and `index`: the host asks TheIntroDB by those numbers, so the label's `S1E00` defaults for an unnumbered episode are never sent as numbers.
The plugin still declares 23, since `episode` is a result field an older app drops.

## What a copy is (contract 27)

Each version of a film carries `video`: its `Media`'s `width` and `height`, and a range from its part's video stream (`streamType` 1), `dolbyVision` where `DOVIPresent`, else `hdr10` for a `colorTrc` of `smpte2084`, `hlg` for `arib-std-b67`, and `sdr` otherwise (an SDR stream lists no `colorTrc` at all).
An episode carries its size alone, from `allLeaves`' `Media`, which lists no streams.
Plex names no HDR10+, so a file with it reads HDR10. Declared at 23 still (kangzj/yonto#2435).

## What the device plays (2026-10-24)

`docs/design/2026-10-24-a-server-converts-what-the-device-cannot-play.md` is the design and kangzj/yonto#2434 the issue; Jellyfin's and Emby's `AGENTS.md` have the same section for their servers.
Measured against the unclaimed Docker Plex 1.43.4 with the 8K, HDR10, HLG, AVI and HEVC MKV clips, Dolby Vision 8.1 and 5 clips made with `dovi_tool`, and an H.264 MKV.

- **The manifest declares `deviceProfile`**, so a player's `getStream(track, { device })` asks `GET /video/:/transcode/universal/decision` and reads the first part's `decision`: `directplay` is the part as before, `transcode` (which includes copying the video into HLS) is `start.m3u8`, and anything else, or a failure, is the file as stored. A film is a `track`, one per version, redeemed on Play.
- **The device is the profile extras over `Generic`.** Plex answers 400 to a decision with no `X-Plex-Platform`, and a named platform brings its own profile (`Android`'s converts every MP4 not `optimizedForStreaming`); `Generic`'s is empty (`Resources/Profiles/Generic.xml`), so the device is only what `X-Plex-Client-Profile-Extra` says (`profileExtraOf`): an HLS `add-transcode-target` of H.264, `append-transcode-target-codec` for HEVC when the device decodes it (a codec list in the target is not read), an `add-direct-play-profile` of the device's containers and codecs in Plex's names (`mpegts`, `mov`, DTS as `dca`), and per video codec `add-limitation`s on `video.width`, `video.height` and `video.bitDepth`. Plex logs which limitation applied (`video.width limitation applies: 7680 > 1920`).
- **No bitrate cap.** With `maxVideoBitrate`, Plex counts a file it has not deeply analysed as `2147483647kbps` (*media requires deep analysis*) and turns direct streaming off, converting an MKV it would otherwise copy; without one it copies (H.264 from an MKV, HEVC into fMP4). `videoResolution` is the largest decoder's size, which caps a conversion.
- **Tone mapping needs Plex Pass.** Without it the server has no tone-mapping setting and converts HDR to 8-bit H.264 untouched (`format=pix_fmts=yuv420p`). So the range is a limitation only when the root (`GET /`) says `myPlexSubscription: true`: `video.colorTrc` not in the transfers the screen cannot show (`smpte2084` for HDR10, HDR10+ and Dolby Vision's PQ layer, `arib-std-b67` for HLG), and `video.DOVIBLCompatID` not `0` (profile 5, whose only layer is its own) unless the screen shows Dolby Vision. Plex honoured both, and `video.DOVIProfile` and `video.DOVIPresent` too. A Plex Pass server whose owner turned tone mapping off converts HDR for its range all the same, untouched, as Jellyfin does with its setting off; whether it is on is not a viewer's to read.
- **The conversion's address carries everything.** `start.m3u8` refuses a session the decision has not seen (*Denying access due to session lacking decision*), so it takes the decision's own query: the session, `X-Plex-Session-Identifier`, the product, client id, platform and profile, all of which Plex reads from the query. The player sends only the typed token in a header, as for a file. Plex names fMP4 segments `.ts` and serves them as `video/MP2T` after an `EXT-X-MAP` of `header`; ExoPlayer and AVPlayer both play them.
- **The session** is fresh for each play (the install id, the time and a random part; Plex keys its conversion by it). `session` is `{ playSession, method }`, and a report names it as `X-Plex-Session-Identifier`: the stopped timeline then ends the conversion (*Stopping transcode session*, *Whacked session*), as `/video/:/transcode/universal/stop?session` does.
- **Subtitles**: `subtitles=none`, so nothing is burned in. Plex serves no file for a track inside the video (`/library/streams/{id}` answers 501 for one), and none of `auto`, `segmented`, `sidecar` or `embedded` put one in its HLS, so a conversion offers only the subtitle files beside the video.
- **The decision and the root are read with `ask`**, for which any answer is final: a refusal never calls `yonto.session.refused()` or lets go of the kept connection, since a friend's server refusing a conversion is not the login refused (a connection that does not answer at all is still probed past, as for any call).

Not seen: a tone-mapped conversion (no Plex Pass), a shared server's decision (no account), and a real Dolby Vision file.

## Things that will bite you


- **Genres are on the detail call only.** A listing's items carry no `Genre`, so the detail is where genres come from.
- **An episode's title is often just "Episode 1"** when the TV agent found nothing to match, which is what the fixtures' show looks like; the label still leads with `S1E01` so the list reads in order.
- **A part key must be a path on the server.** It is the one string from Plex that is joined straight onto the server's address, so a key not starting with a single `/` (`@evil.example/x`, `//evil.example/x`) would move the stream's host, and the token in its headers with it; such a part is not offered. Every other path is built here with its ids encoded, and a poster's `thumb` travels as an encoded query argument to the same server.
- **A stream names its type.** The contract reads a stream with no `mimeType` as HLS, and the player then fails a plain file with *Parsing manifest malformed*; so every option carries one, from the `Media`'s `container` (`video/mp4` when Plex names nothing this maps).
- ~~**Direct play only.** The part is the file as stored, so a container or codec the television cannot decode will not play.
  Plex's transcoder (`/video/:/transcode/universal/start.*`) needs session parameters nobody here has verified.~~ The server decides since 1.6.0 (*What the device plays*).
- **A movie with several versions** (`Media`, one per file) gets one option each, labelled by `videoResolution`, each a track naming its version (`<id>#<media id>`).
- **Remote playback**: Plex says playing from outside the server's own network needs Plex Pass or a Remote Watch Pass since 2025-04-29.
  Unverified whether a server enforces that against a third-party client; this version was only tried on the LAN.

## Fixtures

Recorded with `doctor --record` and `run --record` on 2026-09-24 from a throwaway Plex Media Server 1.43.4 (`plexinc/pms-docker`), **unclaimed**, so no account and no token was involved and none can be in them.
Its libraries were two Blender titles and a two-episode show made from 20-second test clips, plus an empty music library so the category filter has something to drop.
`doctor.json` names `http://localhost:18400`, the port it listened on, because fixture identity is the URL; nothing listens there now and nothing needs to.
An unclaimed server answers every request whatever token it carries, so a refused token has never been seen from a real server here; `test/plex.test.js` scripts it.

For external subtitles (kangzj/yonto#2000) the film's detail gained an external SRT stream, and `get-b7bab93c7ac6b47f.json` (an episode's own detail, `/library/metadata/6`) was written from the recorded `allLeaves` item with the streams a 1.43.4 server lists for an episode (SRT, a forced ASS and a SAMI, which is not offered): hand-written in a real server's shape, not recorded.

`fixtures/linked/resources.json` is **NOT A RECORDING**: the account's server list written by hand from Plex's documentation, since there is no account to record one (two shared servers, one owned, a player; documentation addresses, made-up tokens).
`test/plex.test.js` and `JsPlexPluginAdapterTest` answer the host's discovery with it and serve each shared server the recordings above under its own address.

A title's `ids` come from its `Guid` entries (`tmdb://10378`, `imdb://tt…`, `tvdb://…`).
A detail lists them without being asked, as recorded, but a listing and a search leave them out unless asked with `includeGuids=1`, so those two send it.
The listing and search were recorded before that, so their fixtures were re-keyed to the `includeGuids` request and `Big Buck Bunny` was given its own `Guid`s by hand, copied from its recorded detail; a re-recording replaces both.

To record again, run a server the same way and add the libraries through the API:

```sh
docker run -d --name plex -p 18400:32400 plexinc/pms-docker
curl -X POST -H 'Accept: application/json' \
  'http://127.0.0.1:18400/library/sections?name=Movies&type=movie&agent=tv.plex.agents.movie&scanner=Plex%20Movie&language=en-US&location=/data/Movies'
```

The TV library is the same call with `type=show`, `agent=tv.plex.agents.series` and `scanner=Plex%20TV%20Series`.
For segments (kangzj/yonto#2285) the three metadata fixtures (`/library/metadata/1`, `/3` and `/6`) were re-keyed by hand to `?includeMarkers=1`, and the film's and the first episode's answers gained a `Marker` array written in the shape python-plexapi documents (an intro, a final credits marker and a `commercial` one on the film), not recorded.
