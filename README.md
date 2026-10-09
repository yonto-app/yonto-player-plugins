# Yonto plugins

[Yonto](https://yonto.app) is a video app for Android TV and for phones and tablets.
It does not know any site or server itself: everything it plays comes through a source plugin, one JavaScript file that lists categories and titles, describes a title and searches.

This repository is the open part of Yonto, under the MIT licence:

| Path | What it is |
| --- | --- |
| `contracts/` | The plugin contract: the manifest and result JSON Schemas, the index format, the HTTP contract (`content-source-http.md`) and `contract-versions.json`, which says when each part of the interface arrived. |
| `tools/plugin-cli/` | `yonto-plugin`, the command-line tool that scaffolds, lints, runs, diagnoses and packages a plugin on your own computer, in the same QuickJS engine the app runs plugins in. Its `conformance/` is the suite both hosts, this tool and the app, are held to, and `templates/` is what `init` starts a plugin from. |
| `plugins/` | Yonto's own plugins for [Jellyfin](https://jellyfin.org), [Plex](https://www.plex.tv) and [Emby](https://emby.media), and the handlers that read the MacCMS and XPTV formats. Each has an `AGENTS.md` saying how that server behaves, and most have recorded fixtures to run against. |

The app itself is not here, and stays closed.

The developer guide is at [yonto.app/docs/developers](https://yonto.app/docs/developers/): a tutorial, the plugin reference, testing and publishing.

## Quick start

You need [Node.js](https://nodejs.org) 20 or later and git.
Nothing here needs an Android SDK, an emulator or a television.

```sh
git clone https://github.com/yonto-app/yonto-player-plugins.git
cd yonto-player-plugins
npm ci --prefix tools/plugin-cli
npm install -g ./tools/plugin-cli
```

The last line puts `yonto-plugin` on your `PATH`.
Without it, run `node tools/plugin-cli/src/cli.js` wherever these examples say `yonto-plugin`.

Run a plugin against its recorded fixtures, with no network and no server:

```sh
yonto-plugin lint plugins/jellyfin
yonto-plugin doctor plugins/jellyfin --replay
yonto-plugin run plugins/jellyfin search '"bubble"' --replay
```

`doctor` calls every method the plugin exports and says what each answered.
`--replay` serves the requests from `plugins/jellyfin/fixtures/`, and `plugins/jellyfin/doctor.json` is the configuration the fixtures were recorded with.
`emby`, `plex` and `maccms` replay the same way.

Start a plugin of your own:

```sh
yonto-plugin init my-site
cd my-site
yonto-plugin lint
yonto-plugin doctor
```

Run the tool's own tests, which pass offline:

```sh
npm test --prefix tools/plugin-cli
```

`tools/plugin-cli/README.md` has every command and option.

## Installing a published plugin

Yonto's own plugins are published as releases of this repository, one release per plugin.
`https://github.com/yonto-app/yonto-player-plugins/releases/download/<id>/<id>.zip` always serves the current build, and `<id>-<version>.zip` beside it never changes, with a `.sha256` next to each.
In Yonto, choose **Settings**, **Plugins**, **Install from URL** and paste the address; the app shows what the plugin may reach before anything runs.
The `index` release holds `index.json`, a repo listing every plugin, which **Settings**, **Repos** takes.

## Reading this repository

It is exported from the app's private repository, so some of what you read points there:

- `kangzj/yonto#123` is an issue in that repository, and a path under `app/`, `core/` or `docs/` is a file in it.
- Lantern is Yonto's earlier name, and `kangzj/lantern-tv#123` an issue from before the repository was renamed to `kangzj/yonto`.
- Two plugins are not here, nor among the releases: `ddys` and `iyingshi` read particular websites rather than a format anybody can run.
- `plugins/xptv-js` has no fixtures here. Its recordings embed XPTV catalogs, programs from a repository that carries no licence, so they cannot be published under this one. The suite's recorded indexes (`conformance/index-reading/recorded-*.json`) are kept: they are lists of names and addresses, not anybody's code.

## Licence

MIT, in `LICENSE`, for the files in this tree, and for the releases built from them.
Recorded responses are not ours to licence: the `fixtures/` directories and the `recorded-*.json` files under `tools/plugin-cli/conformance/` hold what third-party servers answered, kept as test inputs, and remain their owners'.

`CONTRIBUTING.md` says how a change gets in, and how the contract here relates to the apps people have installed.
