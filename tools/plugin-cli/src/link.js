import { Code } from './errors.js';
import { hostOf } from './hostname.js';
import {
  beginRequest, credentialsListed, discoverRequest, pollRequest, readBegin, readPoll, widened,
} from './host/link-sign-in.js';
import { PLACEHOLDERS } from './host/mask.js';

/** How long a sign-in keeps asking, whatever the service says: a screen left open overnight asks nobody. */
export const STOP_AFTER_MS = 30 * 60 * 1000;

/** The one line `link` prints to stdout, for `eval` to run: the session, in the environment only. */
export function exportLine(credential, record) {
  return `export YONTO_PLUGIN_SESSION='${JSON.stringify({ credential, record }).replaceAll("'", "'\\''")}'`;
}

/** Polls in a row that may fail before the sign-in gives up. */
const FAILURES_TO_GIVE_UP = 3;

const bodyText = (answer) => Buffer.from(answer.bodyBase64 ?? '', 'base64').toString('utf8');

/** `m:ss`, as a countdown reads. */
export function countdown(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

async function asked(transport, request) {
  return transport.request(request);
}

/**
 * `yonto-plugin link`: a code to type at the service's page, asked about until the viewer
 * links it, a new code whenever one expires, and the account credential at the end — the
 * device's sign-in screen and poller, in a terminal. What it prints goes to [say]; the one
 * thing it answers is the credential, which the caller hands to `eval` and nothing records.
 */
export async function runLink({ service, transport, clientId, now = Date.now, sleep, say }) {
  const site = hostOf(service.visit);
  const started = now();
  for (;;) {
    let code;
    try {
      const answer = await asked(transport, beginRequest(service, clientId));
      const read = readBegin(service, answer.status, bodyText(answer));
      if (read.refused) throw new Error(read.refused);
      code = read.code;
    } catch (error) {
      throw new Error(`Can't get a code from ${site} right now: ${error.message}`);
    }
    const expiresAt = now() + code.expiresInMs;
    say(`On your phone or computer, go to ${code.visit.replace(/^https:\/\//, '')} and enter this code: ${code.userCode}`);
    if (code.qr !== code.visit) say(`Or open ${code.qr}`);
    say(`Code expires in ${countdown(expiresAt - now())}`);

    let failures = 0;
    let interval = code.intervalMs;
    let lastMinute = Math.ceil((expiresAt - now()) / 60_000);
    for (;;) {
      await sleep(interval);
      if (now() - started >= STOP_AFTER_MS) throw new Error('This code has expired');
      if (now() >= expiresAt) break;
      let outcome;
      try {
        const answer = await asked(transport, pollRequest(service, clientId, code));
        outcome = readPoll(service, answer.status, bodyText(answer));
      } catch {
        outcome = { outcome: 'failed' };
      }
      if (outcome.outcome === 'linked') return outcome.credential;
      if (outcome.outcome === 'expired') break;
      if (outcome.outcome === 'denied') throw new Error(`${site} didn't allow this login`);
      if (outcome.outcome === 'slower') interval = widened(interval, outcome.byMs);
      failures = outcome.outcome === 'failed' ? failures + 1 : 0;
      if (failures >= FAILURES_TO_GIVE_UP) throw new Error(`Can't reach ${site} right now`);
      const minute = Math.ceil((expiresAt - now()) / 60_000);
      if (minute < lastMinute) {
        lastMinute = minute;
        say(`Code expires in ${countdown(expiresAt - now())}`);
      }
    }
    say("That code expired, so here's a new one");
  }
}

/**
 * What `doctor` checks of a signed-out linkLogin plugin's service: one real start and one poll,
 * each held to the rules every service's answers are, and the poll expected to be pending
 * (`slower` is pending too: a poll asked at once may be told to wait).
 */
export async function checkLink({ service, transport, clientId }) {
  const steps = [];
  const step = (method, started, fields) => steps.push({ method, skipped: false, ms: Date.now() - started, requests: 1, ...fields });
  let started = Date.now();
  let code;
  try {
    const answer = await asked(transport, beginRequest(service, clientId));
    const read = readBegin(service, answer.status, bodyText(answer));
    if (read.refused) {
      step('link start', started, { ok: false, code: Code.REQUEST_FAILED, message: read.refused });
      return steps;
    }
    code = read.code;
    step('link start', started, { ok: true, code: null,
      message: `a ${code.userCode.length}-character code, expiring in ${countdown(code.expiresInMs)}, polled every ${code.intervalMs / 1000} s` });
  } catch (error) {
    step('link start', started, { ok: false, code: error.code ?? Code.REQUEST_FAILED, message: error.message });
    return steps;
  }
  started = Date.now();
  try {
    const answer = await asked(transport, pollRequest(service, clientId, code));
    const { outcome, reason } = readPoll(service, answer.status, bodyText(answer));
    step('link poll', started, outcome === 'pending' || outcome === 'slower'
      ? { ok: true, code: null, message: 'pending, as a code nobody has typed should be' }
      : { ok: false, code: Code.REQUEST_FAILED, message: `expected pending, and it was ${outcome}${reason ? `: ${reason}` : ''}` });
  } catch (error) {
    step('link poll', started, { ok: false, code: error.code ?? Code.REQUEST_FAILED, message: error.message });
  }
  return steps;
}

/**
 * A recording's hook that learns, before an answer is written, what in it the host is about to
 * hold: a sign-in's id and code from the start, and every credential the account's server list
 * carries, a player's or an unreadable server's included. So neither fixture, nor any after it, holds one.
 */
export function learningHostSecrets(service, secrets) {
  const start = beginRequest(service, '');
  const discovery = discoverRequest(service, '', '');
  return (request, answer) => {
    if (request.method === start.method && request.url === start.url) {
      const read = readBegin(service, answer.status, bodyText(answer));
      if (read.refused) return;
      secrets.add(read.code.id, PLACEHOLDERS.pin, { hostOwn: true });
      secrets.add(read.code.userCode, PLACEHOLDERS.pin, { hostOwn: true });
    }
    if (request.method === discovery.method && request.url === discovery.url) {
      for (const credential of credentialsListed(service, bodyText(answer))) {
        secrets.add(credential, PLACEHOLDERS.serverCredential);
      }
    }
  };
}
