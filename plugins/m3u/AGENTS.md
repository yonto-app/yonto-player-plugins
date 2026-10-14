# m3u plugin

One M3U or M3U8 playlist, which is one source.
Each entry is a title with one thing to play, and each `group-title` is a category.
It is bundled, so every platform has it, and it is a `source-type`: Add source → M3U playlist, with the playlist's address.

## What it reaches

The playlist's host and nothing else.
The address is a `url` field, so the host widens the allowlist to exactly that host and checks every redirect hop against it; there is no `hostsFromConfig`.
The entries' own addresses are the player's to open and are never fetched here, so a playlist of channels on a hundred hosts needs no allowance for them.
A redirect off the playlist's host is refused by the host, and said so in a sentence rather than as an outage.

## The format

- `#EXTM3U` opens it; `#EXTINF:<seconds> key="value" …,<title>` describes the address on the next non-`#` line.
  The title follows the first comma outside a quote, because a `group-title` may hold one.
- Read from the attributes: `group-title` (the category), `tvg-logo` (the poster, only if `http(s)`), `tvg-name` (the title when the part after the comma is empty).
  `tvg-id` and the rest are ignored.
- `#EXTGRP:` between `#EXTINF` and the address names the group when `group-title` does not.
  An entry with neither is under *Other*.
- `#EXTVLCOPT:http-user-agent|http-referrer|http-origin` become the stream's `User-Agent`, `Referer` and `Origin` headers.
  Kodi's `url|Name=value&Name2=value2` suffix does the same; a header name or value the host would refuse is dropped, not sent.
- **Every stream carries a `mimeType`**, because the host plays one with none as HLS.
  An address with `.m3u8` in it is HLS; anything else is `video/mp4`, which makes the player a progressive one that sniffs the real container (MP4, FLV and TS entries are common in IPTV lists, and handing them to the HLS parser fails with *Parsing manifest malformed*).
  An HLS stream behind an address with no `.m3u8` in it would be read as a file, and nothing can tell without fetching the stream, which a plugin may not.
- **A stream says `live: true`** (contract 22) unless its `#EXTINF` states a length: `-1` (or none) is how a playlist says a stream has no end, and a looped "24/7" channel is a short file that ends every minute, which no player can tell from a title.
  The app then saves no place in it, draws no timeline, and starts it again if it ends or drops; an app older than 22 drops the key and plays it as a title with a length, as before, which is why the manifest still declares 21: an app older than the declared version refuses the plugin.
  An entry with a positive length, or whose address ends in a video file extension (`.mp4`, `.mkv`, …; playlists of videos often write `-1` too), is a video and keeps its place like any other.
- A relative address is read against the playlist's own address.
- An HLS media or master playlist (`#EXT-X-…`) is one stream, not a playlist of them, and says so.

## Ids and paging

An entry's id is the md5 of its address and title, so it survives the playlist being reordered or gaining entries, and an entry the playlist repeats is one title.
A listing is 60 entries a page, from a playlist the runtime holds for five minutes (module state, not `yonto.store`: a big one would not fit the store's 1 MiB).
Search is a case-insensitive substring over title and group, at most 100.
The 16 MB body limit is the largest playlist it reads.

## Not here

No EPG (`tvg-id` is ignored), no catch-up, and no playlist from a file on the device.
Every entry is a `MOVIE`: nothing in the format says an entry is an episode.
