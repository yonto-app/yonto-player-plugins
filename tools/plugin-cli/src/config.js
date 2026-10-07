import { Code, PluginError } from './errors.js';
import { hostOf } from './hostname.js';
import { FIELD_TYPE_CHOICE, FIELD_TYPE_URL } from './manifest.js';

const FIELD_TYPE_BOOL = 'bool';

/**
 * What a plugin reads as `yonto.config` for a form's answers: `PluginConfigForm.validate`
 * on a device, field by field in the same order of steps, and held to the same record
 * (`conformance/config.json`, kangzj/lantern-tv#414).
 *
 * Walked over the declared fields rather than the answers, as the device does, so a key no
 * field declares reaches a plugin nowhere and a bool nobody touched is still `'false'`. Every
 * answer is trimmed, and one that is empty after that is left out entirely, so a plugin
 * reading `yonto.config.x || FALLBACK` gets its fallback on both hosts and `'x' in
 * yonto.config` says the same thing on both. A required field left unanswered is not this
 * function's to refuse; `hostAndEngine` does that before a plugin runs.
 */
export function configOf(configSchema, values) {
  const config = {};
  for (const field of configSchema) {
    const value = normalized(field, Object.hasOwn(values, field.id) ? values[field.id] : '').trim();
    if (value === '') continue;
    config[field.id] = field.type === FIELD_TYPE_URL ? sourceUrl(field, value) : value;
  }
  return config;
}

/** A bool is one of two words and a choice an option the field still offers, as on a device. */
function normalized(field, value) {
  if (field.type === FIELD_TYPE_BOOL) return value.trim() === 'true' ? 'true' : 'false';
  // A renamed option leaves a saved answer naming one that is gone, and the device blanks it
  // rather than hand a plugin a value its own manifest no longer offers.
  if (field.type === FIELD_TYPE_CHOICE) {
    return (field.options ?? []).some((option) => option.id === value.trim()) ? value.trim() : '';
  }
  return value;
}

/**
 * A `url` the way `SourceUrl.normalize` saves it: a scheme filled in when it was left off,
 * because `192.168.1.50:8096` is what gets typed on a remote, and the path's trailing
 * slashes dropped, the query and fragment left alone. One that names no host the gate would
 * recognise is refused, as the form refuses to save it, rather than handed to a plugin a
 * television could never have run with it (kangzj/lantern-tv#521).
 */
function sourceUrl(field, trimmed) {
  const url = trimmed.includes('://') ? trimmed : `http://${trimmed}`;
  if (hostOf(url) === null) {
    throw new PluginError(Code.CONFIG_INVALID,
      `${field.id} is not an address a television would save: ${trimmed}`, { id: field.id });
  }
  const queryAt = url.search(/[?#]/);
  const tail = queryAt === -1 ? url.length : queryAt;
  const authorityEnd = url.indexOf('/', url.indexOf('://') + 3);
  if (authorityEnd === -1 || authorityEnd >= tail) return url;
  return url.slice(0, authorityEnd) + url.slice(authorityEnd, tail).replace(/\/+$/, '') + url.slice(tail);
}
