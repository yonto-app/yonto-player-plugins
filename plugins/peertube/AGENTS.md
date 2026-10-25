# peertube plugin

[PeerTube](https://joinpeertube.org) is self-hosted video hosting with a documented REST API.
One instance is one source: the viewer's own, typed into the source form.
It is the showcase for "put your own video site on the TV": a plugin for a service the viewer runs, never for someone else's catalogue.
It is installed from a URL, not bundled (`BUNDLED_PLUGIN_IDS` does not name it).

Everything below was checked against PeerTube 8.3.1 in Docker (`chocobozzz/peertube:production`, the official compose without its nginx, certbot and postfix) on 2026-10-18, through `yonto-plugin run` and on a TV emulator.
The API pages read were docs.joinpeertube.org's *REST API getting started* and the OpenAPI document it is built from (`support/doc/api/openapi.yaml` in Chocobozzz/PeerTube).

## Files

- `peertube-plugin.js`: the whole plugin, the four required methods and `getRecommendations`.
- `fixtures/` and `doctor.json`: recorded with `doctor --record` from the instance above, signed out, then moved from `http://localhost:9030` to `https://peertube.example.com` (each URL rewritten in the request and the body, and each file renamed by its new fixture identity).
- `../../tools/plugin-cli/test/peertube.test.js`: the recordings replayed, and a scripted instance for signing in.
- `core/src/androidHostTest/kotlin/.../content/plugin/JsPeerTubePluginAdapterTest.kt`: the device's QuickJS against MockWebServer, for what the app makes of the subtitles and a private stream's header.

## What it reaches

The instance's host, and only because `instanceUrl` is a `url` field: `allowedHosts` is empty, as Jellyfin's is.
So a LAN instance (`http://192.168.1.20:9000`) works when typed, and the private-address floor stays shut to everything else.

PeerTube writes absolute URLs (thumbnails, playlists, files, captions) with the hostname it is configured with, not the one the request came in on.
An instance typed by its LAN address but configured as `videos.example.com` answers with `videos.example.com` everywhere, so the posters and the stream go there, which must resolve from the TV.
The API calls go to the typed address either way.

## Categories

| Category | Call |
| --- | --- |
| Recently added (`recent`) | `GET /api/v1/videos?sort=-publishedAt` |
| Trending (`trending`) | `GET /api/v1/videos?sort=-trending` |
| My videos (`mine`), signed in only | `GET /api/v1/users/me/videos?sort=-publishedAt`, which includes the account's private and unlisted ones |
| one per local channel (`channel:<name>`) | `GET /api/v1/video-channels/{name}/videos?sort=-publishedAt` |

Channels come from `GET /api/v1/video-channels?count=100&sort=name`, which lists every channel the instance knows, followed ones included, so only `isLocal` ones become categories.
That endpoint refuses `sort=displayName` with a 400; `name` and `-createdAt` work.
A listing is 50 a page (`count` is at most 100), by `start`.
The two sorted listings and search send `isLocal=true` unless *Include videos from instances it follows* is on, so a viewer's own site shows its own videos.
On a small instance nobody has watched, `-trending` still lists every video (by date), so the category is never empty.

`search` is `GET /api/v1/search/videos?searchTarget=local`, the instance's own database rather than a search index such as SepiaSearch.
`getRecommendations` is the ten most trending.
`checkHealth` is not exported, so health is `getCategories` answering.

## A title

- The id is the video's `uuid`; `GET /api/v1/videos/{id}` takes it (or the numeric id, or `shortUUID`).
- **Artwork.** PeerTube 8.1 added `thumbnails`, several sizes of each (280x157, 850x480, 1280x720, 1920x1080 and a 1400x1400 square for podcasts on 8.3). The poster is the narrowest landscape one at least 480 wide, the backdrop the widest landscape one, and the square is never used. Older instances have only `thumbnailPath` (small) and `previewPath`, relative to the instance, and both slots get the preview.
  They are 16:9, and the app's cards are drawn as posters, so a video's thumbnail is shown in a portrait card.
- `year` is `originallyPublishedAt`'s year, else `publishedAt`'s.
- **The synopsis opens with the channel and the length** (`Garden Diaries · 2:30`, or `Live`), because the contract has no field for either, then the description.
  Descriptions are Markdown; links become their text, images go, and `**`, `__`, backticks, headings and quotes are taken off.
- `genres` is the video's PeerTube category (`Science & Technology`), when it has one. Tags are not used.
- Every video is a `movie`, with one option, *Play*.

## The stream

- **HLS first.** `streamingPlaylists[type=1].playlistUrl` is the master playlist, carrying every resolution.
  Since PeerTube 7.1 or so (not pinned down) the master also names each caption as an `EXT-X-MEDIA:TYPE=SUBTITLES` rendition, and those captions carry an `m3u8Url` in `GET /api/v1/videos/{id}/captions`, so the player already has them; the plugin does not offer them a second time.
- **Else the best web video file**, by `resolution.id`. An instance that transcodes to HLS only still lists one web video file, the audio-only one (resolution 0, `hasVideo: false`), so sorting by resolution matters: that file plays only when it is all there is.
- A video with neither, still being transcoded, is refused with a sentence rather than shown with nothing to play.
- `live: true` for `isLive`, so a live stream gets no timeline. Not checked: the test instance had live streaming off.
- **Subtitles** (contract 23's `stream.subtitles`, a result field, so the manifest still declares 21): every caption the stream does not already carry, from `GET /api/v1/videos/{id}/captions`, as WebVTT (PeerTube stores every caption as `.vtt`, converting an uploaded SRT), labelled with the language's name, `(auto-generated)` after one Whisper wrote, and tagged with PeerTube's language id (`en`, `fr`).
  The file is `fileUrl` (7.1 and later), else `captionPath` on the instance.
  The host keeps a subtitle only on the stream's own host or an `allowedHosts` one, and this manifest names none, so a caption is dropped whenever the stream is elsewhere: an instance whose videos are in object storage on another host, or a followed instance's video. For a web video on the instance's own host they are kept, which is the case that needs them.
  A failure to read the captions plays the video without them.

## Signing in

Optional: without a username and password the source is the instance's public videos, as any visitor sees them.
With both, it signs in with OAuth 2's password grant, as the PeerTube web client does: `GET /api/v1/oauth-clients/local` for the instance's own client id and secret (kept in `yonto.store` under `client`), then `POST /api/v1/users/token`, form-encoded, `grant_type=password`.
The answer is an access token (a day on 8.3), a refresh token (four weeks) and `expires_in`; they are kept under `session` with the instance and username they belong to, and every call sends `Authorization: Bearer <token>`.
A token within a minute of expiring is renewed with `grant_type=refresh_token` first, the password only if that is refused.
A 401 on a call forgets the session and tries once more; a second 401 is the account.
A source runs one call at a time and a call asks for its token one request at a time, so there is no in-flight sign-in to share and no renewed token for a late 401 to throw away, which is why this has none of Jellyfin's guards for either.
One of the two fields without the other is `misconfigured`.

- `400` with `code: invalid_grant` is a wrong username or password. Its fingerprint (`yonto.crypto.sha256` of the password, with the instance and username) is kept under `refused` for each of the ten latest instance-and-username pairs, and the same password is not sent again until one of the three changes, as Jellyfin and Emby do. PeerTube rate-limits sign-ins rather than locking an account, so this saves the instance's limiter, not the account.
- `400` with `invalid_client` forgets the stored client, since an instance reinstalled has a new one.
- `401` with `code: missing_two_factor` (and `x-peertube-otp: required; app`) is an account with two-factor sign-in, which needs a code nobody can type into a source form. It says so; the source cannot be signed in.
- `400` with `code: account_blocked` is an account the instance's moderators blocked, and says so.
  Neither of these two is remembered like a wrong password, since either can be lifted without the password changing, so each call sends the password again until it is.
- Any other refusal of the token request is the instance's error, not the viewer's.
- `429` is the instance refusing sign-ins for a while.

**A private video's stream carries the token.** Private and internal videos' files are under `/static/streaming-playlists/hls/private/` and `/static/web-videos/private/` (or `/object-storage-proxy/…/private/` with object storage) on the instance itself, and answer 401 without the session; the OpenAPI document lists OAuth2 for them, and the master playlist, the variant and its segments all answered with the header and 401 without it.
So `stream.headers` is `Authorization: Bearer <token>` for a video that `isLocal` with a URL containing `/private/`, and nothing for any other: the host sends a stream's headers to the stream's own host, and a followed instance's video must not be handed this instance's token.
PeerTube also offers `videoFileToken` (`POST /api/v1/videos/{id}/token`) to put in the URL, with `reinjectVideoFileToken=true` rewriting the playlists; the header is preferred because a URL ends up in logs and caches.
Thumbnails of a private video are public, so there is no `getImageHeaders`.

A video with a password of its own (privacy 5, PeerTube 6) answers `401` with `code: video_requires_password` and needs an `x-peertube-video-password` header; the plugin says it cannot ask for one, and does not spend the session on it.
Without an account, a private video's detail is `401` and says to add the username and password.

## Not here

- Play state. PeerTube keeps a signed-in viewer's position (`userHistory.currentTime` on a video, `PUT /api/v1/videos/{id}/watching`, `GET /api/v1/users/me/history/videos`), which contract 23's `position` and `reportPlayback` could carry; that would make the manifest declare 23.
- Playlists, subscriptions, a video password, two-factor sign-in, NSFW settings beyond what the instance and the account already apply.
- An instance on a typed address without its port is not probed on PeerTube's own port 9000, as Jellyfin's is on 8096: a public instance is behind a reverse proxy on 443.
