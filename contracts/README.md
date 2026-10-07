# Contracts

What a content source has to implement, in the form every side of the repo reads, and the one contract the apps hold with the licensing service.

A source is a black box to the app: it depends on the `ContentSourceAdapter` interface and
the domain models in `content/`, never on a particular provider.
These files are where that boundary is written down, and they are the only place it
is written down once for the app, the plugins and the CLI at the same time.
All but `licence-token-v1.json` are also published, with the CLI, in yonto-app/yonto-player-plugins.

| File | What it defines | Who reads it |
| --- | --- | --- |
| `manifest.schema.json` | The manifest in a plugin file's own `yonto-plugin` header — its id, name, permissions and `configSchema` | `tools/plugin-cli` (`lint`, at run time, via `src/header.js`), `PluginManifest.kt` and `PluginHeader.kt` by hand |
| `content-source.schema.json` | The shapes a source's methods return — the same payloads the HTTP contract carries | `tools/plugin-cli` (`doctor`, `conformance`), `ContractDtos.kt` and `PluginCodec.kt` by hand |
| `content-source-http.md` | The HTTP contract a remote provider implements, and the error vocabulary a plugin throws in | `HttpContentSourceAdapter.kt`, plugin authors |
| `contract-versions.json` | When each part of the surface arrived, so a plugin can be told which `contractVersion` it may declare — and, as the newest version it names, which one no host speaks past, and the oldest every host still runs | `tools/plugin-cli` (`lint`, via `src/contract-version.js`), `PluginManifest.LATEST_CONTRACT_VERSION` and `OLDEST_CONTRACT_VERSION` held to it by `ContractVersionRecordTest` |
| `driven-logins.json` | The login pages a host can drive, by capability type; a capability naming any other page is accepted and never offered | `tools/plugin-cli` (`lint`, via `src/host/credential.js`), `DdysLogin` held to it by `DrivenLoginsRecordTest` |
| `link-logins.json` | The services a `linkLogin` may name, each as the data the one link sign-in engine reads: its start, poll and discovery requests, where each answer keeps a code, a token or the account's servers, and which header each credential goes in | `tools/plugin-cli` (`lint` and the host, via `src/link-login.js`), the APK carries it as an asset (`carryLinkLogins`) and reads it with `LinkLogins.kt` |
| `link-login.schema.json` | The grammar of a `link-logins.json` service | `tools/plugin-cli` (via `src/link-login.js`), whose tests hold the file to it; `LinkService` in `LinkLogins.kt` by hand |
| `yonto-types/` | The registry of Yonto's own index entry types, one JSON Schema per name: the config a handler receives for an entry of that type, each property marked with the `configSchema` field type (`x-yonto-field`) a handler declares it as. A bare name is Yonto's and has a file here; anybody else's is reverse-DNS and has none. Fields are only added within a name | `tools/plugin-cli` (`lint` holds a manifest's `handles` to it, via `src/yonto-types.js`), `YontoTypes` held to it by `ContractYontoTypesRecordTest` |
| `yonto-type-name.schema.json` | The one grammar for a type name: a short id, or reverse-DNS in two or more lowercase RFC 1123 labels. `$ref`'d by the manifest's `handles` and the index's `ext.yontoType`, so the two cannot disagree | `tools/plugin-cli` (via `src/manifest.js`), held to `conformance/yonto-type-names.json` |
| `licence-token-v1.json` | The licence token's test vectors, copied as they are from kangzj/licensing's `tests/vectors/token-v1.json`: its public key, the install id and each case's token and verdict | `LicenceTokensTest` (in `LicenceTokenVectors.kt`, a copy `LicenceTokenVectorsCopyTest` holds to this file) |
| `index.schema.json` | Where plugins and catalogs are listed: the 仓/XPTV index envelope with Yonto's `type` 50 entries, `ext.yontoType` saying which kind (a name by `yonto-type-name.schema.json`) and `ext.config` its payload, held to that type's schema in `yonto-types/` (`plugin` so far; `docs/design/2026-09-23-the-app-reads-every-index.md`) | `tools/plugin-cli` (`index`, via `src/index-document.js`, reading through `src/index-reader.js`), `IndexReader.kt` by hand |

## What `contract-versions.json` does and does not carry

It records **when**, never **what**. The names themselves live where they are already held
to both hosts — `tools/plugin-cli/conformance/host-functions.json` for what a host provides,
`src/contract.js`'s `METHODS` for what a plugin may export — and a list kept twice drifts,
which is the failure this file exists to prevent rather than to join in.

So it names only what arrived after version 1. Anything absent has been there from the
start, and a key without its `yonto.` prefix is a dead entry the record's own test
refuses.
`oldest` is the oldest version a host still runs: 21, since that version removed `lantern`,
the host's old name, and every host refuses a manifest declaring less.

What reads it also has limits worth knowing, since they decide what `lint` can promise: it
reads a plugin's source rather than running it, so an export it cannot follow — one built by
spreading another object, say — is read noisily rather than missed, and a host function
taken off `yonto` by destructuring (`const { now } = yonto`) is not seen at all (#86),
a computed key (`{ [name]() {} }`) is not read as an export. A plugin that
feature-detects is told to declare the version it guards against (#95).

Two things the record itself cannot say yet; the second is still waiting for a real case
rather than a guess:

- **A surface being removed.** `since` is a floor with no ceiling, so a plugin using
  something a later version dropped gets no signal from here. The first real case was the
  `multi` field type (kangzj/yonto#440): its key was taken out of `since` and the
  withdrawal noted in the record's `$comment`, and the schema refuses it, which is the signal
  an author gets instead.
- **A surface whose behaviour changed under the same name.** Nothing sees that, and `lint`
  will actively tell an author who declared the newer version for that reason to go back
  down — the warning about declaring higher than you use.

## These are code, not prose

The schemas are loaded at run time — `tools/plugin-cli/src/manifest.js` and
`src/contract.js` resolve them by relative path and validate against them with Ajv, and
`src/yonto-types.js` reads `yonto-types/` the same way; `src/manifest.js` also loads
`yonto-type-name.schema.json`, which the manifest schema `$ref`s.
Moving or renaming one breaks the CLI, so they live here rather than under `docs/`.

The Kotlin side has no schema validator on the device; `ContractDtos.kt`, `PluginCodec.kt`
and `PluginManifest.kt` implement these shapes by hand and name the schema they follow in
their KDoc.
A change to a schema is therefore a change in two places, and the conformance suite in
`tools/plugin-cli/conformance` is what catches the second one being forgotten —
`JsHostApiConformanceTest` replays it against the device runtime.

## Changing one

The contract has two ends that ship separately: an APK already installed on a television
cannot be told about a new required field.
So an addition is optional, an unknown value degrades rather than throws, and a removal
waits for `/v2`.
`content-source-http.md`'s Transport section states this for the HTTP side, and it holds
for plugins for the same reason.

One removal came early, and only because of what was true of it: the `multi` field type
(kangzj/yonto#440). The television does not refuse a plugin that still declares one —
it draws the field as a text box, as it does any type it does not know — so nothing
installed stops running; no plugin in this repository declared it; and the only reader of
its answer would have been the plugin itself, which now gets typed text rather than a JSON
array. That is a changed answer, not a refused plugin, and it was acceptable only because
nothing here read it. It is not a licence to take out a type something reads.

**A manifest field is the one place that rule has two ends of its own**, and `provides` is
the case it was written for. It is in the schema's `required` list *and* defaulted on a
device, which is not the rule being broken in both directions but the rule applied to each
end separately: the schema is read by an author, on their own machine, before anything
ships, so it can insist they decide — while the television is the end that cannot be told,
so it reads the conservative answer and goes on running the plugin. What the rule forbids
is a field a *host* requires, because that is the half that refuses a plugin somebody
already installed. A field only the author's toolchain requires refuses nothing that
exists. Adding one still owes the same two things: a default that means what the absence
always meant, and a reason written down where the field is declared.

An unknown key is the same split read the other way. The schema refuses one — at the top
level, in a `configSchema` field and in a choice's option — because to an author it is a typo
that would otherwise mean nothing (`hostFromConfig`, `requried`), while a television drops
one, because to a host it is a field from a later contract (kangzj/yonto#336). So a new
field goes into the schema before any plugin can declare it, and never into a host as a
reason to refuse.

The `$id` of each schema is a `https://yonto.app/plugin-contract/` URL.
That is an identifier, not an address — nothing fetches it, and it does not track where the
file sits in this repo.

## Related

- `docs/source-plugins-status.md` — where the plugin work stands
- `docs/design/2026-09-18-source-plugins-design.md` — the host API and the two-host rule
- `docs/design/2026-09-22-what-xptv-does-with-plugins.md` — how another live plugin
  ecosystem does the same job, what is worth taking, and what it validates here
- `docs/design/2026-09-22-running-xptv-plugins.md` — the design for running their plugins
  here, and the four decisions it re-opens
- `tools/plugin-cli/README.md` — writing and diagnosing a plugin against these
