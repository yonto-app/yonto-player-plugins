# emby plugin

[Emby](https://emby.media) is the self-hosted media server Jellyfin forked from in 2018, and it has a documented REST API.
This plugin is a sibling of `plugins/jellyfin/` and shares no code with it at run time: the two servers' auth, paths and one endpoint differ, and Emby's closed-source 4.x keeps moving away from Jellyfin's 12.x (kangzj/yonto#676 has the comparison).
Read `plugins/jellyfin/AGENTS.md` first: the session, the refused-credential fingerprint, the single in-flight login, the device id and the page-size cap are the same design, and that file explains why.
This one records only what is Emby's own.

Emby says a third-party client on its public API is fine, as long as it names Emby only to say it is compatible and ships no Emby code or assets (an Emby admin on the community forum, linked from #676).
Hence *Not affiliated with Emby* in the manifest's description.

## Files

- `emby-plugin.js` — the plugin: the five required methods plus `getRecommendations`.
- `fixtures/` and `doctor.json` — recorded from a real server, see *Fixtures*.
- `tools/plugin-cli/test/emby.test.js` — the fixtures replayed, plus a scripted server for the sign-in.
- `core/src/androidHostTest/kotlin/.../content/plugin/JsEmbyPluginAdapterTest.kt` — what the app makes of the answers.

Not bundled in the APK: it installs from a URL, or from the yonto-app/yonto-player-plugins repo index.

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
- **Emby has no `/Items/Filters`** (404). Filters are `GET /emby/Genres` and `GET /emby/Years`, each with `UserId`, `ParentId`, `IncludeItemTypes` and `Recursive`, and each answers `Items` of `{Name}`. `Genres=` and `Years=` on the item listing take those names.
- **`SearchTerm` and `searchTerm` both match**, so the query binding ignores case. The plugin sends Emby's spelling.
- **Images need no token.** `/emby/Items/{id}/Images/Primary?tag=…` answers 200 without one, so artwork is unsigned and the plugin exports no `getImageHeaders`.
- **Direct play is `GET /emby/Videos/{id}/stream?Static=true` with the token in a header**, answering the file byte for byte, ranges included.
  **The item id is not a media source id on Emby**: `MediaSourceId=10` answers 400 (`Value cannot be null. (Parameter 'mediaSource')`), since the source is `mediasource_10`. Leaving `MediaSourceId` out plays the item's default source, and `PlaySessionId` is not needed either, whatever dev.emby.media's streaming page says.
  A 90-second file came back whole, a range past the one-minute mark included, from a server with no Premiere, and the emulator played it past 1:20, so the server does not cut a third-party client off at a minute.
- **Ids are short numbers** (`3` for a library, `10` for a movie). An id that is not a number answers 500, and a number nobody has answers 404.

Not checked: Emby Connect, `PlaybackInfo` and HLS transcoding, and reporting playback progress. None of them is used.

## Endpoints

| Method | Emby call |
|---|---|
| `getCategories` | `GET /emby/Users/{userId}/Views`, kept to `CollectionType` of `movies` or `tvshows` |
| `getFilters` | `GET /emby/Genres` and `GET /emby/Years`, both `?UserId&ParentId&IncludeItemTypes&Recursive` |
| `getMediaList` | `GET /emby/Users/{userId}/Items?ParentId&Recursive&IncludeItemTypes&Fields&SortBy=SortName` |
| `getMediaDetail` | `GET /emby/Users/{userId}/Items/{id}`, then `?ParentId={id}&IncludeItemTypes=Episode` for a series |
| `search` | `GET /emby/Users/{userId}/Items?SearchTerm&Recursive` |
| `getRecommendations` | `GET /emby/Users/{userId}/Items?SortBy=CommunityRating&SortOrder=Descending&Limit=10`, unrated dropped |

A server that gives no answer is `unreachable` (contract 16); every status is an answer, so 401/403 is `unauthenticated`, 404 `notFound` and any other non-2xx `unavailable`, as is a 2xx that is not a JSON object (a proxy's sign-in page, say, or a bare `null`). Nothing rests a plugin profile today (only a catalog is wrapped by `CatalogSource`), so `unreachable` is only the more exact word. The host's own codes (`TIMEOUT`, `REDIRECT_REFUSED`, …) pass through as they are.

## Decisions for v1

- Direct play only: no `PlaybackInfo` negotiation and no transcode. A file the box cannot decode fails in the player.
- Playback progress stays in the app. Reporting it to the server needs a contract method Jellyfin and Plex want too.
- No Emby Connect sign-in: its service is not in the server's spec, and it would hand back addresses nobody typed.

## Fixtures

Recorded with `doctor --record` and `run … --record` against the Docker server above, signed in with an API key so no login and no password is in any of them (a request's headers are never written).
Then the recording machine's address was replaced with `https://emby.example.com` and the user id with `fixture-user-id`, in each request and body, and each file renamed to the hash of its new request; `doctor.json` names those same values, and its `apiKey` is a placeholder the replay never compares.
To re-record, point `YONTO_PLUGIN_CONFIG` at an Emby of your own with an API key and user id, record, and rewrite the address and user id the same way.
`probeQuery` is `pattern`, a title in that library.
