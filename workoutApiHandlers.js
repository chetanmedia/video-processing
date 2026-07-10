const axios = require('axios');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getOpenAIKey() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not configured on Railway');
  return key;
}

function getApifyToken() {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error('APIFY_TOKEN is not configured on Railway');
  return token;
}

function cleanJsonContent(content) {
  return String(content || '')
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim();
}

async function validateWorkoutContent(text) {
  const apiKey = getOpenAIKey();
  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'You are a fitness content validator. Determine if the provided text is related to workouts, exercises, or fitness training.',
        },
        {
          role: 'user',
          content: `Is the following content related to workouts, exercises, or fitness training?

CONTENT:
${text}

Return ONLY valid JSON:
{"isWorkout": true or false, "reason": "Brief explanation"}`,
        },
      ],
      temperature: 0.1,
      max_tokens: 150,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
    },
  );

  return JSON.parse(cleanJsonContent(response.data.choices[0].message.content));
}

async function parseWorkout(text, predictDifficulty = true) {
  const apiKey = getOpenAIKey();
  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'You are a professional fitness trainer. Parse workout information and return structured JSON.',
        },
        {
          role: 'user',
          content: `Parse the following workout data:

${text}

Return ONLY valid JSON:
{
  "name": "Workout name",
  "exercises": [{"name": "...", "reps": "...", "sets": "...", "notes": "..."}],
  "notes": "...",
  "duration": "...",
  "difficulty": "Beginner|Intermediate|Advanced"
}`,
        },
      ],
      temperature: 0.2,
      max_tokens: 1500,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
    },
  );

  const parsed = JSON.parse(cleanJsonContent(response.data.choices[0].message.content));

  if (!predictDifficulty || parsed.difficulty || !parsed.exercises?.length) {
    return parsed;
  }

  try {
    const diffResponse = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: `Return ONLY one word: Beginner, Intermediate, or Advanced.

Workout: ${parsed.name}
Exercises: ${parsed.exercises.map((e) => `${e.name} - ${e.reps}`).join(', ')}`,
          },
        ],
        temperature: 0.1,
        max_tokens: 10,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
      },
    );
    parsed.difficulty = diffResponse.data.choices[0].message.content.trim();
  } catch {
    parsed.difficulty = parsed.difficulty || 'Intermediate';
  }

  return parsed;
}

async function extractImageText(imageUrl) {
  const apiKey = getOpenAIKey();
  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Extract ALL visible workout text from this image (exercises, reps, sets, durations). Return ONLY the extracted text.',
            },
            { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } },
          ],
        },
      ],
      max_tokens: 1500,
      temperature: 0.1,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      timeout: 30000,
    },
  );

  return { text: response.data.choices[0].message.content.trim() };
}

async function extractFrameText(frameUrl) {
  const apiKey = getOpenAIKey();
  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Extract all visible text from this workout video frame. Return only the extracted text.',
            },
            { type: 'image_url', image_url: { url: frameUrl, detail: 'low' } },
          ],
        },
      ],
      max_tokens: 500,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      timeout: 30000,
    },
  );

  return { text: response.data.choices[0].message.content.trim() };
}

async function waitForApifyRun(actorPath, runId, token) {
  let status = 'RUNNING';
  let attempts = 0;
  while (status === 'RUNNING' && attempts < 30) {
    await sleep(3000);
    const statusResponse = await axios.get(`https://api.apify.com/v2/acts/${actorPath}/runs/${runId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    status = statusResponse.data.data.status;
    attempts++;
  }
  if (status !== 'SUCCEEDED') {
    throw new Error(`Apify run did not succeed. Status: ${status}`);
  }
}

async function extractInstagramWithApify(url, apifyToken) {
  const runResponse = await axios.post(
    'https://api.apify.com/v2/acts/apify~instagram-scraper/runs',
    { directUrls: [url], resultsType: 'posts', resultsLimit: 1 },
    {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apifyToken}` },
      timeout: 90000,
    },
  );
  const runId = runResponse.data.data.id;
  const datasetId = runResponse.data.data.defaultDatasetId;
  await waitForApifyRun('apify~instagram-scraper', runId, apifyToken);
  const resultsResponse = await axios.get(`https://api.apify.com/v2/datasets/${datasetId}/items`, {
    headers: { Authorization: `Bearer ${apifyToken}` },
  });
  const post = resultsResponse.data?.[0];
  if (!post) throw new Error('No data returned from Apify');

  return buildInstagramExtractedData(post, url);
}

function normalizeHashtags(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((tag) => (typeof tag === 'string' ? tag : tag?.name || tag?.text || String(tag)))
      .filter(Boolean);
  }
  if (typeof raw === 'string') return [raw];
  return [];
}

function pickString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function buildInstagramExtractedData(post, url) {
  const hashtags = normalizeHashtags(post.hashtags);
  let combinedText = pickString(
    post.caption,
    post.text,
    post.alt,
    post.accessibilityCaption,
    post.description,
    post.title,
  );

  if (!combinedText && Array.isArray(post.childPosts)) {
    for (const child of post.childPosts) {
      const childText = pickString(child.caption, child.alt, child.text, child.description);
      if (childText) {
        combinedText = combinedText ? `${combinedText}\n\n${childText}` : childText;
      }
    }
  }

  if (hashtags.length) {
    combinedText = combinedText
      ? `${combinedText}\n\nHashtags: ${hashtags.join(' ')}`
      : `Hashtags: ${hashtags.join(' ')}`;
  }

  if (!combinedText.trim()) {
    throw new Error('No workout text found in Instagram post');
  }

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

async function extractTikTokWithApify(url, apifyToken) {
  const runResponse = await axios.post(
    'https://api.apify.com/v2/acts/clockworks~tiktok-scraper/runs',
    {
      postURLs: [url],
      scrapeRelatedVideos: false,
      resultsPerPage: 100,
      shouldDownloadVideos: false,
      shouldDownloadCovers: false,
      shouldDownloadSubtitles: false,
      shouldDownloadSlideshowImages: false,
    },
    {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apifyToken}` },
      timeout: 90000,
    },
  );
  const runId = runResponse.data.data.id;
  const datasetId = runResponse.data.data.defaultDatasetId;
  await waitForApifyRun('clockworks~tiktok-scraper', runId, apifyToken);
  const resultsResponse = await axios.get(`https://api.apify.com/v2/datasets/${datasetId}/items`, {
    headers: { Authorization: `Bearer ${apifyToken}` },
  });
  const video = resultsResponse.data?.[0];
  if (!video) throw new Error('No data returned from Apify');

  let combinedText = '';
  if (video.description?.trim()) combinedText += video.description + '\n\n';
  if (video.text?.trim()) combinedText += video.text + '\n';
  const hashtags = normalizeHashtags(video.hashtags);
  if (hashtags.length) combinedText += '\nHashtags: ' + hashtags.join(' ') + '\n';
  if (!combinedText.trim()) throw new Error('No workout text found in TikTok video');

  const finalVideoUrl =
    video.videoUrl ||
    video.downloadUrl ||
    video.webVideoUrl ||
    video.video?.downloadAddr ||
    video.video?.playAddr ||
    video.videoMeta?.downloadAddr;

  return {
    text: combinedText.trim(),
    displayUrl: video.authorMeta?.avatar || video.coverUrl || video.cover || video.dynamicCover,
    hashtags,
    url: video.url || url,
    source: 'TikTok',
    type: 'Video',
    videoUrl: finalVideoUrl,
  };
}

async function extractFacebookWithApify(url, apifyToken) {
  const runResponse = await axios.post(
    'https://api.apify.com/v2/acts/apify~facebook-posts-scraper/runs',
    { startUrls: [{ url }], resultsLimit: 1, captionText: true },
    {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apifyToken}` },
      timeout: 90000,
    },
  );
  const runId = runResponse.data.data.id;
  const datasetId = runResponse.data.data.defaultDatasetId;
  await waitForApifyRun('apify~facebook-posts-scraper', runId, apifyToken);
  const resultsResponse = await axios.get(`https://api.apify.com/v2/datasets/${datasetId}/items`, {
    headers: { Authorization: `Bearer ${apifyToken}` },
  });
  const post = resultsResponse.data?.[0];
  if (!post) throw new Error('No data returned from Apify');

  const textParts = [post.text, post.caption, post.message, post.title, post.description]
    .filter((part) => typeof part === 'string' && part.trim().length > 0);
  if (!textParts.length) throw new Error('No workout text found in Facebook post');

  return {
    text: textParts.join('\n\n').trim(),
    displayUrl: post.displayUrl || post.thumbnailUrl || post.imageUrl,
    hashtags: post.hashtags || [],
    url: post.url || post.postUrl || url,
    source: 'Facebook',
    type: post.type || (post.videoUrl ? 'Video' : 'Post'),
    videoUrl: post.videoUrl || post.downloadUrl,
    childPosts: post.childPosts,
  };
}

async function extractCaption(url) {
  if (!url.startsWith('http')) {
    return { text: url, url: '', source: 'Manual', hashtags: [] };
  }

  const apifyToken = getApifyToken();
  const lower = url.toLowerCase();

  if (lower.includes('instagram.com')) {
    return extractInstagramWithApify(url, apifyToken);
  }
  if (lower.includes('tiktok.com')) {
    return extractTikTokWithApify(url, apifyToken);
  }
  if (lower.includes('facebook.com') || lower.includes('fb.watch')) {
    return extractFacebookWithApify(url, apifyToken);
  }

  throw new Error('Unsupported platform for caption extraction');
}

function asyncHandler(fn) {
  return async (req, res) => {
    try {
      const result = await fn(req.body || {});
      res.json(result);
    } catch (error) {
      console.error(`❌ Workout API error (${req.path}):`, error.message);
      res.status(500).json({
        error: 'Workout API request failed',
        message: error.message,
      });
    }
  };
}

function registerWorkoutApiRoutes(app) {
  app.post('/api/validate-workout', asyncHandler(async ({ text }) => {
    if (!text?.trim()) throw new Error('Missing text');
    return validateWorkoutContent(text);
  }));

  app.post('/api/parse-workout', asyncHandler(async ({ text, predictDifficulty }) => {
    if (!text?.trim()) throw new Error('Missing text');
    return parseWorkout(text, predictDifficulty !== false);
  }));

  app.post('/api/extract-caption', asyncHandler(async ({ url }) => {
    if (!url?.trim()) throw new Error('Missing url');
    return extractCaption(url.trim());
  }));

  app.post('/api/extract-image-text', asyncHandler(async ({ imageUrl }) => {
    if (!imageUrl?.trim()) throw new Error('Missing imageUrl');
    return extractImageText(imageUrl.trim());
  }));

  app.post('/api/extract-frame-text', asyncHandler(async ({ frameUrl }) => {
    if (!frameUrl?.trim()) throw new Error('Missing frameUrl');
    return extractFrameText(frameUrl.trim());
  }));

  console.log('✅ Workout API routes registered');
}

module.exports = { registerWorkoutApiRoutes };
