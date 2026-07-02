const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { downloadVideo } = require('./videoDownload');
const { stitchVideos } = require('./videoStitcher');
const { uploadWorkoutSourceVideo } = require('./videoStorage');

const unlink = promisify(fs.unlink);

/**
 * Download carousel clips, stitch into one video, upload to Supabase.
 */
async function stitchAndStoreWorkoutVideo(supabase, {
  workoutId,
  userId,
  videoUrls,
  source,
}) {
  const urls = [...new Set((videoUrls || []).filter(Boolean))];
  if (!urls.length) {
    throw new Error('No video URLs provided');
  }

  const downloadedPaths = [];
  try {
    for (let i = 0; i < urls.length; i++) {
      console.log(`📥 Downloading carousel clip ${i + 1}/${urls.length}...`);
      const localPath = await downloadVideo(urls[i], source);
      downloadedPaths.push(localPath);
    }

    const outputPath = path.join('/tmp', `stitched_${workoutId}_${Date.now()}.mp4`);
    await stitchVideos(downloadedPaths, outputPath);

    const permanentUrl = await uploadWorkoutSourceVideo(supabase, {
      localPath: outputPath,
      userId,
      workoutId,
      index: 'stitched',
    });

    await unlink(outputPath).catch(() => {});

    if (!permanentUrl) {
      throw new Error('Failed to upload stitched video');
    }

    return {
      success: true,
      permanentUrl,
      storedVideoUrls: [permanentUrl],
    };
  } finally {
    for (const localPath of downloadedPaths) {
      await unlink(localPath).catch(() => {});
    }
  }
}

module.exports = {
  stitchAndStoreWorkoutVideo,
};
