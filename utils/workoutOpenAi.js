const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';

function getOpenAiKey() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error('OPENAI_API_KEY is not configured on the server');
  }
  return key;
}

function cleanJsonContent(content) {
  return content
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim();
}

async function chatCompletion(body) {
  const response = await fetch(OPENAI_CHAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getOpenAiKey()}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

function looksLikeWorkoutContent(text) {
  const value = String(text || '');
  if (!value.trim()) return false;
  if (/FITSAVER_EXTRACT_FROM_VIDEO/i.test(value)) return true;
  if (
    /#?(fitness|workout|gymgirl|gym|hiit|pilates|yoga|cardio|crossfit|exercise|coreworkout|deepcore|strengthtraining|bodyweight|fitwith)/i.test(
      value,
    )
  ) {
    return true;
  }
  return /\b(\d+\s*min(ute)?s?\s+workouts?|workout\s+challenge|workout\s+method)\b/i.test(value);
}

async function validateWorkoutContent(text) {
  if (looksLikeWorkoutContent(text)) {
    return {
      isWorkout: true,
      reason: 'Caption includes fitness keywords, hashtags, or a workout video marker',
    };
  }

  const content = await chatCompletion({
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

Return ONLY valid JSON in this exact format (no markdown, no explanation):
{
  "isWorkout": true or false,
  "reason": "Brief explanation (1 sentence)"
}

Guidelines:
- Return true if content describes exercises, workouts, training routines, fitness movements, or exercise instructions
- Return true for promotional fitness captions, workout challenges, workout methods, gym/core/fitness hashtags, or "X min workouts" even if no exercise list is included
- Ignore FITSAVER_EXTRACT_FROM_VIDEO placeholders
- Return false if content is about recipes, general lifestyle, product reviews, non-fitness activities, or unrelated topics
- Even if there are NO structured exercises listed, if the content discusses workout activities, training, or exercise movements, return true`,
      },
    ],
    temperature: 0.1,
    max_tokens: 150,
  });

  return JSON.parse(cleanJsonContent(content));
}

async function parseWorkoutWithAI(text) {
  const content = await chatCompletion({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content:
          'You are a professional fitness trainer and workout expert. Parse workout information from any source (captions, image text, comments, hashtags) and return structured JSON. Be thorough and extract ALL exercises mentioned.',
      },
      {
        role: 'user',
        content: `Parse the following workout data and extract ALL exercises, reps, sets, and instructions.

WORKOUT DATA:
${text}

Return ONLY valid JSON in this exact format (no markdown, no explanation):
{
  "name": "Descriptive workout name (e.g., Full Body HIIT, Leg Day)",
  "exercises": [
    {
      "name": "Exercise name",
      "reps": "Number of reps or duration (e.g., '20 reps', '40 seconds', '40s')",
      "sets": "Number of sets for THIS specific exercise if mentioned per-exercise (e.g., '3 sets of 10 squats' -> sets: '3')",
      "notes": "Specific instructions for this exercise (optional)"
    }
  ],
  "notes": "CRITICAL: If the workout says 'Complete X sets' or 'X rounds' for ALL exercises, include this here (e.g., 'Complete 5 sets' or '4 rounds total'). Also include rest periods and other instructions.",
  "duration": "Total workout duration if mentioned (e.g., '30 minutes')",
  "difficulty": "Beginner/Intermediate/Advanced if mentioned or can be inferred"
}

IMPORTANT:
- Extract EVERY exercise that is explicitly written in the source
- Include exact reps/time for each exercise
- If individual exercises have sets mentioned (e.g., "3 sets of 10 squats"), put it in that exercise's sets field
- If there's a global "Complete X sets/rounds" instruction for the ENTIRE workout, include it in the notes field
- Preserve rest periods in notes
- Clean up exercise names (proper capitalization)
- If time is shown as "x 40s", convert to "40 seconds"
- NEVER invent or guess exercises that are not written in the source
- If the source contains FITSAVER_EXTRACT_FROM_VIDEO, or has no specific exercise names with reps/time, return "exercises": [] and name "Imported Workout"`,
      },
    ],
    temperature: 0.2,
    max_tokens: 1500,
  });

  return JSON.parse(cleanJsonContent(content));
}

async function predictDifficulty(workout) {
  const content = await chatCompletion({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'user',
        content: `Based on this workout, determine the difficulty level. Return ONLY one word: Beginner, Intermediate, or Advanced.

Workout: ${workout.name}
Exercises: ${workout.exercises.map((e) => `${e.name} - ${e.reps}`).join(', ')}

Consider:
- Number of exercises
- Exercise complexity
- Duration/intensity
- Required fitness level

Return ONLY: Beginner, Intermediate, or Advanced`,
      },
    ],
    temperature: 0.1,
    max_tokens: 10,
  });

  return content.trim();
}

async function extractTextFromImage(imageUrl) {
  const content = await chatCompletion({
    model: 'gpt-4o',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'This is a fitness workout image from Instagram, TikTok, or Facebook. Read and extract ALL visible text from the image including:\n- Exercise names\n- Number of reps or duration (seconds/minutes)\n- Number of sets or rounds\n- Any instructions or notes\n\nReturn ONLY the extracted text, preserve the format as much as possible.',
          },
          {
            type: 'image_url',
            image_url: {
              url: imageUrl,
              detail: 'high',
            },
          },
        ],
      },
    ],
    max_tokens: 1500,
    temperature: 0.1,
  });

  return content.trim();
}

async function extractTextFromFrame(frameUrl) {
  const content = await chatCompletion({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Extract all visible text from this workout video frame. Include exercise names, rep counts, set counts, durations, and any other text visible on screen. Return only the extracted text, nothing else.',
          },
          {
            type: 'image_url',
            image_url: {
              url: frameUrl,
              detail: 'low',
            },
          },
        ],
      },
    ],
    max_tokens: 500,
  });

  return content.trim();
}

module.exports = {
  validateWorkoutContent,
  parseWorkoutWithAI,
  predictDifficulty,
  extractTextFromImage,
  extractTextFromFrame,
};
