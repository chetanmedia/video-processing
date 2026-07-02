const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const writeFile = promisify(fs.writeFile);

/**
 * Download a social video URL to a temp file.
 */
async function downloadVideo(videoUrl, source) {
  const isTikTok =
    videoUrl.includes('tiktok.com') || videoUrl.includes('tiktokcdn.com');
  const isFacebook =
    videoUrl.includes('facebook.com') ||
    videoUrl.includes('fbcdn.net') ||
    videoUrl.includes('fb.watch');

  const headers = {
    'User-Agent':
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  };

  if (isTikTok) {
    headers.Referer = 'https://www.tiktok.com/';
    headers.Origin = 'https://www.tiktok.com';
    headers.Accept =
      'video/mp4,video/webm,video/*,*/*;q=0.9,application/signed-exchange;v=b3;q=0.7,*/*;q=0.8';
    headers['Accept-Language'] = 'en-US,en;q=0.9';
    headers['Accept-Encoding'] = 'identity';
    headers.Range = 'bytes=0-';
    headers['Sec-Fetch-Dest'] = 'video';
    headers['Sec-Fetch-Mode'] = 'no-cors';
    headers['Sec-Fetch-Site'] = 'same-site';
  } else if (isFacebook || source === 'Facebook') {
    headers.Referer = 'https://www.facebook.com/';
    headers.Origin = 'https://www.facebook.com';
    headers.Accept = 'video/mp4,video/*,*/*;q=0.9';
    headers['Accept-Language'] = 'en-US,en;q=0.9';
  } else if (source === 'Instagram') {
    headers.Referer = 'https://www.instagram.com/';
    headers.Origin = 'https://www.instagram.com';
    headers.Accept = 'video/mp4,video/*,*/*;q=0.9';
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch(videoUrl, {
      signal: controller.signal,
      headers,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Failed to download video: ${response.status}`);
    }

    const buffer = await response.buffer();
    const videoPath = path.join('/tmp', `video_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
    await writeFile(videoPath, buffer);

    console.log(`✅ Video downloaded: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);
    return videoPath;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('Video download timeout');
    }
    throw error;
  }
}

module.exports = {
  downloadVideo,
};
