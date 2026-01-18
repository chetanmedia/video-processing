const express = require('express');
const cors = require('cors');
const Queue = require('bull');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

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
    attempts: 1, // No retries - fail immediately
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

// Submit video processing job
app.post('/api/process-video', async (req, res) => {
  try {
    const { workoutId, videoUrl, userId, caption, source, displayUrl } = req.body;

    if (!workoutId || !videoUrl || !userId) {
      return res.status(400).json({
        error: 'Missing required fields: workoutId, videoUrl, userId',
      });
    }

    console.log(`📥 Received video processing request for workout ${workoutId}`);

    // Add job to queue
    const job = await videoQueue.add({
      workoutId,
      videoUrl,
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
