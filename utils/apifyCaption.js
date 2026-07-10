const axios = require('axios');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getApifyToken() {
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    throw new Error('APIFY_TOKEN is not configured on the server');
  }
  return token;
}

function isFacebookUrl(url) {
  const normalized = url.toLowerCase();
  return normalized.includes('facebook.com') || normalized.includes('fb.watch') || normalized.includes('fb.com');
}

async function waitForApifyRun(actorPath, runId, token) {
  let status = 'RUNNING';
  let attempts = 0;
  const maxAttempts = 30;

  while (status === 'RUNNING' && attempts < maxAttempts) {
    await sleep(3000);
    const statusResponse = await axios.get(`https://api.apify.com/v2/acts/${actorPath}/runs/${runId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    status = statusResponse.data.data.status;
    attempts += 1;
  }

  if (status !== 'SUCCEEDED') {
    throw new Error(`Apify run did not succeed. Status: ${status}`);
  }
}

async function fetchApifyDataset(datasetId, token) {
  const resultsResponse = await axios.get(`https://api.apify.com/v2/datasets/${datasetId}/items`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return resultsResponse.data;
}

async function extractInstagramWithApify(url, token) {
  const runResponse = await axios.post(
    'https://api.apify.com/v2/acts/apify~instagram-scraper/runs',
    {
      directUrls: [url],
      resultsType: 'posts',
      resultsLimit: 1,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      timeout: 90000,
    }
  );

  const runId = runResponse.data.data.id;
  const datasetId = runResponse.data.data.defaultDatasetId;
  await waitForApifyRun('apify~instagram-scraper', runId, token);
  const items = await fetchApifyDataset(datasetId, token);

  if (!items?.length) {
    throw new Error('No data returned from Apify');
  }

  const post = items[0];
  let combinedText = '';

  if (post.caption?.trim()) combinedText += `${post.caption}\n\n`;
  if (post.alt?.trim()) combinedText += `${post.alt}\n`;
  if (post.hashtags?.length) combinedText += `\nHashtags: ${post.hashtags.join(' ')}\n`;

  if (!combinedText.trim()) {
    throw new Error('No workout text found in post (no caption, no image text)');
  }

  return {
    text: combinedText.trim(),
    displayUrl: post.displayUrl,
    hashtags: post.hashtags || [],
    url: post.url || url,
    source: 'Instagram',
    type: post.type,
    videoUrl: post.videoUrl,
    childPosts: post.childPosts,
  };
}

async function extractTikTokWithApify(url, token) {
  const runResponse = await axios.post(
    'https://api.apify.com/v2/acts/clockworks~tiktok-scraper/runs',
    {
      postURLs: [url],
      resultsPerPage: 1,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      timeout: 90000,
    }
  );

  const runId = runResponse.data.data.id;
  const datasetId = runResponse.data.data.defaultDatasetId;
  await waitForApifyRun('clockworks~tiktok-scraper', runId, token);
  const items = await fetchApifyDataset(datasetId, token);

  if (!items?.length) {
    throw new Error('No data returned from Apify');
  }

  const post = items[0];
  const text = post.text || post.desc || post.description || '';
  if (!text.trim()) {
    throw new Error('No caption found in TikTok post');
  }

  return {
    text: text.trim(),
    displayUrl: post.coverUrl || post.videoMeta?.coverUrl || post.authorMeta?.avatar,
    hashtags: post.hashtags?.map((tag) => (typeof tag === 'string' ? tag : tag?.name)).filter(Boolean) || [],
    url: post.webVideoUrl || post.url || url,
    source: 'TikTok',
    type: 'Video',
    videoUrl: post.videoUrl || post.videoMeta?.downloadAddr || post.downloadAddr,
    childPosts: post.slideshowImages?.length
      ? post.slideshowImages.map((image) => ({ displayUrl: image, videoUrl: undefined }))
      : undefined,
  };
}

async function extractFacebookWithApify(url, token) {
  const runResponse = await axios.post(
    'https://api.apify.com/v2/acts/apify~facebook-posts-scraper/runs',
    {
      startUrls: [{ url }],
      resultsLimit: 1,
      captionText: true,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      timeout: 90000,
    }
  );

  const runId = runResponse.data.data.id;
  const datasetId = runResponse.data.data.defaultDatasetId;
  await waitForApifyRun('apify~facebook-posts-scraper', runId, token);
  const items = await fetchApifyDataset(datasetId, token);

  if (!items?.length) {
    throw new Error('No data returned from Apify');
  }

  const post = items[0];
  const textParts = [
    post.text,
    post.message,
    post.caption,
    post.postText,
    post.description,
  ].filter((part) => typeof part === 'string' && part.trim().length > 0);

  const text = textParts.join('\n\n').trim();
  if (!text) {
    throw new Error('No caption found in Facebook post');
  }

  return {
    text,
    displayUrl: post.imageUrl || post.thumbnailUrl || post.displayUrl,
    hashtags: [],
    url: post.url || url,
    source: 'Facebook',
    type: post.type,
    videoUrl: post.videoUrl || post.playable_url,
    childPosts: post.childPosts,
  };
}

async function extractCaption(url) {
  const token = getApifyToken();

  if (url.includes('instagram.com')) {
    return extractInstagramWithApify(url, token);
  }
  if (url.includes('tiktok.com')) {
    return extractTikTokWithApify(url, token);
  }
  if (isFacebookUrl(url)) {
    return extractFacebookWithApify(url, token);
  }

  throw new Error('Unsupported platform for automatic caption extraction');
}

module.exports = {
  extractCaption,
  isFacebookUrl,
};
