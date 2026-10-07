A plugin is the file named for it at the top of its own directory — for this one that
would be `no-source-plugin.js`. This directory deliberately has none, so `lint` has a case
for "there is no plugin here", which since #100 is the same statement as "there is no
manifest here": the manifest lives in that file's own header, so a missing file and a
missing manifest are one fact.

The name moved in #197 and this directory still has nothing, which is the whole point of
it — a fixture that only works while the entry is called one particular thing would be
testing the name rather than the absence.
