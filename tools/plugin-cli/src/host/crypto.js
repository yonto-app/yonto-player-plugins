import { createHash, createHmac, createDecipheriv } from 'node:crypto';
import { HostRefusal } from '../errors.js';

const AES_BLOCK_BYTES = 16;

const digest = (algorithm) => (input) =>
  createHash(algorithm).update(Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8')).digest('hex');

export const crypto = {
  md5: digest('md5'),
  sha1: digest('sha1'),
  sha256: digest('sha256'),
  hmacSha256(keyBase64, message) {
    return createHmac('sha256', Buffer.from(keyBase64, 'base64')).update(message, 'utf8').digest('hex');
  },
  // Key length picks the variant, exactly as a 仓 config's own decoder does. Each refusal is
  // the device's sentence, where Node's own would name OpenSSL's reason codes.
  aesCbcDecrypt(keyBase64, ivBase64, dataBase64, { padding = true } = {}) {
    const key = Buffer.from(keyBase64, 'base64');
    const algorithm = { 16: 'aes-128-cbc', 24: 'aes-192-cbc', 32: 'aes-256-cbc' }[key.length];
    if (!algorithm) throw new HostRefusal(`aesCbcDecrypt: a key must be 16, 24 or 32 bytes, got ${key.length}`);
    const iv = Buffer.from(ivBase64, 'base64');
    if (iv.length !== AES_BLOCK_BYTES) throw new HostRefusal(`aesCbcDecrypt: an iv must be ${AES_BLOCK_BYTES} bytes, got ${iv.length}`);
    const data = Buffer.from(dataBase64, 'base64');
    if (data.length % AES_BLOCK_BYTES !== 0) {
      throw new HostRefusal(`aesCbcDecrypt: the data must be whole ${AES_BLOCK_BYTES}-byte blocks, got ${data.length} bytes`);
    }
    const decipher = createDecipheriv(algorithm, key, iv);
    decipher.setAutoPadding(padding);
    const plain = decipher.update(data);
    try {
      return Buffer.concat([plain, decipher.final()]).toString('utf8');
    } catch {
      throw new HostRefusal('aesCbcDecrypt: the padding is wrong, which usually means the wrong key or iv');
    }
  },
};

// Hex that is not hex is refused rather than guessed at. Node truncates —
// `Buffer.from('abc', 'hex')` is one byte and `Buffer.from('zz', 'hex')` is none, both
// silently — and a plugin gets a wrong answer with no signal. Unlike base64 there is no
// legitimate malformed spelling to be lenient about, so both hosts refuse in the same
// words (kangzj/lantern-tv#329).
function hexBytes(hex) {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new HostRefusal('not hex: an even number of 0-9a-f is needed');
  }
  return Buffer.from(hex, 'hex');
}

export const encoding = {
  base64Encode: (text) => Buffer.from(text, 'utf8').toString('base64'),
  // Node already accepts the URL-safe alphabet, embedded whitespace and missing padding.
  // The device did not, which is what #329 was about; it does now, so these agree.
  base64Decode: (base64) => Buffer.from(base64, 'base64').toString('utf8'),
  hexToBase64: (hex) => hexBytes(hex).toString('base64'),
  base64ToHex: (base64) => Buffer.from(base64, 'base64').toString('hex'),
};
