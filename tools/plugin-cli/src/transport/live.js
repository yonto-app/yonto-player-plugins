import { lookup as systemLookup } from 'node:dns';
import { Agent, fetch } from 'undici';
import { Code, PluginError } from '../errors.js';
import { LIMITS, RESPONSE_BODY_BYTES } from '../host/fetch.js';

/** One request's timeouts, a television's (`NetworkModule`): connecting, a silence while reading, and the whole request. */
export const REQUEST_LIMITS = Object.freeze({
  connectTimeoutMs: LIMITS.requestConnectTimeoutMs,
  readTimeoutMs: LIMITS.requestReadTimeoutMs,
  timeoutMs: LIMITS.requestTimeoutMs,
});

/**
 * [resolve] is `dns.lookup`'s shape: the transport's resolver, injectable so a test can
 * point a name wherever it needs to without a DNS server. The connect timeout covers the TLS
 * handshake too, as OkHttp's does, and the read timeout is a silence while reading, headers
 * or body.
 */
export function createLiveTransport({
  connectTimeoutMs = REQUEST_LIMITS.connectTimeoutMs,
  readTimeoutMs = REQUEST_LIMITS.readTimeoutMs,
  timeoutMs = REQUEST_LIMITS.timeoutMs,
  resolve = systemLookup,
} = {}) {
  const agent = new Agent({
    connect: { lookup: resolve, timeout: connectTimeoutMs },
    headersTimeout: readTimeoutMs,
    bodyTimeout: readTimeoutMs,
  });
  return {
    limits: { connectTimeoutMs, readTimeoutMs, timeoutMs },
    async request({ method, url, headers, body, signal }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
      // The call's own signal too, which the host aborts when the call ends.
      const aborted = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
      try {
        // Never followed here: the host does it, so the allowlist is checked at every hop.
        const response = await fetch(url, {
          method, headers, body, redirect: 'manual', signal: aborted,
          dispatcher: agent,
        });
        const bytes = await readUpTo(response.body, RESPONSE_BODY_BYTES + 1);
        return {
          status: response.status,
          headers: Object.fromEntries(response.headers),
          setCookie: response.headers.getSetCookie(),
          bodyBase64: bytes.toString('base64'),
        };
      } catch (cause) {
        const timedOut = controller.signal.aborted && !signal?.aborted;
        throw new PluginError(Code.REQUEST_FAILED, unanswered(new URL(url).hostname, cause, timedOut), { url, cause });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Read as it arrives, so a body far past what the host will hand over is never buffered whole. */
async function readUpTo(stream, maxBytes) {
  if (!stream) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  const reader = stream.getReader();
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, maxBytes);
}

const UNTRUSTED = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_UNTRUSTED', 'CERT_SIGNATURE_FAILURE', 'CERT_NOT_YET_VALID',
]);
const TIMED_OUT = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

/**
 * Why [host] gave no answer, in the host's words rather than Node's, the same sentences the
 * device says (`YontoHostApi.unanswered`, kangzj/yonto#645). undici's fetch says only
 * `fetch failed` and keeps the code further down its `cause`s.
 */
export function unanswered(host, error, timedOut = false) {
  const codes = [];
  for (let e = error; e; e = e.cause) if (e.code) codes.push(e.code);
  if (codes.includes('CERT_HAS_EXPIRED')) return `${host}'s certificate has expired`;
  if (codes.some((code) => UNTRUSTED.has(code))) return `${host}'s certificate isn't trusted`;
  if (codes.includes('ENOTFOUND') || codes.includes('EAI_AGAIN')) return `${host} could not be found`;
  if (codes.includes('ECONNREFUSED')) return `${host} refused the connection`;
  if (timedOut || codes.some((code) => TIMED_OUT.has(code))) return `${host} did not answer in time`;
  return `${host} could not be reached`;
}
