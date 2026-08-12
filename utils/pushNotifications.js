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

/**
 * Send social feed activity notification (like / comment on a post)
 * @param {object} supabase
 * @param {object} params
 * @param {string} params.postId
 * @param {string} params.actorUserId - user who liked/commented
 * @param {'like'|'comment'} params.type
 * @param {string} [params.commentPreview]
 * @returns {Promise<{ sent: boolean; reason?: string }>}
 */
async function sendSocialActivityNotification(supabase, params) {
  try {
    const { postId, actorUserId, type, commentPreview } = params || {};
    if (!postId || !actorUserId || (type !== 'like' && type !== 'comment')) {
      return { sent: false, reason: 'invalid_params' };
    }

    const { data: post, error: postError } = await supabase
      .from('social_posts')
      .select('id, user_id, workout_name')
      .eq('id', postId)
      .maybeSingle();

    if (postError || !post) {
      console.error('❌ Social notify: post not found', postError);
      return { sent: false, reason: 'post_not_found' };
    }

    // Don't notify yourself
    if (post.user_id === actorUserId) {
      return { sent: false, reason: 'self' };
    }

    const { data: owner, error: ownerError } = await supabase
      .from('users')
      .select('id, push_token, notify_social_activity')
      .eq('id', post.user_id)
      .maybeSingle();

    if (ownerError || !owner) {
      console.error('❌ Social notify: owner not found', ownerError);
      return { sent: false, reason: 'owner_not_found' };
    }

    // Default true when column is null (pre-migration / unset)
    if (owner.notify_social_activity === false) {
      return { sent: false, reason: 'disabled' };
    }

    if (!owner.push_token) {
      return { sent: false, reason: 'no_push_token' };
    }

    const { data: actor } = await supabase
      .from('users')
      .select('username')
      .eq('id', actorUserId)
      .maybeSingle();

    const actorName = actor?.username || 'Someone';
    const workoutLabel = post.workout_name ? ` (${post.workout_name})` : '';

    const notification =
      type === 'like'
        ? {
            title: 'New like',
            body: `${actorName} liked your post${workoutLabel}`,
            data: {
              type: 'social_post_like',
              postId,
              actorUserId,
            },
          }
        : {
            title: 'New comment',
            body: commentPreview
              ? `${actorName}: ${String(commentPreview).slice(0, 80)}`
              : `${actorName} commented on your post${workoutLabel}`,
            data: {
              type: 'social_post_comment',
              postId,
              actorUserId,
            },
          };

    const sent = await sendPushNotification(owner.push_token, notification);
    if (sent) {
      console.log(`📱 Social ${type} notification sent to ${post.user_id}`);
    }
    return { sent, reason: sent ? undefined : 'send_failed' };
  } catch (error) {
    console.error('❌ Error sending social activity notification:', error);
    return { sent: false, reason: 'error' };
  }
}

module.exports = {
  sendPushNotification,
  getUserPushToken,
  sendWorkoutProcessingNotification,
  sendSocialActivityNotification,
};
