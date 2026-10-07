/* yonto-plugin
{
  "kind": "content-source",
  "id": "fetch-body",
  "name": "Fetch body",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source-type",
  "allowedHosts": ["body.test"]
}
*/
// Not a content source: the plugin `calls.json` is walked through, one runtime for every call,
// so a response kept by one call can be read by the next. A refusal is caught and handed back
// as [code, message], so both hosts are compared on what a plugin reads.
let kept = null;

const refusal = (error) => [error.code ?? null, error.message];

export default {
  async getCategories() { return [{ id: 'a', name: 'A' }]; },
  async readTwice() {
    const gbk = await yonto.fetch('https://body.test/gbk');
    const other = await yonto.fetch('https://body.test/other');
    return [
      yonto.text.decode(gbk.bodyBase64, 'gbk'),
      gbk.bodyBase64 === gbk.bodyBase64,
      yonto.text.decode(other.bodyBase64),
    ];
  },
  async keys() { return Object.keys(await yonto.fetch('https://body.test/other')); },
  async copied() {
    const response = await yonto.fetch('https://body.test/other');
    return [JSON.parse(JSON.stringify(response)).bodyBase64, { ...response }.bodyBase64];
  },
  async replaced() {
    const response = await yonto.fetch('https://body.test/other');
    response.bodyBase64 = 'replaced';
    const said = response.bodyBase64;
    return [said, delete response.bodyBase64, 'bodyBase64' in response];
  },
  async keep() {
    kept = await yonto.fetch('https://body.test/other');
    return null;
  },
  async readKept() {
    try {
      return kept.bodyBase64;
    } catch (error) {
      return refusal(error);
    }
  },
  async codes(url) {
    const response = await yonto.fetch(url);
    return [Array.from(response.body, (c) => c.charCodeAt(0)), response.bodyBase64];
  },
  async manyUnread(url, count) {
    const responses = [];
    for (let i = 0; i < count; i += 1) {
      const response = await yonto.fetch(url);
      delete response.body;
      responses.push(response);
    }
    // One at a time and let go, so the realm holds one read body rather than every one.
    const lengths = [];
    while (responses.length > 0) {
      const response = responses.shift();
      try {
        lengths.push(response.bodyBase64.length);
      } catch (error) {
        lengths.push(refusal(error));
      }
    }
    return lengths;
  },
  async readThenMore(url) {
    const lengths = [];
    const fetchAndRead = async (count) => {
      const responses = [];
      for (let i = 0; i < count; i += 1) {
        const response = await yonto.fetch(url);
        delete response.body;
        responses.push(response);
      }
      while (responses.length > 0) lengths.push(responses.shift().bodyBase64.length);
    };
    await fetchAndRead(4);
    await fetchAndRead(2);
    return lengths;
  },
  async bothLengths(url) {
    const response = await yonto.fetch(url);
    return [response.body.length, response.bodyBase64.length];
  },
  async bodyLength(url) {
    try {
      return (await yonto.fetch(url)).body.length;
    } catch (error) {
      return refusal(error);
    }
  },
};
