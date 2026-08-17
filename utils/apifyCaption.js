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

async function waitForApifyRun(actorPath, runId, token, maxAttempts = 30) {
  let status = 'RUNNING';
  let attempts = 0;

  while ((status === 'RUNNING' || status === 'READY') && attempts < maxAttempts) {
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

function isTikTokPageUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const lower = value.toLowerCase();
  return (
    (lower.includes('tiktok.com/') || lower.includes('vm.tiktok.com') || lower.includes('vt.tiktok.com')) &&
    !lower.includes('.mp4') &&
    !lower.includes('tiktokcdn')
  );
}

function isLikelyDirectVideoUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const lower = value.toLowerCase();
  return (
    lower.includes('.mp4') ||
    lower.includes('tiktokcdn') ||
    lower.includes('apify') ||
    lower.includes('byteoversea') ||
    lower.includes('muscdn') ||
    lower.includes('/media/') ||
    lower.includes('video_mp4')
  );
}

/** Prefer Apify-downloaded / CDN MP4 links over TikTok page URLs. */
function pickTikTokVideoUrl(post) {
  const mediaUrls = Array.isArray(post?.mediaUrls) ? post.mediaUrls : [];
  const candidates = [
    ...mediaUrls,
    post?.videoUrl,
    post?.downloadUrl,
    post?.downloadedVideoUrl,
    post?.videoMeta?.downloadAddr,
    post?.videoMeta?.playAddr,
    post?.video?.downloadAddr,
    post?.video?.playAddr,
    post?.downloadAddr,
    post?.playAddr,
  ].filter((url) => typeof url === 'string' && url.trim().length > 0);

  const direct = candidates.find((url) => isLikelyDirectVideoUrl(url) && !isTikTokPageUrl(url));
  if (direct) return direct;

  const nonPage = candidates.find((url) => !isTikTokPageUrl(url));
  return nonPage || undefined;
}

function normalizeTikTokHashtags(hashtags) {
  if (!Array.isArray(hashtags)) return [];
  return hashtags
    .map((tag) => {
      if (typeof tag === 'string') return tag.startsWith('#') ? tag : `#${tag}`;
      if (tag?.name) return tag.name.startsWith('#') ? tag.name : `#${tag.name}`;
      return null;
    })
    .filter(Boolean);
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
  // shouldDownloadVideos fills mediaUrls with playable CDN/Apify links.
  // Without it, videoUrl is often missing and TikTok page HTML scrape fails.
  const runResponse = await axios.post(
    'https://api.apify.com/v2/acts/clockworks~tiktok-scraper/runs',
    {
      postURLs: [url],
      resultsPerPage: 1,
      scrapeRelatedVideos: false,
      shouldDownloadVideos: true,
      shouldDownloadCovers: true,
      shouldDownloadSlideshowImages: true,
      shouldDownloadSubtitles: false,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      timeout: 120000,
    }
  );

  const runId = runResponse.data.data.id;
  const datasetId = runResponse.data.data.defaultDatasetId;
  // Video download add-on can take longer than metadata-only scrapes
  await waitForApifyRun('clockworks~tiktok-scraper', runId, token, 60);
  const items = await fetchApifyDataset(datasetId, token);

  if (!items?.length) {
    throw new Error('No data returned from Apify');
  }

  const post = items[0];
  const hashtags = normalizeTikTokHashtags(post.hashtags);
  const textParts = [
    post.text,
    post.desc,
    post.description,
    post.subtitle,
    post.transcript,
    post.videoMeta?.subtitle,
  ].filter((part) => typeof part === 'string' && part.trim().length > 0);

  let combinedText = textParts.join('\n\n').trim();
  if (hashtags.length) {
    combinedText = `${combinedText}${combinedText ? '\n\n' : ''}Hashtags: ${hashtags.join(' ')}`;
  }

  const videoUrl = pickTikTokVideoUrl(post);
  const slideshowImages = Array.isArray(post.slideshowImages)
    ? post.slideshowImages
    : Array.isArray(post.images)
      ? post.images
      : [];

  // Many TikTok workouts put exercises in the video, not the caption.
  // Keep a stub caption so the client can still run frame extraction when video exists.
  if (!combinedText.trim()) {
    if (videoUrl || slideshowImages.length > 0) {
      combinedText = 'TikTok workout video';
    } else {
      throw new Error('No caption or video found in TikTok post');
    }
  }

  console.log('🎵 TikTok Apify extract:', {
    hasText: combinedText.length > 0,
    textLength: combinedText.length,
    hasVideoUrl: Boolean(videoUrl),
    mediaUrlsCount: Array.isArray(post.mediaUrls) ? post.mediaUrls.length : 0,
    slideshowCount: slideshowImages.length,
    videoUrlPreview: videoUrl ? String(videoUrl).slice(0, 120) : null,
  });

  return {
    text: combinedText.trim(),
    displayUrl:
      post.coverUrl ||
      post.videoMeta?.coverUrl ||
      post.videoMeta?.originalCoverUrl ||
      post.covers?.[0] ||
      post.authorMeta?.avatar,
    hashtags,
    url: post.webVideoUrl || post.url || url,
    source: 'TikTok',
    type: videoUrl ? 'Video' : slideshowImages.length ? 'Slideshow' : 'Video',
    videoUrl,
    childPosts: slideshowImages.length
      ? slideshowImages.map((image) => ({
          displayUrl: typeof image === 'string' ? image : image?.url || image?.displayUrl,
          videoUrl: undefined,
        }))
      : undefined,
  };
}

function isFacebookPageUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const lower = value.toLowerCase();
  return (
    (lower.includes('facebook.com/') || lower.includes('fb.watch') || lower.includes('fb.com/')) &&
    !lower.includes('.mp4') &&
    !lower.includes('fbcdn')
  );
}

function facebookMediaItems(post) {
  const items = [];
  if (Array.isArray(post?.media)) items.push(...post.media);
  if (Array.isArray(post?.attachments)) items.push(...post.attachments);
  if (Array.isArray(post?.childPosts)) items.push(...post.childPosts);
  if (post?.video && typeof post.video === 'object') items.push(post.video);
  return items.filter(Boolean);
}

function pickFacebookVideoUrl(post) {
  const candidates = [
    post?.videoUrl,
    post?.playable_url,
    post?.playableUrl,
    post?.downloadUrl,
    post?.browser_native_hd_url,
    post?.browser_native_sd_url,
    post?.hd_src,
    post?.sd_src,
    post?.video?.playable_url,
    post?.video?.browser_native_hd_url,
    post?.video?.browser_native_sd_url,
    post?.video?.uri,
  ];

  for (const item of facebookMediaItems(post)) {
    candidates.push(
      item.videoUrl,
      item.playable_url,
      item.playableUrl,
      item.browser_native_hd_url,
      item.browser_native_sd_url,
      item.video?.playable_url,
      item.video?.browser_native_hd_url,
      item.video?.browser_native_sd_url,
      item.video?.uri,
      item.videoDeliveryLegacyFields?.browser_native_hd_url,
      item.videoDeliveryLegacyFields?.browser_native_sd_url,
    );
  }

  const urls = candidates.filter((url) => typeof url === 'string' && url.trim().length > 0);
  const direct = urls.find((url) => {
    const lower = url.toLowerCase();
    return (
      !isFacebookPageUrl(url) &&
      (lower.includes('.mp4') || lower.includes('fbcdn') || lower.includes('video'))
    );
  });
  return direct || urls.find((url) => !isFacebookPageUrl(url));
}

function facebookImageUrls(post) {
  const urls = [
    post?.imageUrl,
    post?.thumbnailUrl,
    post?.displayUrl,
    post?.fullPicture,
    post?.picture,
  ];
  for (const item of facebookMediaItems(post)) {
    urls.push(
      item.photo_image?.uri,
      item.image?.uri,
      item.thumbnail,
      item.previewImage,
      item.imageUrl,
      item.fullPicture,
    );
  }
  return [...new Set(urls.filter((url) => typeof url === 'string' && url.trim() && !isFacebookPageUrl(url)))];
}

function facebookOcrText(post) {
  return facebookMediaItems(post)
    .map((item) => item?.ocrText || item?.ocr_text || item?.alt || item?.accessibilityCaption)
    .filter((part) => typeof part === 'string' && part.trim().length > 0);
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
    post.title,
    post.captionText,
    post.transcript,
    post.videoTranscript,
    post.video_transcript,
    ...facebookOcrText(post),
  ].filter((part) => typeof part === 'string' && part.trim().length > 0);

  let text = textParts.join('\n\n').trim();
  const videoUrl = pickFacebookVideoUrl(post);
  const imageUrls = facebookImageUrls(post);
  const childPosts = Array.isArray(post.childPosts) && post.childPosts.length
    ? post.childPosts
    : imageUrls.slice(1).map((displayUrl) => ({ displayUrl }));

  // Workout details are often in the video/image, not the caption.
  if (!text) {
    if (videoUrl || imageUrls.length > 0) {
      text = 'Facebook workout video';
    } else {
      throw new Error('No caption or video found in Facebook post');
    }
  }

  console.log('📘 Facebook Apify extract:', {
    hasText: text.length > 0,
    textLength: text.length,
    hasVideoUrl: Boolean(videoUrl),
    imageCount: imageUrls.length,
    videoUrlPreview: videoUrl ? String(videoUrl).slice(0, 120) : null,
  });

  return {
    text,
    displayUrl: imageUrls[0] || post.imageUrl || post.thumbnailUrl || post.displayUrl,
    hashtags: Array.isArray(post.hashtags) ? post.hashtags : [],
    url: post.url || post.postUrl || url,
    source: 'Facebook',
    type: post.type || (videoUrl ? 'Video' : 'Post'),
    videoUrl,
    childPosts: childPosts.length ? childPosts : undefined,
  };
}

function isTikTokUrl(url) {
  const normalized = String(url || '').toLowerCase();
  return (
    normalized.includes('tiktok.com') ||
    normalized.includes('vm.tiktok.com') ||
    normalized.includes('vt.tiktok.com')
  );
}

async function extractCaption(url) {
  const token = getApifyToken();

  if (url.includes('instagram.com')) {
    return extractInstagramWithApify(url, token);
  }
  if (isTikTokUrl(url)) {
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
