/* yonto-plugin
{
  "kind": "content-source",
  "id": "video-blog",
  "name": "Video blog",
  "version": "1.0.0",
  "contractVersion": 21,
  "description": "A video blog, read from its RSS feed: every post with a video attached becomes a title.",
  "probeQuery": "starter",
  "provides": "source-type",
  "allowedHosts": [],
  "configSchema": [
    { "id": "feedUrl", "label": "Feed URL", "type": "url", "required": true }
  ]
}
*/
const FEED_TTL_SECONDS = 300;

async function readPosts() {
  const cacheKey = `feed:${yonto.config.feedUrl}`;
  const cached = await yonto.store.get(cacheKey);
  if (cached) return cached;

  let response;
  try {
    response = await yonto.fetch(yonto.config.feedUrl);
  } catch (error) {
    yonto.log(`feed request failed: ${error.code}`);
    throw yonto.error.unreachable('the feed did not answer');
  }
  if (response.status !== 200) throw yonto.error.unavailable(`the feed answered ${response.status}`);

  const $ = yonto.xml.load(response.body);
  if ($('rss > channel').length === 0) throw yonto.error.unavailable('the address is not an RSS feed');

  const posts = $('item')
    .toArray()
    .map((item) => postFrom($(item)))
    .filter((post) => post.videoUrl);
  try {
    await yonto.store.set(cacheKey, posts, FEED_TTL_SECONDS);
  } catch (error) {
    yonto.log(`feed not cached: ${error.code}`);
  }
  return posts;
}

function postFrom(item) {
  const enclosure = item.find('enclosure');
  const isVideo = (enclosure.attr('type') ?? '').startsWith('video/');
  return {
    id: item.find('guid').text().trim() || item.find('link').text().trim(),
    title: item.find('title').text().trim(),
    synopsis: item.find('description').text().trim(),
    year: (item.find('pubDate').text().match(/\d{4}/) ?? [])[0],
    posterUrl: item.find('media\\:thumbnail').attr('url'),
    videoUrl: isVideo ? enclosure.attr('url') : undefined,
    mimeType: isVideo ? enclosure.attr('type') : undefined,
  };
}

const summaryOf = ({ id, title, posterUrl, year }) => ({ id, title, posterUrl, year, type: 'movie' });

export default {
  async getCategories() {
    return [{ id: 'latest', name: 'Latest' }];
  },

  async getMediaList(categoryId, { page }) {
    if (page > 1) return [];
    return (await readPosts()).map(summaryOf);
  },

  async getMediaDetail(id) {
    const post = (await readPosts()).find((candidate) => candidate.id === id);
    if (!post) throw yonto.error.notFound(`no post ${id}`);
    return {
      ...summaryOf(post),
      synopsis: post.synopsis,
      playbackOptions: [{ label: 'Watch', stream: { url: post.videoUrl, mimeType: post.mimeType } }],
    };
  },

  async search(query) {
    const needle = query.toLowerCase();
    const posts = await readPosts();
    return posts
      .filter((post) => `${post.title} ${post.synopsis}`.toLowerCase().includes(needle))
      .map(summaryOf);
  },
};
