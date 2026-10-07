import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Code, PluginError } from '../src/errors.js';
import { NOT_LOGGED_IN, runDoctor } from '../src/doctor.js';
import { formatReport } from '../src/format.js';
import { createSecrets } from '../src/host/mask.js';
import { STOP_AFTER_MS, checkLink, countdown, exportLine, learningHostSecrets, runLink } from '../src/link.js';
import { createRecordTransport } from '../src/transport/record.js';
import { SERVICES, linkRecord, readRegistry } from '../src/link-login.js';
import { createSession } from '../src/host/session.js';
import { scratchDir } from '../src/scratch-dir.js';

/**
 * `yonto-plugin link` and what `doctor` makes of a linkLogin plugin, against plex.tv's
 * declaration and a scripted service on a virtual clock.
 */

const PLEX = SERVICES['plex.tv'];
const DEVICE = readRegistry(readFileSync(new URL('../conformance/link-login/declarations.json', import.meta.url), 'utf8'))['device.test'];
const START = 'https://plex.tv/api/v2/pins';
const pin = (id, code, expiresIn = 900) => ({ status: 201, body: { id, code, expiresIn, authToken: null } });

/** A service answering each request with the next of [script]'s answers for its URL, and a clock that sleeps instantly. */
function service(script) {
  const clock = { now: 0 };
  const said = [];
  const transport = {
    asked: [],
    async request(req) {
      this.asked.push(req);
      const url = req.url.startsWith(`${START}/`) ? 'poll' : req.url;
      const answer = script[url].shift();
      if (answer instanceof Error) throw answer;
      return { status: answer.status, headers: {}, bodyBase64: Buffer.from(JSON.stringify(answer.body ?? {})).toString('base64') };
    },
  };
  return {
    transport,
    said,
    clock,
    run: () => runLink({
      service: PLEX, transport, clientId: 'host-client-id', now: () => clock.now,
      sleep: async (ms) => { clock.now += ms; }, say: (line) => said.push(line),
    }),
  };
}

test('a code linked on a phone answers the account credential, having shown the code, the page and the QR', async () => {
  const run = service({
    [START]: [pin(7, 'WXYZ')],
    poll: [{ status: 200, body: { authToken: null } }, { status: 200, body: { authToken: 'account-token-cccccccc' } }],
  });

  assert.equal(await run.run(), 'account-token-cccccccc');
  assert.deepEqual(run.said, [
    'On your phone or computer, go to plex.tv/link and enter this code: WXYZ',
    'Or open https://www.plex.tv/link/?pin=WXYZ',
    'Code expires in 15:00',
  ]);
  assert.equal(run.transport.asked[1].url, `${START}/7`);
  assert.equal(run.clock.now, 6000, 'polled every three seconds');
});

/** device.test's RFC 8628 service answering each of its two URLs from [script] in turn, and every wait recorded. */
function deviceService(script) {
  const clock = { now: 0, slept: [] };
  const transport = {
    asked: [],
    async request(req) {
      this.asked.push(req);
      const answer = script[req.url].shift();
      return { status: answer.status, headers: {}, bodyBase64: Buffer.from(JSON.stringify(answer.body)).toString('base64') };
    },
  };
  return {
    transport,
    clock,
    run: () => runLink({
      service: DEVICE, transport, clientId: 'host-client-id', now: () => clock.now,
      sleep: async (ms) => { clock.slept.push(ms); clock.now += ms; }, say: () => {},
    }),
  };
}

const DEVICE_CODE = { status: 200, body: { device_code: 'dc-secret-1234', user_code: 'ABCD-EFGH', expires_in: 600, interval: 5 } };
const DEVICE_ERROR = (error) => ({ status: 400, body: { error } });

test('each slow_down widens every later wait by five seconds, and a pending answer keeps the wait it has', async () => {
  const run = deviceService({
    'https://device.test/device/code': [DEVICE_CODE],
    'https://device.test/token': [
      DEVICE_ERROR('slow_down'), DEVICE_ERROR('slow_down'), DEVICE_ERROR('authorization_pending'),
      { status: 200, body: { access_token: 'device-token-1234' } },
    ],
  });

  assert.equal(await run.run(), 'device-token-1234');
  assert.deepEqual(run.clock.slept, [5000, 10000, 15000, 15000]);
});

test('a slow_down is not a failed poll, however many come in a row', async () => {
  const run = deviceService({
    'https://device.test/device/code': [DEVICE_CODE],
    'https://device.test/token': [
      DEVICE_ERROR('slow_down'), DEVICE_ERROR('slow_down'), DEVICE_ERROR('slow_down'), DEVICE_ERROR('slow_down'),
      { status: 200, body: { access_token: 'device-token-1234' } },
    ],
  });

  assert.equal(await run.run(), 'device-token-1234');
});

test('the start and the poll are sent with their bodies', async () => {
  const run = deviceService({
    'https://device.test/device/code': [DEVICE_CODE],
    'https://device.test/token': [{ status: 200, body: { access_token: 'device-token-1234' } }],
  });

  await run.run();

  assert.deepEqual(run.transport.asked.map(({ method, body }) => ({ method, body })), [
    { method: 'POST', body: 'client_id=yonto-device-test' },
    { method: 'POST', body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&device_code=dc-secret-1234&client_id=yonto-device-test' },
  ]);
});

test('a code that expires is replaced by a new one, and says so', async () => {
  const run = service({
    [START]: [pin(7, 'WXYZ', 10), pin(8, 'ABCD')],
    poll: [{ status: 200, body: {} }, { status: 200, body: {} }, { status: 200, body: {} }, { status: 200, body: { authToken: 'account-token-cccccccc' } }],
  });

  await run.run();

  assert.ok(run.said.includes("That code expired, so here's a new one"));
  assert.ok(run.said.includes('On your phone or computer, go to plex.tv/link and enter this code: ABCD'));
});

test('a pin the service says is gone is replaced at once', async () => {
  const run = service({
    [START]: [pin(7, 'WXYZ'), pin(8, 'ABCD')],
    poll: [{ status: 404 }, { status: 200, body: { authToken: 'account-token-cccccccc' } }],
  });

  assert.equal(await run.run(), 'account-token-cccccccc');
  assert.equal(run.transport.asked.at(-1).url, `${START}/8`);
});

test('three failed polls in a row end it, two do not', async () => {
  const twice = service({
    [START]: [pin(7, 'WXYZ')],
    poll: [new Error('down'), { status: 500 }, { status: 200, body: {} }, new Error('down'), { status: 200, body: { authToken: 'account-token-cccccccc' } }],
  });
  assert.equal(await twice.run(), 'account-token-cccccccc');

  const thrice = service({ [START]: [pin(7, 'WXYZ')], poll: [new Error('down'), { status: 500 }, { status: 502 }] });
  await assert.rejects(thrice.run(), /Can't reach plex\.tv right now/);
});

test('a start the rules refuse is a failed start, never a sign-in', async () => {
  const run = service({ [START]: [{ status: 201, body: { id: 7, code: 'WXYZ', expiresIn: 5 } }] });
  await assert.rejects(run.run(), /Can't get a code from plex\.tv right now: the start answered an expiry outside 10 seconds to an hour/);
});

test('it stops asking after half an hour, whatever the service says', async () => {
  const run = service({
    [START]: Array.from({ length: 5 }, (_, i) => pin(i + 1, 'WXYZ')),
    poll: Array.from({ length: 700 }, () => ({ status: 200, body: {} })),
  });

  await assert.rejects(run.run(), /This code has expired/);
  assert.ok(run.clock.now >= STOP_AFTER_MS && run.clock.now < STOP_AFTER_MS + 3000);
});

test('the countdown reads as minutes and seconds', () => {
  assert.equal(countdown(900_000), '15:00');
  assert.equal(countdown(61_500), '1:02');
  assert.equal(countdown(-5), '0:00');
});

test('the line for eval quotes the session for a shell, an apostrophe included', () => {
  const line = exportLine("it's-a-token", { service: 'plex.tv' });
  const printed = execFileSync('sh', ['-c', `${line}; printf %s "$YONTO_PLUGIN_SESSION"`], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(printed), { credential: "it's-a-token", record: { service: 'plex.tv' } });
});

test('link refuses a plugin with no linkLogin, naming the services there are', () => {
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const run = spawnSync('node', [cli, 'link', fileURLToPath(new URL('../test-plugins/ok/', import.meta.url))], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /declares no linkLogin, so there is nothing to sign in to \(services: plex\.tv\)/);
});

test('doctor\'s check of a service is one start and one poll, expected pending', async () => {
  const run = service({ [START]: [pin(7, 'WXYZ')], poll: [{ status: 200, body: { authToken: null } }] });

  const steps = await checkLink({ service: PLEX, transport: run.transport, clientId: 'c' });

  assert.deepEqual(steps.map(({ method, ok, message }) => ({ method, ok, message })), [
    { method: 'link start', ok: true, message: 'a 4-character code, expiring in 15:00, polled every 3 s' },
    { method: 'link poll', ok: true, message: 'pending, as a code nobody has typed should be' },
  ]);
  assert.equal(run.transport.asked.length, 2);
});

test('and a poll that is not pending fails it', async () => {
  const run = service({ [START]: [pin(7, 'WXYZ')], poll: [{ status: 404 }] });
  const [, poll] = await checkLink({ service: PLEX, transport: run.transport, clientId: 'c' });
  assert.deepEqual({ ok: poll.ok, code: poll.code, message: poll.message }, { ok: false, code: Code.REQUEST_FAILED, message: 'expected pending, and it was expired' });
});

test('a poll told to slow down is still pending, as doctor reads it', async () => {
  const run = deviceService({ 'https://device.test/device/code': [DEVICE_CODE], 'https://device.test/token': [DEVICE_ERROR('slow_down')] });
  const [, poll] = await checkLink({ service: DEVICE, transport: run.transport, clientId: 'c' });
  assert.deepEqual({ ok: poll.ok, message: poll.message }, { ok: true, message: 'pending, as a code nobody has typed should be' });
});

/** An engine whose every method raises `unauthenticated`, as a signed-out plugin does. */
const signedOut = {
  async exports() { return ['getCategories', 'getMediaList', 'getMediaDetail', 'search']; },
  async call() { throw new PluginError(Code.UNAUTHENTICATED, 'not logged in'); },
};

test('doctor runs a signed-out plugin to the end, naming each step that needs the login rather than failing it', async () => {
  const report = await runDoctor({ engine: signedOut, requests: [], loggedOut: true });

  assert.equal(report.ok, true);
  assert.deepEqual(report.steps.filter((s) => s.method === 'getCategories' || s.method === 'search').map((s) => s.message),
    [NOT_LOGGED_IN, NOT_LOGGED_IN]);
  assert.equal(report.steps.find((s) => s.method === 'getMediaList').message, `skipped — ${NOT_LOGGED_IN}`);
});

test('a plugin that has a session and is refused anyway still fails', async () => {
  const report = await runDoctor({ engine: signedOut, requests: [], loggedOut: false });
  assert.equal(report.ok, false);
  assert.equal(report.steps.find((s) => s.method === 'getCategories').code, Code.UNAUTHENTICATED);
});

test('a report never prints a held credential, nor a service\'s credential header', () => {
  const report = { steps: [{ method: 'getCategories', ok: false, code: Code.UNAUTHENTICATED, message: 'tok-12345678 refused', ms: 1, requests: 1 }] };
  const requests = [{ method: 'GET', url: 'https://x.test/a?t=tok-12345678', status: 401, blocked: false,
    requestHeaders: { 'X-Plex-Token': 'typed-token-1', Accept: 'application/json' } }];

  const printed = formatReport({ id: 'p', version: '1.0.0', contractVersion: 21, allowedHosts: [] }, report, requests,
    (text) => text.replaceAll('tok-12345678', '‹credential›'));

  assert.equal(printed.includes('tok-12345678'), false);
  assert.equal(printed.includes('typed-token-1'), false);
  assert.match(printed, /X-Plex-Token: <13 characters, hidden>/);
});

test('a recording learns a sign-in\'s id and code from the start before writing it, so neither fixture holds them', async () => {
  const dir = scratchDir('lp-host-');
  const secrets = createSecrets();
  const run = service({ [START]: [pin(1000000001, 'WXYZ')], poll: [{ status: 200, body: { id: 1000000001, authToken: null } }] });
  const recorder = createRecordTransport({
    inner: run.transport, dir, secrets, hostOwn: true, learn: learningHostSecrets(PLEX, secrets),
    refused: (file, why) => assert.fail(`${file}: ${why}`),
  });

  await checkLink({ service: PLEX, transport: recorder, clientId: 'c' });

  const written = readdirSync(dir).map((name) => readFileSync(join(dir, name), 'utf8'));
  assert.equal(written.length, 2);
  for (const text of written) {
    assert.equal(/1000000001|WXYZ/.test(text + Buffer.from(JSON.parse(text).response.bodyBase64, 'base64').toString()), false);
  }
});

test('a recording writes the poll\'s body with the device code the start answered hidden, however the body encodes it', async () => {
  const dir = scratchDir('lp-host-');
  const secrets = createSecrets();
  const run = deviceService({
    'https://device.test/device/code': [{ status: 200, body: { ...DEVICE_CODE.body, device_code: 'dc/secret 1234' } }],
    'https://device.test/token': [DEVICE_ERROR('authorization_pending')],
  });
  const recorder = createRecordTransport({
    inner: run.transport, dir, secrets, hostOwn: true, learn: learningHostSecrets(DEVICE, secrets),
    refused: (file, why) => assert.fail(`${file}: ${why}`),
  });

  await checkLink({ service: DEVICE, transport: recorder, clientId: 'c' });

  const written = readdirSync(dir).map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')));
  const poll = written.find((fixture) => fixture.request.url === 'https://device.test/token');
  assert.equal(poll.request.body, 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&device_code=<pin>&client_id=yonto-device-test');
});

test('a recording of the account\'s server list writes no credential it lists, a player\'s or an unreadable server\'s included', async () => {
  const dir = scratchDir('lp-host-');
  const secrets = createSecrets();
  const resources = [
    { name: 'Friend', clientIdentifier: 'server-friend', provides: 'server', owned: false, accessToken: 'shared-token-aaaaaaaa', connections: [] },
    { name: 'Mine', clientIdentifier: 'server-mine', provides: 'server', owned: true, accessToken: 'owned/token+bbbb=', connections: [] },
    { name: 'Phone', clientIdentifier: 'player-phone', provides: 'player,controller', owned: true, accessToken: 'player-token-dddddddd', connections: [] },
    { name: 'Odd', clientIdentifier: 'server-odd', provides: 'server', owned: false, accessToken: 'odd-token-eeeeeeee', connections: [{ uri: 'https://x.plex.direct:32400' }] },
  ];
  const account = {
    async request() {
      return { status: 200, headers: {}, bodyBase64: Buffer.from(JSON.stringify(resources)).toString('base64') };
    },
  };
  const recorder = createRecordTransport({
    inner: account, dir, secrets, hostOwn: true, learn: learningHostSecrets(PLEX, secrets),
    refused: (file, why) => assert.fail(`${file}: ${why}`),
  });
  const manifest = { id: 'probe', allowedHosts: ['*.plex.direct'], capabilities: [{ type: 'linkLogin', service: 'plex.tv' }] };
  const session = createSession({
    manifest, held: { credential: 'account-token-cccccccc', record: linkRecord(manifest, 0) }, transport: recorder,
    clientId: 'e3b0c44298fc1c149afbf4c8996fb924', now: () => 0, secrets,
  });

  await session.servers();

  const [written] = readdirSync(dir).map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')));
  const body = Buffer.from(written.response.bodyBase64, 'base64').toString();
  assert.equal(/shared-token|owned\/token|player-token|odd-token|account-token/.test(JSON.stringify(written) + body), false);
  assert.deepEqual(JSON.parse(body).map((r) => r.accessToken), Array(4).fill('<server-credential>'));
});
