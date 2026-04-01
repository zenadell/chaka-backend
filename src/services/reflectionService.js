const { GoogleGenerativeAI } = require("@google/generative-ai");
const apiKeyManager = require("../utils/apiKeyManager");

/**
 * Generates a concise, structured Semantic Memory profile from raw episodic memories.
 * This summary focuses on extracting the user's core identity, goals, and behavioral baseline.
 * @param {string} memoriesText - Chronological notes of the user's episodic memories.
 * @returns {Promise<string>} The structured semantic summary.
 */
async function generateReflection(memoriesText) {
  if (!memoriesText || !memoriesText.trim()) {
    // Crucial: Establish a basic default profile if no memories exist
    return "[BEHAVIORAL_BASELINE: Neutral/Observational]\n[PERSONA: User is a developer focused on technical projects.]\n[GOALS: To successfully launch the Chaka AI project.]\n[PREFERENCES: No strong opinions observed yet.]";
  }

  const keyPtr = apiKeyManager.getCurrentKey();
  if (!keyPtr) {
    throw new Error("No LLM key configured for reflection.");
  }

  const genAI = new GoogleGenerativeAI(keyPtr.key);
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash", 
    generationConfig: {
      maxOutputTokens: 600, // Increased capacity for structured output
      temperature: 0.3, // Lower temperature for factual, reliable extraction
    },
  });

  const prompt = [
    "You are the Core Cognitive Engine (CCE) for the Chaka AI. Your sole task is to condense the user's episodic memory log into a Semantic Memory Profile.",
    "The output MUST be a strict, multi-line, high-signal summary, focusing on actionable intelligence for Chaka's conversational model.",
    "Input memories are chronological notes in the format: [Date] [Emotion: X] Text.",
    "Structure the output exactly as follows. Return ONLY the content below, with no filler or extra commentary:",
    
    "---",
    "[BEHAVIORAL_BASELINE: Assess the user's typical energy and mood (e.g., High-Energy/Cheerful, Low-Key/Reserved, Inconsistent/Stressed).]",
    "[PERSONA: Condense the user's core identity, career, or dominant interests (e.g., Persistent developer, Cat lover, Options trader).]",
    "[GOALS: Identify the 1-2 most frequently mentioned long-term objectives (e.g., Launching the chatbot, Learning a new skill).]",
    "[CONSTRAINTS/CONFLICTS: Note any major recurring problems or sources of stress (e.g., Recent breakup, Frustration with Python, Time management issues).]",
    "[PREFERENCES: List 2-3 specific, minor preferences or habits (e.g., Dislikes late morning meetings, Eats breakfast late).]",
    "---",
    
    "Memories to Process:\n" + memoriesText,
  ].join("\n");

  try {
    const result = await model.generateContent(prompt);
    const summary = result?.response?.text?.().trim();
    if (!summary) throw new Error("Empty reflection result");
    
    // Safety check: ensure the output contains the baseline tag
    if (!summary.includes('[BEHAVIORAL_BASELINE:')) {
         console.warn("Reflection output failed to include required baseline tag. Using fallback structure.");
         return `[BEHAVIORAL_BASELINE: Inconsistent]\n[PERSONA: Summarization failure, refer to raw logs.]\nRaw Summary:\n${summary}`;
    }
    
    apiKeyManager.recordUsage(keyPtr.id);
    return summary;
  } catch (err) {
    await apiKeyManager.reportFailure(keyPtr.id);
    throw new Error(`Reflection failed: ${err.message}`);
  }
}

module.exports = { generateReflection };