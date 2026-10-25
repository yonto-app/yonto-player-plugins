import { hostAllowed, hostOf } from './hostname.js';

/**
 * Which of a stream's subtitles an app keeps: those on the stream URL's own host or a host the
 * manifest's `allowedHosts` names. The device applies the same rule
 * (`conformance/subtitle-hosts.json`), so `doctor` can say what it will drop.
 */
export function subtitlesKept(stream, allowedHosts) {
  const streamHost = hostOf(stream.url);
  return (stream.subtitles ?? []).filter((subtitle) => {
    const host = hostOf(subtitle.url);
    return host !== null && (host === streamHost || hostAllowed(host, allowedHosts));
  });
}
