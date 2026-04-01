/**
 * Finds proactive follow-up prompts based on open loops.
 */
function findProactiveTrigger(userProfile) {
  const { openLoops = [], lastInteractionTime = 0 } = userProfile || {};
  const hoursSinceLastChat = (Date.now() - lastInteractionTime) / (1000 * 60 * 60);

  if (hoursSinceLastChat > 24 && openLoops.length > 0) {
    const loop = openLoops[Math.floor(Math.random() * openLoops.length)];
    return {
      type: 'FOLLOW_UP',
      content: `Hey, I was thinking about ${loop.topic} from the other day. How did that turn out?`,
      hiddenContext: `[SYSTEM_EVENT: PROACTIVE_FOLLOW_UP_ON_${loop.id}]`
    };
  }
  return null;
}

module.exports = { findProactiveTrigger };



