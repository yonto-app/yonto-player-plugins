# xtream plugin

One Xtream Codes panel (Xtream UI, XUI.one and the panels that copy its API), which is one source.
It is bundled, so every platform has it, and it is a `source-type`: Add source → Xtream Codes, with the server, username and password the provider gave.
It exists because a panel's M3U export is the provider's whole library in one file, often over the 32 MB a plugin may read: the one that brought it was 28 MB, 88,769 entries, 72,467 of them series episodes the export flattens into separate titles.

## What it reaches

The panel's host and nothing else: the server is a `url` field, so the host widens the allowlist to exactly that host.
The streams are the player's to open; a panel answers each with a 302 to a load balancer on another host, often a bare IP, which the player follows and the plugin never fetches.
A server pasted as the provider's whole `get.php?…` or `player_api.php` link is read as its server.

## The API

Everything is `GET <server>/player_api.php?username=…&password=…[&action=…]`, JSON, the login in every query.
So **no address is ever logged or thrown**: a request is logged by what it was for and its code or status, and a host failure the plugin has no sentence for is thrown again with its code alone, since the host's own message can name the URL.

- No `action`: the account. `user_info.auth` is `1` for a login it took, `status` is `Active`, `Expired`, `Banned` or `Disabled`, and `allowed_output_formats` says whether TS, HLS or both may be used.
  XUI answers a refused login with a 404 for the whole API rather than `auth: 0`, so a 404 is worded as either.
- `get_live_categories`, `get_vod_categories`, `get_series_categories`: `[{category_id, category_name, parent_id}]`.
- `get_live_streams`, `get_vod_streams`, `get_series`, each with `category_id` for one category or without it for the whole library.
  Films carry `stream_id`, `title` (no year; `name` has it), `year`, `stream_icon`, `added` and `container_extension`; series carry `series_id`, `cover`, `last_modified`; channels `stream_id`, `num` and `stream_icon`.
- `get_vod_info&vod_id=`: `info` (plot, genre, `cover_big`, `backdrop_path`, `releasedate`) and `movie_data`. A film it does not have is `{"info":[]}`.
- `get_series_info&series_id=`: `info`, `seasons` and `episodes`, keyed by season, as an object or an array, each episode with its own `id`, `episode_num`, `title` (`Show - S01E01 - Name`) and `container_extension`. A series it does not have has a null `info.name`.
- Streams: `<server>/live/<user>/<pass>/<id>.ts` (or `.m3u8`), `<server>/movie/<user>/<pass>/<id>.<ext>`, `<server>/series/<user>/<pass>/<episode id>.<ext>`.
  A channel is TS, which is what the panel's own playlist hands out, and HLS only for an account whose formats leave TS out.
  Every stream says a `mimeType` (contract rule: none means HLS), TS and files `video/mp4` so the player sniffs them, as the m3u plugin does.

There is **no search** in the API.

## Shape

Three categories, Live TV, Films and Series, each only where the panel has a category of it, and a Category filter of the panel's own categories whose `init` is the first, with no "all", since a big panel's whole film list cannot be read in one piece.
A listing is one category, 60 a page from the category read once and held five minutes; films and series the latest first by `added` and `last_modified`, channels in the panel's `num` order.
A series is a `SERIES` whose options are its episodes, each with its stream, `season` and `episode`.
Ids are `live:<id>`, `movie:<id>` and `series:<id>`. A channel's page is found in a listing already read, else in the whole channel list, which is small.

## Search

Search reads each library's whole list once, builds an index of its titles and searches that, so a search after the first asks the panel for the account at most, every five minutes as every call does.
A list over the 32 MB limit (or one a panel answers empty) is read one category at a time instead.
A category over the limit is passed over for good; one that failed goes behind every category not tried yet, so one that times out cannot hold up the rest, and after three failed searches it is given up on too, the answer then saying *couldn't be searched*. A whole list that failed is asked again by the next search, and the other libraries are searched meanwhile. Only a panel that answered no library at all fails the search.
**Never two requests at once**: a panel's flood protection drops connections when a plugin fans out, so every read waits for the one before it.
A search starts requests for at most 12 s, because the host refuses any request a call starts after 20 s of wall time (`JsHostApi.boundedAsyncFunction`); what is left is read by the next search, and until then the answer says so with `yonto.partial`.
On the panel that brought it, the first search took about 12 s (three requests, the films' 16.7 MB among them) and the next 10 ms.

Each library's index is kept in `yonto.cache` for 12 hours, so it survives the runtime being renewed and the app restarting, and nothing of it stays in memory between searches.
It is several entries: `index:<kind>` is the state, JSON naming `owner` (the server and username it was read for), `at` (when it was begun), `complete`, `chunks` (the id of each chunk, that of the write that made it) and, for one read by category, `read`, `failures` and `tooLarge`; `index:<kind>:0`, `:1` and on are the chunks, each at most 2 Mi characters (`CHUNK_CHARS`, well under the cache's 16 Mi a value), its id on the first line and then a line per title, `id\ttitle\tposter\tyear`, with a tab, a line break or a lone surrogate in a field replaced.
So a big panel's films fit, as a few chunks under the 64 MiB a source's cache keeps, and a search holds one chunk at a time, scanning it line by line and building no list of every title.
The chunks are written before the state that names them, and a smaller index built again removes the chunks it no longer names.
A chunk the cache lost, could not read, or holds with an id the state does not name (another call building the same index at once, or an old call finishing after the source was edited) means the index is built again before that library answers, never searched in part as if it were whole.
An entry for another account, or begun over 12 hours ago, is built again.
An index read by category is written back after each search, as far as it got, rewriting only its last chunk and adding new ones, and the cache answers for five seconds after the call's last `yonto.fetch` ended, so what a request that answered past the deadline brought is still kept.
A cache that cannot be read leaves the search answering from the panel, as the first search does; an index the cache did not keep (`yonto.cache.set` answered false or threw: a source nobody saved, a disk that refuses) is held in module memory for the runtime instead (`unkept`), whole, so Test Connection or a broken disk does not read every list again on each search.
`yonto.store` is no place for it: on the device that is one DataStore file for every source, held whole and rewritten on each write.

## Not here

No EPG, no catch-up (`tv_archive`), no radio, no adult-category filtering, and no `getStream`: every stream is in its title's page.
`stream.live` is contract 22 and `episode` 25, both result fields an older app drops, so the manifest declares 21, as the m3u plugin's does.
