/**
 * IMAGE SERVICE (REFACTORED)
 * * PREVIOUSLY: Used Stability AI (Deprecated/Removed)
 * CURRENTLY: Routes all requests to Google Vertex AI (via vertexImageService.js)
 * * This ensures strict adherence to the "Google Vertex Only" policy
 * while maintaining compatibility with existing controllers.
 */

const { generateImageVertex, editImageVertex } = require('./vertexImageService');

/**
 * Generates a new image from text.
 * Now strictly uses Google Vertex AI.
 * * @param {string} prompt - The user's description
 * @param {string} apiKey - (Ignored) We use the server-side Service Account now.
 */
async function generateImage(prompt, apiKey = null) {
    console.log("🔄 Routing 'generateImage' request to Google Vertex AI...");
    return await generateImageVertex(prompt);
}

/**
 * Edits an existing image.
 * Now strictly uses Google Vertex AI.
 * * @param {string} imageUrl - URL of the source image
 * @param {string} prompt - Instructions (e.g. "Add a hat")
 * @param {string} searchPrompt - (Ignored) Vertex doesn't need a search mask.
 * @param {string} apiKey - (Ignored)
 */
async function editImage(imageUrl, prompt, searchPrompt = null, apiKey = null) {
    console.log("🔄 Routing 'editImage' request to Google Vertex AI...");
    // We combine the search prompt into the main prompt if it exists, to help context
    const finalPrompt = searchPrompt ? `${prompt} (focus on: ${searchPrompt})` : prompt;
    return await editImageVertex(imageUrl, finalPrompt);
}

module.exports = { generateImage, editImage };