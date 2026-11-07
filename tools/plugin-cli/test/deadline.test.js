import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHost } from '../src/host/index.js';
import { Code, PluginError } from '../src/errors.js';
import { scratchDir } from '../src/scratch-dir.js';

/**
 * What bounds a whole call — and
 * `docs/design/2026-09-20-bounding-a-whole-call.md`.
 *
 * The device measured the defect: its interrupt is polled per opcode, so a loop that
 * awaits a host function each turn runs for about a thousand turns whatever the budget
 * says. The rule both hosts carry now is a deadline checked at the host-function boundary:
 * a park already begun runs to its own bound, and the next one is refused.
 *
 * This host bounds a call the way the device does, so here too it is
 * the rule that ends a call that keeps parking.
 */

function hostAt(clock, { transport } = {}) {
  return createHost({
    manifest: { id: 'demo', allowedHosts: ['h.tv'], capabilities: [] },
    transport: transport ?? {
      async request() { return { status: 200, headers: {}, bodyBase64: '' }; },
    },
    storeDir: scratchDir('lp-deadline-'),
    pluginDir: '/probe/plugin',
    now: () => clock.value,
  });
}

test('a call that has spent its budget cannot start another request', async () => {
  const clock = { value: 1_000_000 };
  const transport = {
    calls: 0,
    async request() { this.calls += 1; clock.value += 6000; return { status: 200, headers: {}, bodyBase64: '' }; },
  };
  const { yonto, startCall } = hostAt(clock, { transport });
  startCall(10_000);

  await yonto.fetch('https://h.tv/1');
  await yonto.fetch('https://h.tv/2');

  await assert.rejects(() => yonto.fetch('https://h.tv/3'), (error) => {
    assert.equal(error.code, Code.TIMEOUT);
    return true;
  });
  assert.equal(transport.calls, 2, 'the third never reached the transport');
});

test('a park already begun is allowed to finish, however long the network took', async () => {
  const clock = { value: 1_000_000 };
  const transport = {
    calls: 0,
    async request() { this.calls += 1; clock.value += 30_000; return { status: 200, headers: {}, bodyBase64: '' }; },
  };
  const { yonto, startCall } = hostAt(clock, { transport });
  startCall(10_000);

  const response = await yonto.fetch('https://h.tv/1');

  assert.equal(response.status, 200);
  assert.equal(transport.calls, 1);
});

test('each call is given the deadline again', async () => {
  const clock = { value: 1_000_000 };
  const { yonto, startCall } = hostAt(clock);

  startCall(10_000);
  await yonto.fetch('https://h.tv/1');
  clock.value += 9_000;
  startCall(10_000);

  assert.equal((await yonto.fetch('https://h.tv/2')).status, 200);
});

test('the deadline is the same for every way a call can park', async () => {
  const clock = { value: 1_000_000 };
  const { yonto, startCall } = hostAt(clock);
  startCall(10_000);
  clock.value += 11_000;

  await assert.rejects(() => yonto.store.set('key', 'value'), (error) => {
    assert.equal(error.code, Code.TIMEOUT);
    return true;
  });
  await assert.rejects(() => yonto.sleep(1), (error) => {
    assert.equal(error.code, Code.TIMEOUT);
    return true;
  });
});

// What a request that answered past the deadline brought can still be kept, for a short grace.
test('the cache answers past the deadline only for a moment after the last request ended', async () => {
  const clock = { value: 1_000_000 };
  const transport = { async request() { clock.value += 25_000; return { status: 200, headers: {}, bodyBase64: '' }; } };
  const { yonto, startCall } = hostAt(clock, { transport });
  startCall(10_000);

  await yonto.fetch('https://h.tv/1');
  await yonto.cache.set('key', 'kept');
  assert.equal(await yonto.cache.get('key'), 'kept');
  await assert.rejects(() => yonto.store.get('key'), (error) => error.code === Code.TIMEOUT);

  clock.value += 5_000;
  await assert.rejects(() => yonto.cache.get('key'), (error) => error.code === Code.TIMEOUT && /yonto\.cache\.get/.test(error.message));
});

test('a request that failed past the deadline starts the grace as one that answered does', async () => {
  const clock = { value: 1_000_000 };
  const transport = { async request() { clock.value += 25_000; throw new PluginError(Code.REQUEST_FAILED, 'no answer'); } };
  const { yonto, startCall } = hostAt(clock, { transport });
  startCall(10_000);

  await assert.rejects(() => yonto.fetch('https://h.tv/1'));
  await yonto.cache.set('key', 'kept');
  assert.equal(await yonto.cache.get('key'), 'kept');
});

test("a request of an earlier call that ends during the next one gives the next no grace", async () => {
  const clock = { value: 1_000_000 };
  let answer;
  const answered = new Promise((resolve) => { answer = resolve; });
  const transport = { async request() { await answered; return { status: 200, headers: {}, bodyBase64: '' }; } };
  const { yonto, startCall } = hostAt(clock, { transport });
  startCall(1_000);
  const earlier = yonto.fetch('https://h.tv/1');

  startCall(1_000);
  clock.value += 1_500;
  answer();
  await earlier;

  await assert.rejects(() => yonto.cache.get('key'), (error) => error.code === Code.TIMEOUT);
});

test('a call reading its cache in a loop with no request in flight stops at the deadline', async () => {
  const clock = { value: 1_000_000 };
  const { yonto, startCall } = hostAt(clock);
  startCall(10_000);

  let reads = 0;
  for (;;) {
    try {
      await yonto.cache.get('key');
    } catch (error) {
      assert.equal(error.code, Code.TIMEOUT);
      break;
    }
    reads += 1;
    clock.value += 3_000;
  }

  assert.equal(reads, 4);
});

test('a host with no call in flight starts nothing at all', async () => {
  // Zero until a call announces itself, the way the sleep budget is: a host reached
  // outside a call is one whose engine is not driving it.
  const clock = { value: 1_000_000 };
  const { yonto } = hostAt(clock);

  await assert.rejects(() => yonto.fetch('https://h.tv/1'), (error) => {
    assert.equal(error.code, Code.TIMEOUT);
    return true;
  });
});
