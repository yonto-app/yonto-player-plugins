// cheerio/slim's entity decoder falls back to Buffer when atob is missing, and neither
// exists in the realm. Defined here in the bundle's own scope rather than on the realm:
// the decoder closes over this one, and a plugin never sees a name it did not declare.
var atob = (input) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const text = String(input).replace(/=+$/, '');
  let bits = 0;
  let accumulator = 0;
  let out = '';
  for (const character of text) {
    const value = alphabet.indexOf(character);
    if (value === -1) continue;
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((accumulator >> bits) & 0xff);
    }
  }
  return out;
};
