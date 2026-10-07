import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { YONTO_TYPES, PLUGIN_TYPE, handlesRefusals } from '../src/yonto-types.js';
import { typeNameSchema, validateManifest } from '../src/manifest.js';

const manifestSchema = JSON.parse(readFileSync(new URL('../../../contracts/manifest.schema.json', import.meta.url), 'utf8'));
const FIELD_TYPES = manifestSchema.properties.configSchema.items.properties.type.enum;

const maccms = {
  provides: 'source-type',
  handles: ['maccms-json', 'maccms-xml'],
  configSchema: [
    { id: 'api', label: 'API', type: 'url', required: true },
    { id: 'dialect', label: 'Dialect', type: 'choice', options: [{ id: 'json', label: 'JSON' }, { id: 'xml', label: 'XML' }] },
    { id: 'searchable', label: 'Searchable', type: 'bool' },
  ],
};
const EXPORTS = ['getCategories', 'getMediaList', 'getMediaDetail', 'search'];

function refusalsOf(overrides, exports = EXPORTS) {
  return handlesRefusals({ ...maccms, ...overrides }, exports);
}

test('the registry is the five types the design names', () => {
  assert.deepEqual([...YONTO_TYPES.keys()].sort(),
    ['jellyfin-server', 'maccms-json', 'maccms-xml', 'plugin', 'xptv-js']);
});

test('every type is a 2020-12 schema titled by its file name, open to fields added later', () => {
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);
  ajv.addSchema(typeNameSchema);
  for (const [name, schema] of YONTO_TYPES) {
    ajv.compile(schema);
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema', name);
    assert.equal(schema.title, name);
    assert.equal(schema.$id, `https://yonto.app/plugin-contract/yonto-types/${name}.schema.json`);
    assert.equal(schema.additionalProperties, true, name);
  }
});

test('every catalog type names a real field type for each property, and a const is a choice', () => {
  for (const [name, schema] of YONTO_TYPES) {
    if (name === PLUGIN_TYPE) continue;
    for (const [property, spec] of Object.entries(schema.properties)) {
      assert.ok(FIELD_TYPES.includes(spec['x-yonto-field']), `${name}.${property}: ${spec['x-yonto-field']}`);
      if ('const' in spec) assert.equal(spec['x-yonto-field'], 'choice', `${name}.${property}`);
    }
    for (const property of schema.required) assert.ok(property in schema.properties, `${name}.${property}`);
  }
});

test('each catalog type marks its properties with the field types the design gives', () => {
  const markers = (name) => Object.fromEntries(Object.entries(YONTO_TYPES.get(name).properties)
    .map(([property, spec]) => [property, spec['x-yonto-field']]));
  assert.deepEqual(markers('maccms-json'), { api: 'url', dialect: 'choice', searchable: 'bool' });
  assert.deepEqual(markers('maccms-xml'), { api: 'url', dialect: 'choice', searchable: 'bool' });
  assert.deepEqual(markers('xptv-js'), { ext: 'url', className: 'text' });
  assert.deepEqual(markers('jellyfin-server'), { serverUrl: 'url' });
});

function validator(name) {
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);
  ajv.addSchema(typeNameSchema);
  return ajv.compile(YONTO_TYPES.get(name));
}

// A handler of several types declares one field per property, so a property two types share
// has to mean one field type to both: `api` collided until xptv-js's became `className`.
test('no property is typed two ways by two catalog types', () => {
  const seen = new Map();
  for (const [name, schema] of YONTO_TYPES) {
    if (name === PLUGIN_TYPE) continue;
    for (const [property, spec] of Object.entries(schema.properties)) {
      const earlier = seen.get(property);
      if (earlier) assert.equal(spec['x-yonto-field'], earlier.field, `${property}: ${earlier.name} and ${name}`);
      else seen.set(property, { name, field: spec['x-yonto-field'] });
    }
  }
});

// #626's index copies these by hand into what it checks before an install; drift would let an
// index list a plugin the install then refuses.
test('a plugin payload describes id, version, contractVersion, provides and handles as the manifest does', () => {
  const pluginSchema = YONTO_TYPES.get('plugin');
  const plugin = pluginSchema.properties;
  const rules = ({ $comment, description, ...rest }) => rest;
  for (const key of ['id', 'version', 'contractVersion', 'provides']) {
    assert.deepEqual(rules(plugin[key]), rules(manifestSchema.properties[key]), key);
  }
  // The same grammar, reached from each schema's own place under contracts/.
  const refOf = (schema, property) => new URL(property.items.$ref, schema.$id).href;
  const { items: _, ...pluginHandles } = rules(plugin.handles);
  const { items: __, ...manifestHandles } = rules(manifestSchema.properties.handles);
  assert.deepEqual(pluginHandles, manifestHandles);
  assert.equal(refOf(pluginSchema, plugin.handles), refOf(manifestSchema, manifestSchema.properties.handles));
});

test('a plugin payload needs all four of what the install checks, and may carry more', () => {
  const valid = validator('plugin');
  const payload = { id: 'maccms', version: '1.0.0', contractVersion: 21, provides: 'source-type' };
  assert.equal(valid(payload), true);
  assert.equal(valid({ ...payload, description: 'x', addedLater: true }), true);
  assert.equal(valid({ ...payload, handles: ['maccms-json', 'io.github.someone.alist'] }), true);
  assert.equal(valid({ ...payload, handles: ['Not A Type'] }), false);
  assert.equal(valid({ ...payload, handles: ['maccms-json', 'maccms-json'] }), false);
  for (const key of Object.keys(payload)) {
    const { [key]: _, ...without } = payload;
    assert.equal(valid(without), false, `without ${key}`);
  }
  assert.equal(valid({ ...payload, version: '1.0' }), false);
  assert.equal(valid({ ...payload, provides: 'handler' }), false);
});

test('an xptv-js config needs its program, and its class name is any text', () => {
  const valid = validator('xptv-js');
  assert.equal(valid({ ext: 'https://example.com/wogg.js', className: 'csp_wogg' }), true);
  assert.equal(valid({ ext: 'https://example.com/wogg.js' }), true);
  assert.equal(valid({ className: 'csp_wogg' }), false);
  assert.equal(valid({ ext: 'https://example.com/wogg.js', className: 1 }), false);
});

test('the two MacCMS types are one schema apart only in the dialect they fill in', () => {
  const json = YONTO_TYPES.get('maccms-json');
  const xml = YONTO_TYPES.get('maccms-xml');
  assert.equal(json.properties.dialect.const, 'json');
  assert.equal(xml.properties.dialect.const, 'xml');
  const bare = (schema) => ({ ...schema.properties, dialect: null });
  assert.deepEqual(bare(json), bare(xml));
  assert.deepEqual(json.required, xml.required);
});

test('a plugin that handles nothing is not asked anything', () => {
  assert.deepEqual(handlesRefusals({ provides: 'source', catalogsAreRemote: true }, ['getSubSources']), []);
  assert.deepEqual(handlesRefusals({ provides: 'source', handles: [] }, EXPORTS), []);
});

test('a handler whose form holds what both its types fill in is accepted', () => {
  assert.deepEqual(refusalsOf({}), []);
});

test('somebody else\'s reverse-DNS type is accepted unchecked', () => {
  assert.deepEqual(refusalsOf({ handles: ['io.github.someone.alist'], configSchema: [] }), []);
  assert.deepEqual(refusalsOf({ handles: ['com.example'], configSchema: [] }), []);
});

test('a short id with no file in the registry is refused', () => {
  const [refusal, ...rest] = refusalsOf({ handles: ['maccms-json', 'alist'] });
  assert.match(refusal, /^alist is a short id.*no alist\.schema\.json —/);
  assert.deepEqual(rest, []);
});

test('a short id one slip from a Yonto type says which', () => {
  assert.match(refusalsOf({ handles: ['maccms-jsn'] })[0], /no maccms-jsn\.schema\.json \(did you mean maccms-json\?\)/);
});

const typeNames = JSON.parse(readFileSync(new URL('../conformance/yonto-type-names.json', import.meta.url), 'utf8')).cases;

test('a type name is what conformance/yonto-type-names.json says, by the shared grammar', () => {
  const ajv = new Ajv2020({ strict: false });
  const valid = ajv.compile(typeNameSchema);
  for (const { name, accepted } of typeNames) assert.equal(valid(name), accepted, JSON.stringify(name));
});

test('handles takes exactly the names the shared grammar does', () => {
  const base = { kind: 'content-source', id: 'reader', name: 'X', version: '1.0.0', contractVersion: 21, provides: 'source-type', allowedHosts: [] };
  for (const { name, accepted } of typeNames) {
    assert.equal(validateManifest({ ...base, handles: [name] }).valid, accepted, JSON.stringify(name));
  }
});

test('plugin is refused, since a plugin entry is installed rather than handled', () => {
  assert.deepEqual(refusalsOf({ handles: ['plugin'] }),
    ['plugin is not a catalog type: a plugin entry is installed, never handed to a plugin']);
});

test('a handler may not offer catalogs of its own', () => {
  assert.deepEqual(refusalsOf({}, [...EXPORTS, 'getSubSources']),
    ['a handler reads one entry as one source, and this plugin exports getSubSources']);
  assert.deepEqual(refusalsOf({ catalogsAreRemote: true }),
    ['a handler reads one entry as one source, and this plugin declares catalogsAreRemote']);
});

test('a handler may not be a source that knows its own address', () => {
  assert.deepEqual(refusalsOf({ provides: 'source' }),
    ["a handler's address comes from its entry, so it provides 'source-type', not 'source'"]);
});

test('a required property the form does not declare is refused', () => {
  const configSchema = maccms.configSchema.filter((f) => f.id !== 'api');
  assert.deepEqual(refusalsOf({ handles: ['maccms-json'], configSchema }),
    ['maccms-json requires api, a url field, and configSchema does not declare it']);
});

test('an optional property the form does not declare is not', () => {
  const configSchema = maccms.configSchema.filter((f) => f.id !== 'searchable');
  assert.deepEqual(refusalsOf({ configSchema }), []);
});

test('a property declared as another field type is refused, optional or not', () => {
  const configSchema = maccms.configSchema.map((f) =>
    (f.id === 'api' ? { ...f, type: 'text' } : f.id === 'searchable' ? { ...f, type: 'text' } : f));
  assert.deepEqual(refusalsOf({ handles: ['maccms-json'], configSchema }), [
    "maccms-json's api is a url field, and configSchema declares it as text",
    "maccms-json's searchable is a bool field, and configSchema declares it as text",
  ]);
});

// A third-party reader of XPTV's types 1 and 3.
const xptvReader = {
  handles: ['xptv-js', 'maccms-json'],
  configSchema: [
    { id: 'ext', label: 'Program', type: 'url' },
    { id: 'className', label: 'Class', type: 'text' },
    { id: 'api', label: 'API', type: 'url' },
    { id: 'dialect', label: 'Dialect', type: 'choice', options: [{ id: 'json', label: 'JSON' }] },
  ],
};

test('a reader of two types passes one strict check against each', () => {
  assert.deepEqual(refusalsOf(xptvReader), []);
  const configSchema = xptvReader.configSchema.map((f) => (f.id === 'className' ? { ...f, type: 'url' } : f));
  assert.deepEqual(refusalsOf({ ...xptvReader, configSchema }),
    ["xptv-js's className is a text field, and configSchema declares it as url"]);
});

test('a const the choice does not offer is refused', () => {
  const configSchema = maccms.configSchema.map((f) =>
    (f.id === 'dialect' ? { ...f, options: [{ id: 'json', label: 'JSON' }] } : f));
  assert.deepEqual(refusalsOf({ configSchema }),
    ['maccms-xml fills dialect with xml, which is not among configSchema.dialect\'s options']);
});

test('the other catalog types hold their handlers to their own fields', () => {
  assert.deepEqual(refusalsOf({ handles: ['xptv-js'], configSchema: [] }),
    ['xptv-js requires ext, a url field, and configSchema does not declare it']);
  assert.deepEqual(refusalsOf({ handles: ['jellyfin-server'], configSchema: [] }),
    ['jellyfin-server requires serverUrl, a url field, and configSchema does not declare it']);
});

test('every refusal is reported, not only the first', () => {
  const refusals = refusalsOf({
    provides: 'source',
    catalogsAreRemote: true,
    handles: ['plugin', 'alist', 'maccms-xml'],
    configSchema: [],
  }, [...EXPORTS, 'getSubSources']);
  assert.equal(refusals.length, 7, refusals.join('\n'));
});
