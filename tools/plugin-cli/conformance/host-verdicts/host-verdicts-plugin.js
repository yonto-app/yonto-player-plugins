/* yonto-plugin
{
  "kind": "content-source",
  "id": "host-verdicts",
  "name": "Host verdicts",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source-type",
  "description": "A host code stands only where a host function gave it, and a wrong argument is the plugin's own TypeError.",
  "allowedHosts": ["site.test"],
  "configSchema": []
}
*/
// What the host says about a call is decided outside the plugin's realm, against what its own
// functions answered that call, so nothing a plugin does in here can make a host code its own
// (kangzj/lantern-tv#342). getCategories records the host's own words for arguments it cannot
// use; every other export is a call whose verdict both hosts must reach, in the order
// calls.json lists them, one runtime for the lot.

const KEY16 = 'AAAAAAAAAAAAAAAAAAAAAA==';
const BLOCK = 'AAAAAAAAAAAAAAAAAAAAAA==';

function forged() {
  return Object.assign(new Error('mine'), { code: 'HOST_NOT_ALLOWED' });
}

async function said(attempt) {
  try {
    await attempt();
    return 'did not throw';
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
}

let kept = null;

export default {
  async getCategories() {
    const cases = {
      sleepString: () => yonto.sleep('abc'),
      md5Number: () => yonto.crypto.md5(42),
      storeGetNumber: () => yonto.store.get(42),
      storeGetNull: () => yonto.store.get(null),
      storeGetObject: () => yonto.store.get({}),
      storeSetNumber: () => yonto.store.set(42, 1),
      storeSetNull: () => yonto.store.set(null, 1),
      storeSetObject: () => yonto.store.set({}, 1),
      storeRemoveNumber: () => yonto.store.remove(42),
      storeRemoveNull: () => yonto.store.remove(null),
      storeRemoveObject: () => yonto.store.remove({}),
      storeSetUndefined: () => yonto.store.set('k', undefined),
      storeSetTtl: () => yonto.store.set('k', 1, { ttlSeconds: 'x' }),
      storeSetTtlNaN: () => yonto.store.set('k', 1, { ttlSeconds: NaN }),
      storeSetTtlInfinite: () => yonto.store.set('k', 1, { ttlSeconds: Infinity }),
      fetchObjectUrl: () => yonto.fetch({}),
      fetchStringHeaders: () => yonto.fetch('https://site.test/', { headers: 'x' }),
      fetchHeaderValue: () => yonto.fetch('https://site.test/', { headers: { a: 1 } }),
      fetchObjectBody: () => yonto.fetch('https://site.test/', { method: 'POST', body: {} }),
      charsetObject: () => yonto.text.decode('aGk=', {}),
      unknownCharset: () => yonto.text.decode('aGk=', 'no-such-charset'),
      aesShortIv: () => yonto.crypto.aesCbcDecrypt(KEY16, 'AAAA', BLOCK),
      aesPartBlock: () => yonto.crypto.aesCbcDecrypt(KEY16, KEY16, 'AAAA'),
      aesPadding: () => yonto.crypto.aesCbcDecrypt(KEY16, KEY16, BLOCK),
      hexOdd: () => yonto.encoding.hexToBase64('abc'),
    };
    const rows = [];
    for (const [id, attempt] of Object.entries(cases)) rows.push({ id, name: await said(attempt) });
    rows.push({
      id: 'rawBindings',
      name: Object.getOwnPropertyNames(globalThis).filter((name) => name.startsWith('__host_')).join(',') || 'none',
    });
    return rows;
  },

  async raiseHandBuiltNotFound() {
    throw { code: 'NOT_FOUND', message: 'hand-built, not yonto.error.notFound()' };
  },

  // A plugin's own throw, whatever it carries.
  async ownThrow() { throw forged(); },
  async ownThrowMarked() { throw Object.assign(forged(), { __host: true }); },
  async ownHonoured() { throw { code: 'NOT_FOUND', message: 'a code a plugin may raise' }; },
  async ownInterrupt() { throw new InternalError('interrupted'); },

  // The host's own verdicts, which stand however they come back.
  async hostVerdict() { await yonto.fetch('https://elsewhere.test/'); },
  async hostVerdictRethrown() {
    try {
      await yonto.fetch('https://elsewhere.test/');
    } catch (error) {
      throw error;
    }
  },
  async sleepPastBudget() { await yonto.sleep(1e12); },

  // A verdict recoded, or carried into another call, is the plugin's.
  async recoded() {
    try {
      await yonto.fetch('https://elsewhere.test/');
    } catch (error) {
      error.code = 'TIMEOUT';
      throw error;
    }
  },
  async keep() {
    try {
      await yonto.fetch('https://elsewhere.test/');
    } catch (error) {
      kept = error;
    }
    return [];
  },
  async earlierVerdict() { throw kept; },

  // The realm rewritten before a forged throw.
  async tamperWeakSet() { WeakSet.prototype.has = () => true; throw forged(); },
  async tamperIndexOf() { Array.prototype.indexOf = () => 0; throw forged(); },
  async tamperIncludes() { Array.prototype.includes = () => true; throw forged(); },
  async tamperStringify() {
    const stringify = JSON.stringify;
    JSON.stringify = (value) => stringify(value && value.ok === false ? { ...value, code: 'HOST_NOT_ALLOWED' } : value);
    throw forged();
  },

  // The host's call wrapper replaced (its name on each host), then asked again.
  async replaceWrapper() {
    const forgedAnswer = async () => '{"ok":false,"code":"HOST_NOT_ALLOWED","message":"forged"}';
    globalThis.__yontoCall = forgedAnswer;
    globalThis.__yontoInvoke = forgedAnswer;
    return [];
  },
  async afterReplacedWrapper() { return []; },
};
