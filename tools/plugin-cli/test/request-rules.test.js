import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFetch } from '../src/host/fetch.js';
import { REQUEST_RULES } from '../src/host/request-shape.js';

// `PluginRequestRulesRecordTest` walks the same record, and the same generated cases, through
// the device's `yonto.fetch` (kangzj/lantern-tv#651).

const URL_ASKED = 'https://conformance.test/a';

/** Answers 200 to anything, or a 302 to [redirectsTo] for the first request, and keeps them. */
function recordingTransport(redirectsTo) {
  return {
    calls: [],
    async request(req) {
      this.calls.push(req);
      if (redirectsTo !== undefined && this.calls.length === 1) {
        return { status: 302, headers: { location: redirectsTo }, bodyBase64: '' };
      }
      return { status: 200, headers: {}, bodyBase64: '' };
    },
  };
}

async function outcome({ url, init = {}, redirectsTo }) {
  const transport = recordingTransport(redirectsTo);
  const fetch = createFetch({
    hosts: { fromManifest: ['conformance.test'], fromViewer: [], fromRepo: [], floorExempt: [], all: ['conformance.test'] },
    transport,
    requests: [],
  });
  const error = await fetch(url, init).then(() => null, (e) => e);
  const sent = transport.calls[0];
  const contentType = sent && Object.entries(sent.headers ?? {}).find(([name]) => name.toLowerCase() === 'content-type');
  return { error, sent, contentType: contentType ? contentType[1] : null };
}

/** A case for every entry of every list, so an entry added to the file is checked by it. */
function generatedCases() {
  const refusedHeader = (name, value = 'x') => ({
    why: `${name} is refused`,
    url: URL_ASKED,
    init: { headers: { [name]: value } },
    refused: `${name} is a header the host does not let a plugin set`,
  });
  return [
    ...REQUEST_RULES.forbiddenMethods.map((method) => ({
      why: `${method} is refused`, url: URL_ASKED, init: { method: method.toLowerCase() },
      refused: `${method.toLowerCase()} is a method the host does not send`,
    })),
    ...REQUEST_RULES.normalisedMethods.map((method) => ({
      why: `${method} is sent upper case`, url: URL_ASKED, init: { method: method.toLowerCase() },
      sent: { method },
    })),
    ...REQUEST_RULES.forbiddenHeaders.map((name) => refusedHeader(name)),
    ...REQUEST_RULES.forbiddenHeaderPrefixes.map((prefix) => refusedHeader(`${prefix}anything`)),
    ...REQUEST_RULES.methodOverrideHeaders.map((name) => refusedHeader(name, 'GET, connect')),
    ...Object.keys(REQUEST_RULES.allowedDespiteFetch).map((name) => ({
      why: `${name} is sent though Fetch forbids it`, url: URL_ASKED, init: { headers: { [name]: 'x' } },
      sent: { method: 'GET' },
    })),
  ];
}

test('yonto.fetch refuses and sends what conformance/request-rules.json says', async () => {
  for (const c of [...REQUEST_RULES.cases, ...generatedCases()]) {
    const { error, sent, contentType } = await outcome(c);
    if (c.refused !== undefined) {
      assert.equal(error?.code, 'REQUEST_INVALID', c.why);
      assert.equal(error.message, c.refused, c.why);
      assert.equal(sent, undefined, `${c.why}: nothing is sent`);
    } else if (c.refusedRedirect !== undefined) {
      assert.equal(error?.code, 'REDIRECT_REFUSED', c.why);
      assert.equal(error.message, c.refusedRedirect, c.why);
    } else {
      assert.equal(error, null, `${c.why}: ${error?.message}`);
      assert.equal(sent.method, c.sent.method, c.why);
      if ('contentType' in c.sent) assert.equal(contentType, c.sent.contentType, c.why);
    }
  }
});
