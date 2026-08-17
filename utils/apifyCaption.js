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

function normalizeHashtagList(hashtags) {
  if (!Array.isArray(hashtags)) return [];
  return [...new Set(
    hashtags
      .map((tag) => {
        if (typeof tag === 'string') {
          const value = tag.trim();
          if (!value || value === '[object Object]') return null;
          return value.startsWith('#') ? value : `#${value.replace(/^#/, '')}`;
        }
        const name = tag?.name || tag?.tag || tag?.hashtag || tag?.slug;
        if (typeof name !== 'string' || !name.trim()) return null;
        const value = name.trim();
        return value.startsWith('#') ? value : `#${value}`;
      })
      .filter(Boolean),
  )];
}

function hashtagsFromCaptionText(text) {
  return String(text || '').match(/#[\w]+/g) || [];
}

function normalizeTikTokHashtags(hashtags) {
  return normalizeHashtagList(hashtags);
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
  const captionParts = [post.caption, post.text, post.alt, post.description]
    .filter((part) => typeof part === 'string' && part.trim());
  const caption = [...new Set(captionParts.map((part) => part.trim()))].join('\n\n');
  const hashtags = normalizeHashtagList([
    ...(Array.isArray(post.hashtags) ? post.hashtags : []),
    ...hashtagsFromCaptionText(caption),
  ]);

  let combinedText = caption;
  if (hashtags.length) {
    combinedText = `${combinedText}${combinedText ? '\n\n' : ''}Hashtags: ${hashtags.join(' ')}`;
  }

  if (!combinedText.trim()) {
    if (post.videoUrl) {
      combinedText = 'FITSAVER_EXTRACT_FROM_VIDEO';
    } else {
      throw new Error('No workout text found in post (no caption, no image text)');
    }
  }

  console.log('📸 Instagram extract:', {
    captionLength: caption.length,
    hashtagCount: hashtags.length,
    hasVideoUrl: Boolean(post.videoUrl),
  });

  return {
    text: combinedText.trim(),
    displayUrl: post.displayUrl,
    hashtags,
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

const FACEBOOK_VIDEO_ONLY_TEXT = 'FITSAVER_EXTRACT_FROM_VIDEO';

function collectHttpUrlsDeep(value, found = []) {
  if (!value) return found;
  if (typeof value === 'string') {
    if (value.startsWith('http')) found.push(value);
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectHttpUrlsDeep(item, found));
    return found;
  }
  if (typeof value === 'object') {
    Object.values(value).forEach((item) => collectHttpUrlsDeep(item, found));
  }
  return found;
}

function facebookIdsFromUrl(url) {
  const value = String(url || '');
  const ids = new Set();
  const patterns = [
    /\/reel\/(\d+)/i,
    /\/videos\/(\d+)/i,
    /\/watch\/?\?.*[?&]v=(\d+)/i,
    /[?&]v=(\d+)/i,
    /[?&]story_fbid=(\d+)/i,
    /\/posts\/(pfbid[\w]+|\d+)/i,
    /\/permalink\.php\?.*story_fbid=(\d+)/i,
    /fb\.watch\/([\w-]+)/i,
    /\/share\/[rvp]\/([\w-]+)/i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.[1]) ids.add(match[1]);
  }
  return [...ids];
}

function facebookPageUrlFromPostUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes('fb.watch')) return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    const reserved = new Set([
      'reel',
      'watch',
      'share',
      'permalink.php',
      'photo.php',
      'story.php',
      'video.php',
      'groups',
    ]);
    if (!parts[0] || reserved.has(parts[0].toLowerCase())) return null;
    return `${parsed.origin}/${parts[0]}/`;
  } catch {
    return null;
  }
}

function postMatchesInput(post, inputUrl) {
  const ids = facebookIdsFromUrl(inputUrl);
  const haystack = [
    post?.url,
    post?.postUrl,
    post?.topLevelUrl,
    post?.topLevelReelUrl,
    post?.shareable_url,
    post?.facebookUrl,
    String(post?.postId || ''),
    String(post?.videoId || ''),
    String(post?.id || ''),
  ]
    .filter(Boolean)
    .join(' ');

  if (ids.some((id) => haystack.includes(id))) return true;

  try {
    const inputPath = new URL(inputUrl.split('?')[0]).pathname.replace(/\/+$/, '').toLowerCase();
    return haystack.toLowerCase().includes(inputPath);
  } catch {
    return false;
  }
}

function facebookMediaItems(post) {
  const items = [];
  if (Array.isArray(post?.media)) items.push(...post.media);
  if (Array.isArray(post?.attachments)) items.push(...post.attachments);
  return items.filter(Boolean);
}

function isFacebookVideoMedia(item) {
  const type = String(item?.__typename || item?.__isMedia || item?.type || '').toLowerCase();
  return type.includes('video') || type.includes('reel');
}

function pickFacebookVideoUrl(post) {
  const nested = facebookMediaItems(post).flatMap((item) => [
    item.playable_url,
    item.playableUrl,
    item.browser_native_hd_url,
    item.browser_native_sd_url,
    item.videoUrl,
    item.video?.playable_url,
    item.video?.browser_native_hd_url,
    item.video?.browser_native_sd_url,
    item.video?.uri,
  ]);

  const urls = [
    post?.videoUrl,
    post?.playable_url,
    post?.browser_native_hd_url,
    post?.downloadUrl,
    ...nested,
    ...collectHttpUrlsDeep(post),
  ].filter((url) => typeof url === 'string' && url.trim());

  const unique = [...new Set(urls)];
  return (
    unique.find((url) => url.toLowerCase().includes('.mp4')) ||
    unique.find((url) => {
      const lower = url.toLowerCase();
      return lower.includes('fbcdn') && (lower.includes('video') || lower.includes('/v/t2') || lower.includes('/o1/v/'));
    }) ||
    null
  );
}

function pickFacebookImageUrls(post) {
  const fromMedia = facebookMediaItems(post)
    .map((item) => item.photo_image?.uri || item.image?.uri || item.thumbnail)
    .filter((url) => typeof url === 'string' && url.startsWith('http'));
  const extras = [post?.imageUrl, post?.thumbnailUrl, post?.fullPicture].filter(
    (url) => typeof url === 'string' && url.startsWith('http'),
  );
  return [...new Set([...fromMedia, ...extras])];
}

function isGenericFacebookOcr(text) {
  return /^(may be an image|image may contain|photo of)/i.test(String(text || '').trim());
}

function collectNamedStrings(value, names, found = []) {
  if (!value) return found;
  if (Array.isArray(value)) {
    value.forEach((item) => collectNamedStrings(item, names, found));
    return found;
  }
  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (names.has(key.toLowerCase()) && typeof nested === 'string' && nested.trim()) {
        found.push(nested.trim());
      } else if (nested && typeof nested === 'object') {
        collectNamedStrings(nested, names, found);
      }
    }
  }
  return found;
}

function collectCaptionUrls(value, found = []) {
  if (!value) return found;
  if (Array.isArray(value)) {
    value.forEach((item) => collectCaptionUrls(item, found));
    return found;
  }
  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (
        /caption.*url|transcript.*url|subtitles?_url/i.test(key) &&
        typeof nested === 'string' &&
        nested.startsWith('http')
      ) {
        found.push(nested);
      } else if (nested && typeof nested === 'object') {
        collectCaptionUrls(nested, found);
      }
    }
  }
  return found;
}

function parseSrtTranscript(srt) {
  return String(srt || '')
    .replace(/\r/g, '')
    .split(/\n\s*\n/)
    .map((block) =>
      block
        .split('\n')
        .filter((line) => line.trim() && !/^\d+$/.test(line.trim()) && !/-->/.test(line))
        .join(' ')
        .trim(),
    )
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function downloadFacebookTranscripts(post) {
  const urls = [...new Set(collectCaptionUrls(post))];
  const texts = [];
  for (const captionsUrl of urls.slice(0, 3)) {
    try {
      const response = await axios.get(captionsUrl, {
        timeout: 15000,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
          Referer: 'https://www.facebook.com/',
        },
      });
      const parsed = parseSrtTranscript(response.data);
      if (parsed) texts.push(parsed);
    } catch (error) {
      console.warn('📘 Failed to download Facebook caption file:', error.message);
    }
  }
  return texts;
}

async function facebookCaptionFromPost(post) {
  const parts = [
    post?.text,
    post?.message,
    post?.caption,
    post?.description,
    post?.title,
    ...collectNamedStrings(post, new Set([
      'captiontext',
      'transcript',
      'videotranscript',
      'video_transcript',
      'subtitle',
      'subtitles',
      'message',
      'text',
      'caption',
      'description',
    ])),
  ].filter((part) => typeof part === 'string' && part.trim());

  for (const item of facebookMediaItems(post)) {
    const ocr = item?.ocrText || item?.ocr_text;
    if (typeof ocr === 'string' && ocr.trim() && !isGenericFacebookOcr(ocr)) {
      parts.push(ocr.trim());
    }
  }

  const srtTexts = await downloadFacebookTranscripts(post);
  parts.push(...srtTexts);

  return [...new Set(parts.map((part) => part.trim()).filter(Boolean))].join('\n\n').trim();
}

function captionLooksLikeExerciseList(text) {
  const value = String(text || '').trim();
  if (!value || value === FACEBOOK_VIDEO_ONLY_TEXT || value.length < 8) return false;
  const hasReps = /\b(\d+\s*(reps?|sets?|rounds?|sec|secs|seconds|min|mins|minutes)|x\s*\d+)\b/i.test(value);
  const hasMoves =
    /\b(squat|push.?up|lunge|plank|curl|press|deadlift|row|burpee|jump|hold|crunch|bridge|pull.?up|dip|raise|extension|kickback|thruster|clean|snatch|swing)\b/i.test(
      value,
    );
  return hasReps || (hasMoves && /\d/.test(value));
}

function facebookHashtags(post, caption) {
  return normalizeHashtagList([
    ...hashtagsFromCaptionText(caption),
    ...(Array.isArray(post?.hashtags) ? post.hashtags : []),
  ]);
}

function stripFacebookTracking(url) {
  try {
    const parsed = new URL(url);
    ['mibextid', 'fbclid', 'rdid', 'share_url', 'sfnsn'].forEach((param) => parsed.searchParams.delete(param));
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function facebookMetaContent(html, property) {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, 'i'),
    new RegExp(`<meta[^>]+name=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtmlEntities(match[1]);
  }
  return '';
}

function isFacebookShareOrShortUrl(url) {
  const lower = String(url || '').toLowerCase();
  return (
    lower.includes('/share/r/') ||
    lower.includes('/share/v/') ||
    lower.includes('/share/p/') ||
    lower.includes('fb.watch/') ||
    lower.includes('/share/')
  );
}

function isFacebookReelUrl(url) {
  const lower = String(url || '').toLowerCase();
  return lower.includes('/share/r/') || lower.includes('/reel/');
}

async function resolveFacebookShareUrl(url) {
  const cleaned = stripFacebookTracking(url);
  try {
    const response = await axios.get(cleaned, {
      maxRedirects: 8,
      timeout: 15000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      validateStatus: (status) => status >= 200 && status < 400,
    });

    const html = typeof response.data === 'string' ? response.data : '';
    const redirected =
      response.request?.res?.responseUrl ||
      response.request?.responseURL ||
      cleaned;
    const ogUrl = facebookMetaContent(html, 'og:url');

    return {
      canonical: stripFacebookTracking(ogUrl || redirected || cleaned),
      title: facebookMetaContent(html, 'og:title'),
      description: facebookMetaContent(html, 'og:description'),
      image: facebookMetaContent(html, 'og:image'),
      video:
        facebookMetaContent(html, 'og:video:secure_url') ||
        facebookMetaContent(html, 'og:video:url') ||
        facebookMetaContent(html, 'og:video'),
    };
  } catch (error) {
    console.warn('📘 Could not resolve Facebook share URL:', error.message);
    return { canonical: cleaned };
  }
}

async function runFacebookActorDataset(actorPath, token, input, timeout = 180000) {
  const response = await axios.post(
    `https://api.apify.com/v2/acts/${actorPath}/run-sync-get-dataset-items`,
    input,
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      timeout,
    },
  );
  return Array.isArray(response.data) ? response.data : [];
}

async function runFacebookPostsScraper(startUrl, token, resultsLimit = 1) {
  console.log('📘 Running facebook-posts-scraper for', startUrl);
  return runFacebookActorDataset('apify~facebook-posts-scraper', token, {
    startUrls: [{ url: startUrl }],
    resultsLimit,
    captionText: true,
  });
}

async function runFacebookReelsScraper(startUrl, token) {
  console.log('📘 Running facebook-reels-scraper for', startUrl);
  return runFacebookActorDataset('apify~facebook-reels-scraper', token, {
    startUrls: [{ url: startUrl }],
    resultsLimit: 1,
  });
}

async function ocrFacebookImages(imageUrls) {
  if (!imageUrls.length) return '';
  try {
    const workoutOpenAi = require('./workoutOpenAi');
    const texts = [];
    for (const imageUrl of imageUrls.slice(0, 3)) {
      const text = await workoutOpenAi.extractTextFromImage(imageUrl);
      if (typeof text === 'string' && text.trim().length > 8) {
        texts.push(text.trim());
      }
    }
    return texts.join('\n\n');
  } catch (error) {
    console.warn('📘 Facebook image OCR failed:', error.message);
    return '';
  }
}

function pickMatchingFacebookPost(items, inputUrl) {
  if (!items?.length) return null;
  return items.find((item) => postMatchesInput(item, inputUrl)) || items[0];
}

async function extractFacebookWithApify(url, token) {
  try {
    const resolved = await resolveFacebookShareUrl(url);
    const canonical = resolved.canonical || stripFacebookTracking(url);
    const shareOnly = isFacebookShareOrShortUrl(canonical) && isFacebookShareOrShortUrl(url);
    const startUrls = [...new Set([canonical, stripFacebookTracking(url)].filter((startUrl) => !isFacebookShareOrShortUrl(startUrl)))];
    console.log('📘 Facebook resolved URLs:', { canonical, startUrls, shareOnly });

    let items = [];
    for (const startUrl of startUrls) {
      try {
        items = await runFacebookPostsScraper(startUrl, token, 1);
        console.log(`📘 facebook-posts-scraper returned ${items.length} item(s) for ${startUrl}`);
        if (items.length) break;
      } catch (error) {
        console.warn(`📘 facebook-posts-scraper failed for ${startUrl}:`, error.message);
      }
    }

    if (!items.length && (shareOnly || startUrls.some(isFacebookReelUrl) || isFacebookReelUrl(canonical) || isFacebookReelUrl(url))) {
      const reelUrls = [...new Set([canonical, stripFacebookTracking(url)].filter(Boolean))];
      for (const startUrl of reelUrls) {
        try {
          items = await runFacebookReelsScraper(startUrl, token);
          console.log(`📘 facebook-reels-scraper returned ${items.length} item(s) for ${startUrl}`);
          if (items.length) break;
        } catch (error) {
          console.warn(`📘 facebook-reels-scraper failed for ${startUrl}:`, error.message);
        }
      }
    }

    const post = pickMatchingFacebookPost(items, resolved.canonical || url) || items[0] || {};
    const hasPost = Boolean(items.length);

    let caption = (await facebookCaptionFromPost(post)) || resolved.description || resolved.title || '';
    let videoUrl = pickFacebookVideoUrl(post) || resolved.video || null;
    const imageUrls = [...new Set([...pickFacebookImageUrls(post), resolved.image].filter(Boolean))];
    const hasVideoMedia =
      facebookMediaItems(post).some(isFacebookVideoMedia) || Boolean(videoUrl) || isFacebookReelUrl(resolved.canonical || url);

    if (!captionLooksLikeExerciseList(caption) && imageUrls.length) {
      const ocrText = await ocrFacebookImages(imageUrls);
      if (ocrText) {
        caption = [caption, ocrText].filter(Boolean).join('\n\n');
      }
    }

    const hashtags = facebookHashtags(post, caption);
    const captionWithHashtags = hashtags.length
      ? [caption, `Hashtags: ${hashtags.join(' ')}`].filter(Boolean).join('\n\n')
      : caption;
    const hasExerciseList = captionLooksLikeExerciseList(caption);
    // Use the full caption when it already lists exercises. Only send the
    // video-processing marker when that caption has no exercise information.
    const text = hasExerciseList
      ? captionWithHashtags
      : [FACEBOOK_VIDEO_ONLY_TEXT, captionWithHashtags].filter(Boolean).join('\n\n') || FACEBOOK_VIDEO_ONLY_TEXT;

    console.log('📘 Facebook extract:', {
      hasPost,
      itemKeys: Object.keys(post),
      canonical: resolved.canonical,
      captionLength: caption.length,
      hasExerciseList,
      hasVideoUrl: Boolean(videoUrl),
      imageCount: imageUrls.length,
    });

    return {
      text,
      displayUrl: imageUrls[0],
      hashtags,
      url: post.url || post.topLevelUrl || post.topLevelReelUrl || resolved.canonical || url,
      source: 'Facebook',
      type: hasVideoMedia || videoUrl ? 'Video' : 'Post',
      videoUrl: videoUrl || undefined,
    };
  } catch (error) {
    console.warn('📘 Facebook scrape failed; using video-only fallback:', error.message);
    return {
      text: FACEBOOK_VIDEO_ONLY_TEXT,
      displayUrl: undefined,
      hashtags: [],
      url,
      source: 'Facebook',
      type: 'Video',
      videoUrl: undefined,
    };
  }
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
