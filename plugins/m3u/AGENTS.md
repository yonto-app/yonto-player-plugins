# m3u plugin

One M3U or M3U8 playlist, which is one source.
Each entry is a title with one thing to play, and each `group-title` is a category.
It is bundled, so every platform has it, and it is a `source-type`: Add source → M3U playlist, with the playlist's address.

## What it reaches

The playlist's host and nothing else.
The address is a `url` field, so the host widens the allowlist to exactly that host and checks every redirect hop against it; there is no `hostsFromConfig`.
The entries' own addresses are the player's to open and are never fetched here, so a playlist of channels on a hundred hosts needs no allowance for them.
A redirect off the playlist's host is refused by the host, and said so in a sentence rather than as an outage.
A failure it has no sentence for is thrown again with its code alone, since the host's message names the URL, and a playlist address can carry a key.

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
  An entry that is not HLS, a TS or FLV channel, may hand over to the software player as any file does (`docs/agents/plugins.md`), which an MPEG-2 channel needs on a phone and raw TS on an iPhone.
  An HLS stream behind an address with no `.m3u8` in it is still HLS: on Android the player reads the first bytes of such a stream before it picks a player, and when they are `#EXTM3U` plays it as a playlist, in ExoPlayer alone, since libVLC fetches no playlist's segments, so the plugin need not fetch it. A stream whose address names its container, or whose type is already HLS, is not read.
- **A stream says `live: true`** (contract 22) unless its `#EXTINF` states a length: `-1` (or none) is how a playlist says a stream has no end, and a looped "24/7" channel is a short file that ends every minute, which no player can tell from a title.
  The app then saves no place in it, draws no timeline, and starts it again if it ends or drops once it has played (a dead entry fails in seconds); an app older than 22 dropped the key, but the manifest declares 29 since 1.3.0 for `yonto.cache`, so no such app runs it.
  An entry with a positive length, or whose address ends in a video file extension (`.mp4`, `.mkv`, …; playlists of videos often write `-1` too), is a video and keeps its place like any other.
- A relative address is read against the playlist's own address.
- An HLS media or master playlist (`#EXT-X-…`) is one stream, not a playlist of them, and says so.

## A big playlist

A panel's export is 30 MB and 90,000 entries, and one character above U+00FF in it makes the whole body a 2-byte-a-character string in QuickJS (56 MB for 28 MB), so the parse is written for a television's memory and budget, and measured on its QuickJS:
the body is walked line by line with `indexOf` rather than split into a second copy (a line ends at CR, LF or both, as before), no regex runs per line (a tag is read by its characters, with the old regexes' prefixes: `#EXTM3U` however it goes on, an HLS manifest's tags anywhere in the file), and an entry with no headers shares one frozen object.
The customer's 28 MB playlist parses in about 0.9 s and needs 128 MB of the realm's 160; a 32 MB one built from it needs the 160.

## The kept playlist

What was parsed is kept in `yonto.cache` (contract 29) rather than in module memory, which held about 110 MB of the realm for a 90,000 entry playlist for as long as the source was open.
Right after the parse, each entry becomes a line, `id\ttitle\tgroup\tposter\turl\tlive\theaders` (`live` is `1` or empty, `headers` JSON or empty, and a tab in a field a space), in playlist order and with a repeat dropped as before, and each entry is let go once it is a line, so the parse's peak is not raised.
The lines are cut into chunks of at most 512 Ki characters, `playlist:0`, `:1` and on, each opening with the build id of the write that made it, and `playlist` is the state: the address, `at` (when it was read), the build id, the line count, the line each chunk starts at, and each group's name and runs of lines `[start, length]`, in first appearance, so a group's page is found without a scan.
Every entry's two md5s are made then, its id's and the repeat check's, 180,000 host calls, which take a 90,000 entry playlist's first read from about 2.1 s to 2.7 s on the CLI's QuickJS; the count of an id's namesakes is kept by the md5 of its group and title, never the title itself, so the parse holds 32 ASCII characters an entry and not a two-byte title.
Beside them, `playlist:ids:0` and on hold every line's 32-character id in line order, concatenated after the same build id, 131,072 a piece (4 Mi characters, so a 90,000 entry playlist's are one).
And `playlist:search:0` and on hold each line's title and group, lowercased as they were written, `title\tgroup` a line, in pieces of their own that start where the state's `searchStarts` say.
A call reads the state and only the pieces it needs, so nothing of the playlist stays in memory between calls: Categories the state alone, a page of All or a group the one or two chunks holding its lines, a title page the ids (`indexOf` at a multiple of 32 gives the line) and then that line's chunk, and a search the search pieces until it has 100 hits (`indexOf` straight through each, a hit's line counted in that text, so `İ`, which lowercases to two characters, moves nothing), then only the chunks holding them.
The chunks are written before the state that names them, each with the five minute ttl; a chunk, ids piece or search piece the cache lost, or one another build wrote, means the playlist is downloaded and parsed again before the call answers, never answered in part.
What the cache did not keep (`yonto.cache.set` answered false or threw: a source nobody saved, as Test Connection's is, or a disk that refuses) is held in module memory for the runtime instead (`held`), compact, so such a source downloads once every five minutes and not on every call.
So is a playlist whose lines would pass `CACHE_BYTES` (60 MiB, counting a character past ASCII as three bytes), since past the 64 MiB a source's cache keeps the host would drop our own chunks to make room.
Two calls never race to download it: the host runs one call at a time per source.

## Ids and paging

An entry's id is the md5 of its group and title (`idOf`), so it survives the playlist being reordered or gaining entries, and above all its address changing: a provider may sign every stream address afresh every few minutes, and an id made from the address gave every channel a new one at each download, which a title page, History and the Watch list then could not find.
A second entry of the same group and title, a backup stream, is a title of its own, its id the md5 of the group, the title and how many of both came before it, so the first keeps the plain one.
An entry the playlist repeats, address and title alike, is still one title, wherever it is repeated.
A listing is 60 entries a page, from a playlist read at most five minutes ago (`CACHE_SECONDS`, counted from the state's `at`, so a restart within five minutes answers from the cache).
Search is a case-insensitive substring over title and group, at most 100.
The 32 MB body limit is the largest playlist it reads, and a larger one says *too large to read*; an Xtream Codes panel's `get.php?username=…&password=…` link adds that it can be added as an Xtream Codes source, which reads the panel through its API in pieces (`plugins/xtream/AGENTS.md`), since a panel's export is often its whole library in one file.

## Not here

No EPG (`tvg-id` is ignored), no catch-up, and no playlist from a file on the device.
A channel has no Download on its page, since it is no file to keep.
Every entry is a `MOVIE`: nothing in the format says an entry is an episode.
