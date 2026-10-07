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
  `onImageHeadersRefused` answers `renewable: false`, since only the viewer can replace a typed token.
- Every call also sends `X-Plex-Product: Yonto` and `X-Plex-Client-Identifier: lantern-<installId>`, which is how Plex tells clients apart in its dashboard.

## Endpoints

| Method | Plex call |
|---|---|
| `getCategories` | `GET /library/sections/all`, kept to `type` `movie` and `show` (a music library is `artist`) |
| `getMediaList` | `GET /library/sections/{key}/all?X-Plex-Container-Start&X-Plex-Container-Size`, 60 a page |
| `getMediaDetail` | `GET /library/metadata/{ratingKey}`, plus `/allLeaves` for a show's episodes |
| `search` | `GET /hubs/search?query&limit=50`, keeping the `movie` and `show` hubs |
| artwork | `/photo/:/transcode?url=<thumb or art>&width&height&minSize=1&upscale=1` |
| playback | the part's own `key`, `/library/parts/{id}/{changestamp}/file.<container>`: Plex's direct play |

Every call sends `Accept: application/json`; without it Plex answers XML.
Everything comes back inside a `MediaContainer`, and an answer without one is `unavailable`.
Paging arguments go in the query rather than as headers, which Plex accepts too, so each page is its own fixture.

## Things that will bite you

- **Genres are on the detail call only.** A listing's items carry no `Genre`, so the detail is where genres come from.
- **An episode's title is often just "Episode 1"** when the TV agent found nothing to match, which is what the fixtures' show looks like; the label still leads with `S1E01` so the list reads in order.
- **A part key must be a path on the server.** It is the one string from Plex that is joined straight onto the server's address, so a key not starting with a single `/` (`@evil.example/x`, `//evil.example/x`) would move the stream's host, and the token in its headers with it; such a part is not offered. Every other path is built here with its ids encoded, and a poster's `thumb` travels as an encoded query argument to the same server.
- **A stream names its type.** The contract reads a stream with no `mimeType` as HLS, and the player then fails a plain file with *Parsing manifest malformed*; so every option carries one, from the `Media`'s `container` (`video/mp4` when Plex names nothing this maps).
- **Direct play only.** The part is the file as stored, so a container or codec the television cannot decode will not play.
  Plex's transcoder (`/video/:/transcode/universal/start.*`) needs session parameters nobody here has verified.
- **A movie with several versions** (`Media`, one per file) gets one option each, labelled by `videoResolution`.
- **Remote playback**: Plex says playing from outside the server's own network needs Plex Pass or a Remote Watch Pass since 2025-04-29.
  Unverified whether a server enforces that against a third-party client; this version was only tried on the LAN.

## Fixtures

Recorded with `doctor --record` and `run --record` on 2026-09-24 from a throwaway Plex Media Server 1.43.4 (`plexinc/pms-docker`), **unclaimed**, so no account and no token was involved and none can be in them.
Its libraries were two Blender titles and a two-episode show made from 20-second test clips, plus an empty music library so the category filter has something to drop.
`doctor.json` names `http://localhost:18400`, the port it listened on, because fixture identity is the URL; nothing listens there now and nothing needs to.
An unclaimed server answers every request whatever token it carries, so a refused token has never been seen from a real server here; `test/plex.test.js` scripts it.

`fixtures/linked/resources.json` is **NOT A RECORDING**: the account's server list written by hand from Plex's documentation, since there is no account to record one (two shared servers, one owned, a player; documentation addresses, made-up tokens).
`test/plex.test.js` and `JsPlexPluginAdapterTest` answer the host's discovery with it and serve each shared server the recordings above under its own address.

To record again, run a server the same way and add the libraries through the API:

```sh
docker run -d --name plex -p 18400:32400 plexinc/pms-docker
curl -X POST -H 'Accept: application/json' \
  'http://127.0.0.1:18400/library/sections?name=Movies&type=movie&agent=tv.plex.agents.movie&scanner=Plex%20Movie&language=en-US&location=/data/Movies'
```

The TV library is the same call with `type=show`, `agent=tv.plex.agents.series` and `scanner=Plex%20TV%20Series`.
