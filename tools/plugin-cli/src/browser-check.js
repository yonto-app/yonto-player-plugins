import { Code, PluginError } from './errors.js';
import { cookieLoginOf } from './host/credential.js';
import { isPrivate } from './host/redirect.js';
import { carriesCredentials } from './host/request-shape.js';
import { hostAllowed, hostOf } from './hostname.js';

/**
 * Where a plugin may send a viewer to pass a site's browser check, and whether one it asked
 * for is admitted — docs/design/2026-09-23-a-challenge-the-viewer-clears.md.
 *
 * `core/src/androidMain/.../BrowserChecks.kt` is the same rule on a television, and
 * `conformance/browser-checks.json` holds the two to one answer.
 */

export const BROWSER_CHECK = 'browserCheck';

/** The one scheme a check may be at: a clearance on the wire is a clearance given away. */
const HTTPS = 'https:';

/**
 * The checks this plugin declares, read as a television reads them: a `url` form naming a
 * site, or the `fromConfig` form on a plugin whose hosts come from its config. Anything else
 * is no check at all, and `lint` refuses it before it could get that far.
 */
export function browserChecksOf(manifest) {
  return (manifest?.capabilities ?? []).filter((capability) => {
    if (capability?.type !== BROWSER_CHECK) return false;
    if (capability.fromConfig === true) return !capability.url && manifest.hostsFromConfig === true;
    return siteOf(capability.url) !== null;
  });
}

/**
 * `https://host` for [url]: its scheme and its host as every gate reads one, or null. Any port
 * on the host is the same site, as a browser scopes a cookie. An IPv6 host is bracketed, so
 * the string reads back to the same site: a clearance is stored by it and compared by it.
 */
export function siteOf(url) {
  const host = hostOf(url);
  if (host === null) return null;
  try {
    return `${new URL(String(url).trim()).protocol}//${host.includes(':') ? `[${host}]` : host}`;
  } catch {
    return null;
  }
}

/**
 * Why the check a plugin raised at [url] is not offered to the viewer, or null when it is.
 * [reached] is every site the call's `yonto.fetch` reached, on any hop.
 *
 * Worded exactly as `BrowserChecks.refusal`, because a refusal is printed by `run` and
 * `doctor` and logged by a television, and `conformance/browser-checks.json` compares them.
 */
export function challengeRefusal(manifest, url, reached) {
  const site = siteOf(url);
  if (site === null) return 'it is not a URL';
  // What `yonto.fetch` refuses to send, and a browser would open as a sign-in to a site the
  // viewer is told is somewhere else.
  if (carriesCredentials(String(url).trim())) return 'it carries a user name or password';
  if (!site.startsWith(`${HTTPS}//`)) return 'it is not https';
  if (isPrivate(hostOf(url))) return 'it is a private address';
  if (!covers(manifest, site)) return 'no browserCheck in the manifest covers it';
  if (!clearsAt(manifest, site)) return "it is the site of the plugin's cookieLogin";
  if (!reached.has(site)) return 'yonto.fetch did not reach it in this call';
  return null;
}

/**
 * Whether a check at [site] (`https://host`) may be offered and what it wins held and sent
 * there: a public https site, a browserCheck covers it, and it is not the site of the plugin's
 * cookieLogin. The one gate, as `BrowserChecks.clearsAt` is on a television: `challengeRefusal`
 * asks it, and `yonto.fetch` asks it on every hop before attaching a held clearance, so a
 * fromConfig check, which covers any site, still never clears one over http or on the
 * viewer's own network.
 */
export function clearsAt(manifest, site) {
  if (!String(site).startsWith(`${HTTPS}//`) || isPrivate(hostOf(site))) return false;
  const login = cookieLoginOf(manifest);
  return covers(manifest, site) && (login === null || siteOf(login.url) !== site);
}

function covers(manifest, site) {
  return browserChecksOf(manifest).some((check) => check.fromConfig === true || siteOf(check.url) === site);
}

/**
 * What `lint` refuses in a manifest's browser checks, beyond what the schema already does
 * (one of `url` and `fromConfig`, `https`, no `cookieName`).
 */
export function browserCheckRefusals(manifest) {
  const checks = (manifest?.capabilities ?? []).filter((capability) => capability?.type === BROWSER_CHECK);
  const refusals = [];
  const fromConfig = checks.filter((check) => check.fromConfig === true);
  if (fromConfig.length > 0 && manifest.hostsFromConfig !== true) {
    refusals.push('a fromConfig browserCheck is for a plugin whose hosts come from its config, and this ' +
      'manifest does not declare hostsFromConfig — name the site with url instead');
  }
  if (fromConfig.length > 0 && checks.length > 1) {
    refusals.push('a fromConfig browserCheck already covers every public https site, so it stands alone: ' +
      'drop the others');
  }
  const loginSite = siteOf(cookieLoginOf(manifest)?.url);
  const seen = new Set();
  for (const check of checks.filter((c) => c.fromConfig !== true)) {
    const site = siteOf(check.url);
    if (site === null) continue;
    const host = hostOf(check.url);
    if (isPrivate(host)) {
      refusals.push(`browserCheck at ${check.url} is on the viewer's own network, and a check there is not ` +
        'a thing a site asks for — a television refuses to open one');
    }
    if (manifest.hostsFromConfig !== true && !hostAllowed(host, manifest.allowedHosts ?? [])) {
      refusals.push(`browserCheck at ${check.url} names ${host}, which allowedHosts does not admit, so ` +
        'nothing this plugin fetches could ever be challenged there');
    }
    if (site === loginSite) {
      refusals.push(`browserCheck at ${check.url} is the site of this plugin's cookieLogin, and two ` +
        'host-held credentials on one site would need a merge rule nothing has been tested against');
    }
    if (seen.has(site)) refusals.push(`browserCheck names ${site} twice`);
    seen.add(site);
  }
  return refusals;
}

/**
 * Whether a plugin raises a challenge it has no browserCheck for, which on a television is
 * always *unavailable*. A warning, not a refusal: the URL a plugin raises at is only known when
 * it runs, and a `fromConfig` plugin may raise at a site `lint` could never see.
 */
export function raisesUndeclaredChallenge(sources, manifest) {
  if (browserChecksOf(manifest).length > 0) return false;
  return Object.values(sources).some((text) => /yonto\.error\.challenged\b|['"]CHALLENGED['"]/.test(text));
}

/**
 * [transport], noting every site that answered with Cloudflare's `cf-mitigated: challenge`,
 * for `doctor` to say whether the plugin covered it — the case most likely to be mis-mapped,
 * since the contract taught every plugin to call a `403` unauthenticated.
 */
export function noticingChallenges(transport, challenged) {
  return {
    ...transport,
    async request(request) {
      const response = await transport.request(request);
      const mitigated = Object.entries(response.headers ?? {})
        .find(([name]) => name.toLowerCase() === 'cf-mitigated')?.[1];
      if (String(mitigated ?? '').toLowerCase() === 'challenge') challenged.add(request.url);
      return response;
    },
  };
}

/**
 * [engine], with a plugin's `CHALLENGED` said the way a television would take it: offered to
 * the viewer as a browser check, or reported as unavailable and why. There is no browser here,
 * so either way it is a failed step.
 *
 * The sites a call reached are read off [requests] since the call began, which is this host's
 * record of every hop `yonto.fetch` sent.
 */
export function challengeAware(engine, manifest, requests) {
  return {
    ...engine,
    async call(method, args) {
      const before = requests.length;
      try {
        return await engine.call(method, args);
      } catch (error) {
        if (error?.code !== Code.CHALLENGED) throw error;
        const reached = new Set(requests.slice(before).filter((r) => r.status !== null).map((r) => siteOf(r.url)));
        const url = error.message;
        const refusal = challengeRefusal(manifest, url, reached);
        throw new PluginError(Code.CHALLENGED, refusal === null
          ? `at ${url}: a television offers the viewer a browser check here`
          : `at ${url}, which ${refusal}; a television reports it as unavailable`,
        { url, refusal });
      }
    },
  };
}

/**
 * A line for each site that answered with `cf-mitigated: challenge`: whether a browserCheck
 * covers it, and whether the plugin raised CHALLENGED for it or mapped it to something else.
 */
export function challengeHints(manifest, report, challenged) {
  const raised = new Set((report.steps ?? [])
    .filter((step) => step.code === Code.CHALLENGED)
    .map((step) => siteOf(step.detail?.url)));
  return [...new Set([...challenged].map(siteOf))].filter((site) => site !== null).map((site) => {
    const covered = challengeRefusal(manifest, site, new Set([site])) === null;
    return `⚠ challenge         ${site} answered with cf-mitigated: challenge — ` +
      `${covered ? 'a browserCheck covers it' : 'no browserCheck covers it'}, and the plugin ` +
      `${raised.has(site) ? 'raised CHALLENGED' : 'did not raise CHALLENGED for it'}`;
  });
}
