# Contributing

## Where a change lands

This repository is exported, one way, from the private repository the Yonto apps are built in.
That one is the source of truth: each export replaces everything here, so a commit made only here is gone at the next one.

Issues are welcome here.
So are pull requests, as proposals: a change that is accepted is applied in the app's repository and arrives here with the next export, and the pull request is closed then.
The reason is the conformance suite: the CLI and the app each implement the same host, and a change to one is tested against the other before it ships.

## The contract and the apps

The apps are closed and released on their own schedule, and a television keeps whatever version it has installed, so the contract is versioned rather than changed in place.

- `contracts/contract-versions.json` records the version each part of the interface arrived in.
  The newest version it names is the newest any host speaks.
- A plugin's manifest declares `contractVersion`, and `yonto-plugin lint` works out what it must be from what the plugin uses.
  An app older than that version refuses the plugin, so declare what `lint` asks for and no more.
- The export never publishes a contract version no released app speaks, so whatever this repository describes runs on the current release.
  An app built since may speak more; this repository catches up at the next export after it is released.
- Within a version nothing is taken away: an addition is optional, a value a host does not know degrades rather than fails, and a removal waits for a new major version of the contract.
  `contracts/README.md` says how that is applied to each kind of change.

## Before you propose a change

```sh
npm ci --prefix tools/plugin-cli
npm test --prefix tools/plugin-cli
```

The tests pass offline, and a change to the CLI's host (`tools/plugin-cli/src/host/`) or to anything under `tools/plugin-cli/conformance/` is a change to the contract both hosts share, so say what it is for.
A change to a plugin should come with fixtures recorded by `yonto-plugin doctor --record` that `doctor --replay` passes on, recorded against a server you may share the answers of.
