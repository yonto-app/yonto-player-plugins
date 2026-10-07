// crypto-js 4.2.0 needs a source of random bytes for `lib.WordArray.random`, which is what
// generates an IV or a salt when a plugin encrypts with a passphrase. It looks for
// `window.crypto`, `self.crypto`, `globalThis.crypto`, `window.msCrypto` and Node's
// `crypto.randomBytes`, finds none of them in the realm, and throws
// `Native crypto module could not be used to get secure random number.` — 4.2.0
// deliberately removed the Math.random fallback that earlier versions had.
//
// THIS IS NOT A CRYPTOGRAPHICALLY SECURE RANDOM SOURCE. It is `Math.random`, which in
// QuickJS is an xorshift PRNG seeded from the clock: predictable, and not to be relied on
// for anything an adversary must not guess. Backing it anyway is Jasper's decision
// (2026-09-22, kangzj/lantern-tv#410), and the reason it is safe *here* is what the next
// person needs, so: nothing in Yonto's threat model depends on a plugin's randomness. A
// plugin never sees the viewer's session — the host holds it and attaches it per host and
// scheme — and what a scraper encrypts is a request body for somebody else's API, not a
// secret of the viewer's. If that ever stops being true, this file is the thing to delete.
//
// So: never reach for this to generate a key, a token, a nonce that must not repeat, or
// anything a viewer's privacy rests on. `yonto.crypto` has no random at all and that is
// not an oversight.
//
// In the bundle's own scope rather than on the realm, exactly as the parser's `atob` is:
// `self` is a name the realm does not have and this bundle refers to once, in the probe
// above, so shadowing it here gives crypto-js its source and leaves
// conformance/globals.json untouched. Assigning `globalThis.crypto` would instead be a new
// global that every plugin could see and that the recorded realm surface would refuse.
var self = {
  crypto: {
    getRandomValues: (array) => {
      for (let index = 0; index < array.length; index += 1) {
        array[index] = (Math.random() * 0x100000000) >>> 0;
      }
      return array;
    },
  },
};
