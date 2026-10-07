import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHost } from '../src/host/index.js';
import { Code } from '../src/errors.js';
import { scratchDir } from '../src/scratch-dir.js';

/**
 * What bounds a whole call — kangzj/lantern-tv#178 and
 * `docs/design/2026-09-20-bounding-a-whole-call.md`.
 *
 * The device measured the defect: its interrupt is polled per opcode, so a loop that
 * awaits a host function each turn runs for about a thousand turns whatever the budget
 * says. The rule both hosts carry now is a deadline checked at the host-function boundary:
 * a park already begun runs to its own bound, and the next one is refused.
 *
 * This host bounds a call the way the device does (kangzj/yonto#513), so here too it is
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
