const { Expo } = require('expo-server-sdk');

// Create a new Expo SDK client
const expo = new Expo();

/**
 * Send a push notification to a user
 * @param {string} pushToken - The Expo push token (e.g., 'ExponentPushToken[xxx]')
 * @param {object} notification - Notification details
 * @param {string} notification.title - Notification title
 * @param {string} notification.body - Notification body
 * @param {object} [notification.data] - Optional data payload
 * @returns {Promise<boolean>} - Success status
 */
async function sendPushNotification(pushToken, notification) {
  // Check if the push token is valid
  if (!Expo.isExpoPushToken(pushToken)) {
    console.error(`❌ Invalid push token: ${pushToken}`);
    return false;
  }

  // Construct the message
  const message = {
    to: pushToken,
    sound: 'default',
    title: notification.title,
    body: notification.body,
    data: notification.data || {},
  };

  try {
    // Send the notification
    const chunks = expo.chunkPushNotifications([message]);
    const tickets = [];

    for (const chunk of chunks) {
      try {
        const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
        tickets.push(...ticketChunk);
      } catch (error) {
        console.error('❌ Error sending notification chunk:', error);
      }
    }

    // Check for errors in tickets
    for (const ticket of tickets) {
      if (ticket.status === 'error') {
        console.error(`❌ Notification error: ${ticket.message}`);
        if (ticket.details?.error) {
          console.error(`   Error code: ${ticket.details.error}`);
        }
        return false;
      }
    }

    console.log('✅ Push notification sent successfully');
    return true;
  } catch (error) {
    console.error('❌ Error sending push notification:', error);
    return false;
  }
}

/**
 * Get user's push token from database
 * @param {object} supabase - Supabase client
 * @param {string} userId - User ID
 * @returns {Promise<string|null>} - Push token or null
 */
async function getUserPushToken(supabase, userId) {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('push_token')
      .eq('id', userId)
      .single();

    if (error) {
      console.error('❌ Error fetching push token:', error);
      return null;
    }

    return data?.push_token || null;
  } catch (error) {
    console.error('❌ Error getting user push token:', error);
    return null;
  }
}

/**
 * Send workout processing complete notification
 * @param {object} supabase - Supabase client
 * @param {string} userId - User ID
 * @param {string} workoutName - Name of the workout
 * @param {boolean} success - Whether processing was successful
 * @returns {Promise<boolean>} - Success status
 */
async function sendWorkoutProcessingNotification(supabase, userId, workoutName, success = true, workoutId = null) {
  try {
    // Get user's push token
    const pushToken = await getUserPushToken(supabase, userId);
    
    if (!pushToken) {
      console.log('⚠️ No push token found for user, skipping notification');
      return false;
    }

    // Create notification message
    const notification = success
      ? {
          title: '✅ Workout Ready!',
          body: `${workoutName} has been processed and is ready to view.`,
          data: {
            type: 'workout_processed',
            workoutName,
            workoutId,
            success: true,
          },
        }
      : {
          title: '❌ Processing Failed',
          body: `Unable to process ${workoutName}. You can still view it manually.`,
          data: {
            type: 'workout_processed',
            workoutName,
            workoutId,
            success: false,
          },
        };

    // Send the notification
    const sent = await sendPushNotification(pushToken, notification);
    
    if (sent) {
      console.log(`📱 Sent notification to user ${userId}`);
    }
    
    return sent;
  } catch (error) {
    console.error('❌ Error sending workout notification:', error);
    return false;
  }
}

module.exports = {
  sendPushNotification,
  getUserPushToken,
  sendWorkoutProcessingNotification,
};
