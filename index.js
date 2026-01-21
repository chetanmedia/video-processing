const express = require('express');
const cors = require('cors');
const multer = require('multer');
const Queue = require('bull');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configure multer for file uploads
const upload = multer({ 
  dest: '/tmp/uploads/',
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Initialize Bull queue
const videoQueue = new Queue('video-processing', process.env.REDIS_URL || 'redis://localhost:6379', {
  defaultJobOptions: {
    attempts: 3, // Retry up to 3 times for rate limits
    backoff: {
      type: 'exponential',
      delay: 60000, // Start with 1 minute delay (rate limits reset per minute)
    },
    removeOnComplete: true, // Clean up completed jobs
    removeOnFail: false, // Keep failed jobs for debugging
  },
});

// Import job processor
const processVideoJob = require('./processors/videoProcessor');

// Process jobs
videoQueue.process(async (job) => {
  console.log(`🎬 Processing job ${job.id}...`);
  return await processVideoJob(job, supabase);
});

// Job event handlers
videoQueue.on('completed', (job, result) => {
  console.log(`✅ Job ${job.id} completed successfully`);
});

videoQueue.on('failed', (job, err) => {
  console.error(`❌ Job ${job.id} failed:`, err.message);
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Submit video processing job (with file upload for TikTok)
app.post('/api/process-video-upload', upload.array('videos', 10), async (req, res) => {
  try {
    const { workoutId, userId, caption, source, displayUrl } = req.body;
    const uploadedFiles = req.files;

    if (!workoutId || !uploadedFiles || uploadedFiles.length === 0 || !userId) {
      return res.status(400).json({
        error: 'Missing required fields: workoutId, video file(s), userId',
      });
    }

    console.log(`📥 Received video upload for workout ${workoutId} with ${uploadedFiles.length} video(s)`);

    // Store uploaded file paths
    const videoPaths = uploadedFiles.map(file => file.path);

    // Add job to queue with local file paths
    const job = await videoQueue.add({
      workoutId,
      videoFiles: videoPaths, // Local file paths instead of URLs
      userId,
      caption,
      source,
      displayUrl,
      openAIKey: process.env.OPENAI_API_KEY,
    });

    res.json({
      success: true,
      jobId: job.id,
      message: 'Video processing started',
    });
  } catch (error) {
    console.error('❌ Error submitting upload job:', error);
    res.status(500).json({
      error: 'Failed to submit video processing job',
      message: error.message,
    });
  }
});

// Submit video processing job
app.post('/api/process-video', async (req, res) => {
  try {
    const { workoutId, videoUrl, videoUrls, userId, caption, source, displayUrl } = req.body;

    // Support both single videoUrl and multiple videoUrls
    const urls = videoUrls || (videoUrl ? [videoUrl] : []);
    
    if (!workoutId || urls.length === 0 || !userId) {
      return res.status(400).json({
        error: 'Missing required fields: workoutId, videoUrl(s), userId',
      });
    }

    console.log(`📥 Received video processing request for workout ${workoutId} with ${urls.length} video(s)`);

    // Add job to queue
    const job = await videoQueue.add({
      workoutId,
      videoUrls: urls, // Now sending array
      userId,
      caption,
      source,
      displayUrl,
      openAIKey: process.env.OPENAI_API_KEY,
    });

    res.json({
      success: true,
      jobId: job.id,
      message: 'Video processing started',
    });
  } catch (error) {
    console.error('❌ Error submitting job:', error);
    res.status(500).json({
      error: 'Failed to submit video processing job',
      message: error.message,
    });
  }
});

// Get job status
app.get('/api/job-status/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = await videoQueue.getJob(jobId);

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const state = await job.getState();
    const progress = job.progress();

    res.json({
      jobId: job.id,
      status: state,
      progress,
      workoutId: job.data.workoutId,
    });
  } catch (error) {
    console.error('❌ Error getting job status:', error);
    res.status(500).json({
      error: 'Failed to get job status',
      message: error.message,
    });
  }
});

// Get queue stats
app.get('/api/stats', async (req, res) => {
  try {
    const counts = await videoQueue.getJobCounts();
    res.json({
      waiting: counts.waiting,
      active: counts.active,
      completed: counts.completed,
      failed: counts.failed,
      delayed: counts.delayed,
    });
  } catch (error) {
    console.error('❌ Error getting stats:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Queue dashboard: http://localhost:${PORT}/admin/queues`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('👋 SIGTERM received, closing server...');
  await videoQueue.close();
  process.exit(0);
});
