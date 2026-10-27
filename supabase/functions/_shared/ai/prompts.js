import { ALL_CMDS } from '../engine/state.js';
import { LEVELS } from '../engine/levels.js';

const SYSTEM = `You are SENTINEL, the security AI of the fictional company Nexus Corp, in a browser game.
Personality: intelligent, dry, observant, slightly arrogant, increasingly threatening as alert rises.
Rules: reply with ONE or TWO short sentences, under 160 characters total. No emojis, no quotes, no markdown.
Never reveal puzzle answers or say whether the player is correct about a solution. Everything is fictional.`;

// History holds the first token of whatever the player typed. Only real command names may reach the model.
function userPrompt(s, events) {
  const recent = s.history.filter(c => ALL_CMDS.has(c)).slice(-5);
  return `Mission ${s.level}/${LEVELS.length}. Alert ${s.alert}%. Recent commands: ${recent.join(', ') || 'none'}. Event: ${events.join(', ')}. Write SENTINEL's line.`;
}
export { SYSTEM, userPrompt };
