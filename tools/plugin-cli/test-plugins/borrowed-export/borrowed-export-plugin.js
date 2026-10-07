/* yonto-plugin
{
  "kind": "content-source",
  "id": "borrowed-export",
  "name": "An export built by spreading another object",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": [
    "h.tv"
  ]
}
*/
// The methods are real and the scan cannot enumerate them: `base` is assembled somewhere
// this does not follow, so reading the literal alone would miss everything it brought.
// That is blindness, and the one case the required-export check must only warn about.
const base = ['getCategories', 'getMediaList', 'getMediaDetail', 'search']
  .reduce((all, name) => ({ ...all, [name]: async () => [] }), {});

export default {
  ...base,
};
