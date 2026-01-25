const fetch = require('node-fetch');
const FormData = require('form-data');
const JSZip = require('jszip');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const writeFile = promisify(fs.writeFile);
const unlink = promisify(fs.unlink);
const { sendWorkoutProcessingNotification } = require('../utils/pushNotifications');

/**
 * Process video job
 */
module.exports = async function processVideoJob(job, supabase) {
  const { workoutId, videoUrl, videoUrls, videoFiles, userId, caption, source, displayUrl, openAIKey } = job.data;
  
  // Support both file uploads and URLs
  const hasFiles = videoFiles && videoFiles.length > 0;
  const hasUrls = videoUrls || videoUrl;
  
  const files = hasFiles ? videoFiles : [];
  const urls = hasUrls ? (videoUrls || [videoUrl]) : [];
  const totalVideos = files.length + urls.length;
  
  console.log(`🎬 Starting video processing for workout ${workoutId} with ${totalVideos} video(s) (${files.length} uploaded, ${urls.length} URLs)`);
  job.progress(10);

  try {
    const allFrames = [];
    let thumbnailFrame = null;
    
    // Process uploaded files
    for (let i = 0; i < files.length; i++) {
      const videoPath = files[i];
      console.log(`📹 Processing uploaded video ${i + 1}/${files.length}...`);
      
      // Step 2: Extract frames (already have the file, skip download)
      console.log(`📦 Step 2.${i + 1}: Extracting frames...`);
      const { frames, firstFrame } = await extractFrames(videoPath);
      job.progress(25 + (i + 1) * 25 / totalVideos);

      // Cleanup video file
      await unlink(videoPath);

      // Use first video's first frame as thumbnail
      if (i === 0 && firstFrame) {
        thumbnailFrame = firstFrame;
      }
      
      // Collect all frames
      allFrames.push(...frames);
      console.log(`✅ Uploaded video ${i + 1} processed: ${frames.length} frames extracted`);
    }
    
    // Process URL videos (Instagram)
    for (let i = 0; i < urls.length; i++) {
      const videoUrl = urls[i];
      const videoIndex = files.length + i + 1;
      console.log(`📹 Processing video ${videoIndex}/${totalVideos} from URL...`);
      
      // Step 1: Download video
      console.log(`📥 Step 1.${videoIndex}: Downloading video...`);
      const videoPath = await downloadVideo(videoUrl, source);
      job.progress(10 + videoIndex * 15 / totalVideos);

      // Step 2: Extract frames
      console.log(`📦 Step 2.${videoIndex}: Extracting frames...`);
      const { frames, firstFrame } = await extractFrames(videoPath);
      job.progress(25 + videoIndex * 25 / totalVideos);

      // Cleanup video file
      await unlink(videoPath);

      // Use first video's first frame as thumbnail if no uploaded videos
      if (files.length === 0 && i === 0 && firstFrame) {
        thumbnailFrame = firstFrame;
      }
      
      // Collect all frames
      allFrames.push(...frames);
      console.log(`✅ Video ${videoIndex} processed: ${frames.length} frames extracted`);
    }

    if (allFrames.length === 0) {
      throw new Error('No frames extracted from any video');
    }
    
    console.log(`📊 Total frames from ${totalVideos} video(s): ${allFrames.length}`);

    // Step 3: Extract text from frames using OpenAI Vision
    console.log('🔍 Step 3: Extracting text from frames...');
    const extractedText = await extractTextFromFrames(allFrames, openAIKey);
    job.progress(75);

    if (!extractedText || extractedText.length === 0) {
      throw new Error('No text extracted from video frames');
    }

    // Step 4: Parse workout with AI
    console.log('🤖 Step 4: Parsing workout with AI...');
    const workoutData = await parseWorkoutWithAI(caption, extractedText, openAIKey);
    job.progress(90);

    // Step 5: Update workout in database
    console.log('💾 Step 5: Updating workout in database...');
    const finalDisplayUrl = (source === 'TikTok' && thumbnailFrame) ? thumbnailFrame : displayUrl;
    
    await updateWorkout(supabase, workoutId, {
      exercises: workoutData.exercises,
      name: workoutData.name,
      duration: workoutData.duration,
      difficulty: workoutData.difficulty,
      notes: workoutData.notes + '\n\n[Enhanced with video frame analysis]',
      displayUrl: finalDisplayUrl,
      status: 'completed',
    });

    job.progress(100);
    console.log(`✅ Workout ${workoutId} processed successfully`);

    // Send push notification to user
    try {
      await sendWorkoutProcessingNotification(
        supabase,
        userId,
        workoutData.name || 'Your workout',
        true
      );
    } catch (notifError) {
      // Don't fail the job if notification fails
      console.warn('⚠️ Failed to send notification:', notifError.message);
    }

    return {
      success: true,
      workoutId,
      exercises: workoutData.exercises.length,
    };

  } catch (error) {
    console.error(`❌ Error processing workout ${workoutId}:`, error.message);

    // Check if it's a rate limit error
    const isRateLimitError = error.message.includes('429');
    
    if (isRateLimitError) {
      // For rate limits: keep status as processing, don't throw (prevents retry)
      console.log(`⏳ Rate limit hit for workout ${workoutId}, marking for manual retry`);
      await updateWorkout(supabase, workoutId, {
        status: 'processing', // Keep as processing
        notes: '⏳ Hit API rate limit. Please wait 1-2 minutes and check back.',
      });
      // Don't throw - this prevents Bull from retrying
      return { success: false, error: 'Rate limit - no auto retry' };
    } else {
      // Mark workout as permanently failed for other errors
      await updateWorkout(supabase, workoutId, {
        status: 'failed',
        processingError: error.message,
      });
      
      // Send failure notification to user
      try {
        await sendWorkoutProcessingNotification(
          supabase,
          userId,
          'Workout',
          false
        );
      } catch (notifError) {
        console.warn('⚠️ Failed to send failure notification:', notifError.message);
      }
      
      // Throw to mark job as failed
      throw error;
    }
  }
};

/**
 * Download video from URL
 */
async function downloadVideo(videoUrl, source) {
  const isTikTok = videoUrl.includes('tiktok.com') || videoUrl.includes('tiktokcdn.com');
  
  const headers = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  };

  if (isTikTok) {
    // More headers to bypass TikTok's anti-bot
    headers['Referer'] = 'https://www.tiktok.com/';
    headers['Origin'] = 'https://www.tiktok.com';
    headers['Accept'] = 'video/mp4,video/webm,video/*,*/*;q=0.9,application/signed-exchange;v=b3;q=0.7,*/*;q=0.8';
    headers['Accept-Language'] = 'en-US,en;q=0.9';
    headers['Accept-Encoding'] = 'identity';
    headers['Range'] = 'bytes=0-';
    headers['Sec-Fetch-Dest'] = 'video';
    headers['Sec-Fetch-Mode'] = 'no-cors';
    headers['Sec-Fetch-Site'] = 'same-site';
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

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
    const videoPath = path.join('/tmp', `video_${Date.now()}.mp4`);
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

/**
 * Extract frames from video using FFmpeg API
 */
async function extractFrames(videoPath) {
  const formData = new FormData();
  formData.append('file', fs.createReadStream(videoPath), {
    filename: 'video.mp4',
    contentType: 'video/mp4',
  });

  // Extract 1 frame every 3 seconds using select filter
  // select='not(mod(n\,90))' extracts every 90th frame (at 30fps = 3 seconds)
  // But we don't know the input fps, so use fps filter: fps=1/3
  const response = await fetch(
    'https://ffmpeg-rest-production-0140.up.railway.app/video/frames?compress=zip&fps=1',
    {
      method: 'POST',
      body: formData,
      headers: formData.getHeaders(),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`FFmpeg API error: ${response.status} - ${errorText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const zip = new JSZip();
  const zipContent = await zip.loadAsync(Buffer.from(arrayBuffer));

  const files = Object.keys(zipContent.files).filter(name => name.endsWith('.png')).sort();
  
  if (files.length === 0) {
    throw new Error('No frames found in ZIP');
  }

  console.log(`📸 Found ${files.length} frames in ZIP`);

  // Extract first frame for thumbnail
  let firstFrame = null;
  if (files.length > 0) {
    const firstFile = zipContent.files[files[0]];
    const imageData = await firstFile.async('base64');
    firstFrame = `data:image/png;base64,${imageData}`;
  }

  // Extract ALL frames (but take every 3rd to get 3-second intervals)
  // FFmpeg gives us 1 frame per second, so every 3rd frame = every 3 seconds
  const frames = [];
  for (let i = 0; i < files.length; i += 3) {
    const file = zipContent.files[files[i]];
    const imageData = await file.async('base64');
    frames.push(`data:image/png;base64,${imageData}`);
  }

  console.log(`✅ Extracted ${frames.length} frames from ${files.length} total (every 3 seconds)`);
  return { frames, firstFrame };
}

/**
 * Extract text from video frames using OpenAI Vision
 */
async function extractTextFromFrames(frames, openAIKey) {
  const allTexts = [];

  for (let i = 0; i < frames.length; i++) {
    console.log(`📝 Processing frame ${i + 1}/${frames.length}...`);

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openAIKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Extract all visible text from this workout video frame. Include exercise names, rep counts, set counts, durations, and any other text visible on screen. Return only the extracted text, nothing else.',
              },
              {
                type: 'image_url',
                image_url: {
                  url: frames[i],
                  detail: 'low', // Low = 85 tokens, High = 25k tokens per image!
                },
              },
            ],
          }],
          max_tokens: 500,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const text = data.choices[0]?.message?.content || '';
        if (text.trim().length > 0) {
          allTexts.push(text.trim());
        }
      } else {
        const errorData = await response.json().catch(() => ({}));
        console.warn(`⚠️ Frame ${i + 1} API error (${response.status}):`, errorData.error?.message || response.statusText);
      }
    } catch (error) {
      console.warn(`⚠️ Error processing frame ${i + 1}:`, error.message);
    }
  }

  const combinedText = allTexts.join('\n\n');
  console.log(`✅ Extracted text from ${allTexts.length}/${frames.length} frames`);
  
  return combinedText;
}

/**
 * Parse workout using OpenAI
 */
async function parseWorkoutWithAI(caption, extractedText, openAIKey) {
  const combinedText = `${caption}\n\n=== EXTRACTED FROM VIDEO FRAMES ===\n${extractedText}`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openAIKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'system',
        content: 'You are a fitness expert. Extract workout information from the text and return ONLY a valid JSON object with this structure: {"name": "workout name", "exercises": [{"name": "exercise", "reps": "10", "sets": "3", "notes": ""}], "duration": "45 min", "difficulty": "Intermediate", "notes": "any additional notes"}. Do not include any explanation or markdown.',
      }, {
        role: 'user',
        content: combinedText,
      }],
      max_tokens: 2000,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const errorMessage = errorData.error?.message || errorData.message || response.statusText;
    console.error(`❌ OpenAI API error (${response.status}):`, errorMessage);
    throw new Error(`OpenAI API error: ${response.status} - ${errorMessage}`);
  }

  const data = await response.json();
  const content = data.choices[0]?.message?.content || '';
  
  // Parse JSON response
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Failed to parse workout data from AI response');
  }

  const workoutData = JSON.parse(jsonMatch[0]);
  
  // Validate structure
  if (!workoutData.exercises || !Array.isArray(workoutData.exercises)) {
    throw new Error('Invalid workout structure from AI');
  }

  return workoutData;
}

/**
 * Update workout in Supabase
 */
async function updateWorkout(supabase, workoutId, updates) {
  const updateData = {
    status: updates.status,
  };

  if (updates.exercises) updateData.exercises = updates.exercises;
  if (updates.name) updateData.name = updates.name;
  if (updates.duration) updateData.duration = updates.duration;
  if (updates.difficulty) updateData.difficulty = updates.difficulty;
  if (updates.notes) updateData.notes = updates.notes;
  if (updates.displayUrl) updateData.display_url = updates.displayUrl;
  if (updates.processingError) updateData.processing_error = updates.processingError;

  const { error } = await supabase
    .from('workouts')
    .update(updateData)
    .eq('id', workoutId);

  if (error) {
    throw new Error(`Supabase error: ${error.message}`);
  }

  console.log(`✅ Workout ${workoutId} updated in database`);
}
