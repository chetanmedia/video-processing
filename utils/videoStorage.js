const fs = require('fs');
const path = require('path');

const WORKOUT_VIDEOS_BUCKET = 'workout-videos';

function isPermanentWorkoutVideoUrl(videoUrl) {
  if (!videoUrl || typeof videoUrl !== 'string') {
    return false;
  }

  return (
    videoUrl.includes('/storage/v1/object/public/workout-videos/') ||
    videoUrl.includes('/storage/v1/object/sign/workout-videos/')
  );
}

function getVideoContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.webm') return 'video/webm';
  return 'video/mp4';
}

function getStoragePath(userId, workoutId, index, filePath) {
  const ext = path.extname(filePath).toLowerCase() || '.mp4';
  const safeExt = ['.mp4', '.mov', '.webm'].includes(ext) ? ext : '.mp4';
  return `sources/${userId}/${workoutId}/source_${index}${safeExt}`;
}

/**
 * Upload a local workout source video to Supabase Storage.
 * Returns the public URL, or null if upload fails (non-fatal for processing).
 */
async function uploadWorkoutSourceVideo(supabase, {
  localPath,
  userId,
  workoutId,
  index = 0,
}) {
  if (!localPath || !fs.existsSync(localPath)) {
    console.warn('⚠️ Video upload skipped: file missing', localPath);
    return null;
  }

  if (!userId || !workoutId) {
    console.warn('⚠️ Video upload skipped: missing userId or workoutId');
    return null;
  }

  try {
    const stats = fs.statSync(localPath);
    const storagePath = getStoragePath(userId, workoutId, index, localPath);
    const contentType = getVideoContentType(localPath);
    const fileBuffer = fs.readFileSync(localPath);

    console.log(
      `📤 Uploading workout video ${index} to Supabase (${(stats.size / 1024 / 1024).toFixed(2)} MB):`,
      storagePath,
    );

    const { error: uploadError } = await supabase.storage
      .from(WORKOUT_VIDEOS_BUCKET)
      .upload(storagePath, fileBuffer, {
        contentType,
        upsert: true,
      });

    if (uploadError) {
      console.warn('⚠️ Workout video upload failed:', uploadError.message);
      return null;
    }

    const { data } = supabase.storage.from(WORKOUT_VIDEOS_BUCKET).getPublicUrl(storagePath);
    console.log('✅ Workout video stored:', data.publicUrl.substring(0, 80) + '...');
    return data.publicUrl;
  } catch (error) {
    console.warn('⚠️ Workout video upload error:', error.message);
    return null;
  }
}

module.exports = {
  WORKOUT_VIDEOS_BUCKET,
  isPermanentWorkoutVideoUrl,
  uploadWorkoutSourceVideo,
};
