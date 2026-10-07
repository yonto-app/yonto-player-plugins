# maccms plugin

One MacCMS server, read over its `api.php/provide/vod` API, which is one source.
It is the built-in handler for the `maccms-json` and `maccms-xml` yonto types (`contracts/yonto-types/`), shipped in the APK by phase 5's app-side change together with the registry that calls it, and the design is `docs/design/2026-09-23-the-app-reads-every-index.md` (kangzj/yonto#615, phase 5).
Its config is an entry's: `api` (a `url` field), `dialect` (`json` or `xml`, the `const` of the type the entry was) and `searchable` (a `bool`, false only when the entry said `searchable: 0`).

It is the readers of one MacCMS site from `plugins/tvbox` and `plugins/xptv`, the two index plugins that came before the app read indexes itself, merged.
Wherever the two disagreed it takes xptv's answer; tvbox brings the XML dialect, the recommendations and the `searchable` refusal.
Both were retired on 2026-09-24 without ever being publicly released (kangzj/yonto#615, phase 8), and what they had measured about MacCMS servers is under *What the servers have shown* below.

## What it reaches

Its `api`'s host and nothing else.
The address is a `url` field, so the host widens the allowlist to exactly that host and checks every redirect hop against it; there is no `hostsFromConfig`.
A redirect off the host is refused by the host (`HOST_NOT_ALLOWED`), and this says so in its own sentence rather than as an outage, because waiting will not change it.
The floor raises the same code, which today only a redirect hop can meet, since the `api` itself is typed; from phase 6 a repo can name a private `api` the viewer did not type, so the sentence (*points at an address Yonto won't connect to*) is worded to be true of both.

**Measured 2026-09-23** against the 120 distinct `…/provide/vod` addresses in the eight plain 仓s of #572's survey that answered, each asked `ac=list`, following up to five redirects:

| what came back | count |
|---|---|
| answered on its own host, no redirect | 62 (`200`); 48 more failed on their own host (no connection 33, 403 6, 404 4, 429 2, 400/520/521 one each) |
| redirected on the same host | 2 (`http` → `https` on api.guangsuapi.com; ikaola.tv to its own `install.php`) |
| redirected to another host, a real MacCMS | 2 addresses, one server (api.ukuapi.com → api.ukuapi88.com, with and without `?ac=list`) |
| redirected to another host, not a MacCMS at all | 6 (parked domains, ad networks, a site's home page: kuaibozy, tiankongapi, heimuer, 911ysw, nxflv, wwzy) |

So refusing a cross-host redirect costs one live server that moved, whose entry can name its new address, and spares a viewer six that answer with somebody else's page.

## The API

Two actions per dialect and the class tree, all against the `api` as given, with the action set on top of whatever query it already carries (`withParams`: `?ac=list` and `/from/x/at/m3u8/` paths both occur).

| call | JSON | XML |
|---|---|---|
| categories, filters | `ac=list` | `ac=list` |
| a listing | `ac=detail&t=<class>&pg=<n>` (no `t` for 最新) | `ac=videolist&t=…&pg=…` |
| a title | `ac=detail&ids=<vod id>` | `ac=videolist&ids=…` |
| search | `ac=detail&wd=<query>` | `ac=videolist&wd=…` |

- **The class tree is flat.** `type_pid` 0 marks a parent where the site sends it; where it does not (suoniapi sends 61 classes without it), the seed ids 1–4 are the parents, and a site that renumbered them offers 最新 alone.
  The children are the 分类 filter, never categories: Home asks a shelf per category at once, and 61 at once is a Home that fails.
- **A filter wins over the category**, and an empty filter is no choice.
- **A page** is `Math.trunc` of what was asked, and anything below 1 is page 1.
- **The XML dialect** is read with `yonto.xml.load` along FongMi's `Result` (`@Root(name = "rss")`) paths: `list > video`, `class > ty`, and a video's own `dl > dd`, each field that video's own child.
  So CDATA is text, a quoted `>` stays in its `flag`, `<pic/>` closes itself, and a nested `<video>` is not a title.
  It has no failure envelope and no ratings, genres or weekly hits.
  Only XML's own entities and numeric references are decoded, so an `&nbsp;` outside a CDATA section stays as written in every field but the synopsis, which `plainText` reads as HTML; none of the live XML sites writes one there.
  Either mode of the parser is lenient, reading a body that is not a MacCMS page as no titles, so the reader checks for a `rss`, `list`, `video` or `class` element itself and refuses a body without one.
  *What the servers have shown* has the sites it was compared over.
- **GBK** is common: the body is decoded in the charset `Content-Type` names (`yonto.text.decode`).
- **Every scalar may be a number, a null or an object**, so `str()` keeps only strings and numbers, trimmed.
  A title or a class with no id or no name is dropped.

## Ids

A card's id is the site's own vod id and a category's the site's own class id, bare.
最新 is `latest`, because the contract refuses an empty category id; no MacCMS class id is `latest`, since they are the site's numbers.

**No id budget, on purpose.**
A MacCMS id is the site's own and is never shortened, and there are no tokens, so a budget here could only drop or log a title.

A title is **matched**: `ids=42` answered with anything but vod 42 is `notFound`, one record or several, because a site that ignores `ids` and answers with its latest would otherwise open another title under a History row.

## What a server says, and what a viewer reads

| the server | the error | rests the source? |
|---|---|---|
| no answer at all (`REQUEST_FAILED`) | `unreachable`, *Can't reach this source* | yes |
| a status other than 404, 401, 403 | the same | yes |
| `TIMEOUT` | rethrown | no: it says nothing about the server |
| a redirect chain the host gave up on (`REDIRECT_REFUSED`) | `unavailable`, *redirects lead nowhere* | no: it answered |
| an address the host will not send (`REQUEST_INVALID`) | `misconfigured`, *The API address can't be used* | no: nothing was sent |
| a redirect to another host, or a private address nobody typed | `unavailable`, *points at an address Yonto won't connect to* | no |
| 404 | `notFound` | no |
| 401, 403 | `unavailable`, *refused access* | no |
| a body neither dialect can read | `unavailable`, *something that can't be read* | no |
| `{"code":0}` with nothing in it | `unavailable`, *returned nothing this time* | no |
| 暂不支持搜索 to a search, as text or as `msg` | `unavailable`, *doesn't have search* | no |

- **401/403 is `unavailable`, not `unauthenticated`**, which is an exception to the *Error mapping mirrors `HttpJsonClient`* in `docs/agents/plugins.md`: a MacCMS site has no login, and `unauthenticated` sends a viewer to a sign-in that does not exist.
- **`code 0` rests nothing.** The retired 仓 plugin rested a site for it because its search raced every site and the empty answer arrived first; a source here is one server, and a build that answers `code 0` to a search with no matches would grey the catalog the viewer is in for finding nothing.
- **The rest is the app's**, not this plugin's: it keeps nothing in `yonto.store`.
  Every "the server did not answer" goes through `serverDidNotAnswer()`, which raises `yonto.error.unreachable` (contract 16), the one error the app rests a source for.
  Only `REQUEST_FAILED` from `yonto.fetch` is that; every other code it rejects with is the host's verdict about a request the server never saw or did answer, and a code this does not know is passed on as it came rather than guessed into a rest.
- **The sentences name no catalog.** A handler is never told its entry's name, and the source's own row already says which one it is.
- **Logs carry what happened and never the address, its query or the search**: an `api` can carry a key, and a failed `yonto.fetch`'s message can name the URL, so only its `code` is logged.

## Search

A source whose `searchable` is false is refused without asking the server (Jasper, 2026-09-23), as TVBox and FongMi do, in the same sentence as a server that answered 暂不支持搜索.
suoniapi's JSON API is one that answers that way, which is why `doctor.json` names lziapi rather than it.

## A title

- **Lines** are `vod_play_from` and `vod_play_url` split on `$$$`, episodes on `#`, name and URL on `$`; an episode with no name is numbered.
- **A line of web pages** (a 解析 service's input) is left out while a line of media files exists, and kept when it is all there is.
  `.m3u8` is HLS, anything else is typed `video/mp4`.
- **A title with no line to play is refused**, naming the title: an empty `playbackOptions` reads as a title with nothing on it, and a MacCMS row with no `vod_play_url` is one the site has not filled in.
- **The synopsis** is read with `yonto.html.load`, after one level of `&amp;` is unwrapped (a site that double-encodes writes `&amp;nbsp;`), and only on a detail.
- **Type**: 集/期/更新 in the remarks is a series; otherwise 片 in the type name is a movie; otherwise 剧/动漫/综艺/动画/番 is a series; otherwise a movie.
  A detail is typed by the same words (kangzj/yonto#1207): a 动作片 with two versions on one line is still a film.
  Only where the words say neither is a detail with a line of more than one episode a series.
- **Rating**: 豆瓣's score, then the site's, whichever is strictly between 0 and 10: "0.0" is no score and "10.0" is no real one.

## Recommendations

No CMS has a ranking call, so the latest page ordered by `vod_hits_week`, titles with artwork only, ten at most.
An XML page carries no hits, so it is the latest page with artwork in the site's order.
A failure is no ranking rather than an error, because Home's shelves say what went wrong.

## Health

Not exported: the app's default is `getCategories`, which is one `ac=list`, which is the whole of a probe of one server.

## What the servers have shown

What the two retired index plugins measured against live MacCMS servers, carried here so it is not lost with them.

- **The JSON dialect** was verified live against dyttzyapi and lziapi, and XML through suoniapi's `at/xml` endpoint (which 老刘备's 仓 lists as `type` 1, JSON). Whether a site sends `type_pid` varies: lzizy1 does, with ten parents out of 44, and suoniapi's 61 classes carry none, which is why both halves of the parent rule exist.
  The `list[]` in an `ac=list` answer carries no posters, which is why a listing never reads it.
- **The XML dialect** has 21 `type` 0 sites across 10 of the 78 live 仓s of #572's survey, which is what reversed the earlier call that no live 仓 routed anything to it.
  The parser replaced regexes on 2026-09-23 (kangzj/yonto#601), after both gave identical titles and detail pages over the `ac=videolist` pages of the ten that answered (suoniapi, lziapi, mdzyapi, ffzyapi, dyttzyapi, iqiyizyapi, apibdzy, xinlangapi, maotaizy, ckzy), 200 titles in which every text field is CDATA.
  It costs about 35 ms to compile once per runtime (shared with `yonto.html.load`) and roughly twice the regexes' parse: 88 ms against 43 for a 653 KB page, 10–30 ms for the usual 10–150 KB one.
  It was then run on an emulator against three `at/xml` sites.
- **`www.mdzyapi.com` was green throughout** on 2026-09-22 (12 categories, a 分类 filter, 20 titles, 102 playback options, 14 search hits); in the same index `360zy.com` did not answer at all and `api.wwzy.tv` answered `301` to an HTML page. Two of the first three entries of a live index being dead is the ordinary condition of the format.
- **A 200 is not an answer on its own.** `{"code":0,"msg":"数据获取失败"}` is the cheapest thing a broken mirror returns, and a race over several sites preferred it for being fastest: eleven runs in twelve landed on a mirror that had nothing. It is a failure only when the body also carried nothing, because a fork answering `200`, or spelling the field another way, would be condemned by a stricter rule.
- **Some CDNs geo-block**: from outside China `vip.ffzy-plays.com` and `vip.dytt-see.com` answer 403 "The region has been denied" to any client, which the player reports as a bad HTTP status; suoniapi's CDN does not.
- **No stream has needed a header** on any site captured or run against so far, which is not the same as none ever will.
- **The synopsis parser replaced three hand-written entity decoders**, each of which carried kangzj/yonto#350 (a numeric entity above `0x10FFFF` threw and took the listing down, and `&#0;` put a NUL on the screen); cheerio never had either defect.

## When something changes

- A site's listing goes blank → curl `?ac=list` and `?ac=detail&pg=1` (or `videolist`), and look for a new field spelling in `vodFromJson` / `vodFromXml`.
- A new failure shape → add a row above before changing `ask`.
- Fixtures are lziapi's, recorded by `doctor --record`; `doctor --replay` is the offline check.
