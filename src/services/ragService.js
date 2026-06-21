const { exec } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const util = require('util');
const os = require('os');
const crypto = require('crypto');
const execPromise = util.promisify(exec);

/**
 * Uses Microsoft's MarkItDown to convert a file (PDF, PPTX, DOCX, etc.) to clean Markdown.
 * @param {string} filePath - Absolute path to the file.
 * @returns {Promise<string>} - The extracted Markdown text.
 */
async function parseDocument(filePath) {
  try {
    // markitdown <filename> outputs markdown to stdout
    const { stdout, stderr } = await execPromise(`python3 -m markitdown "${filePath}"`);
    if (stderr && stderr.toLowerCase().includes('error')) {
      console.warn('[RAG] MarkItDown warning/error:', stderr);
    }
    return stdout;
  } catch (err) {
    console.error('[RAG] Failed to parse document with MarkItDown:', err.message);
    throw new Error('Failed to extract text from document.');
  }
}

/**
 * Uses Graphify to build a Knowledge Graph from a directory of files (e.g. workspace or extracted history).
 * @param {string} dirPath - Directory containing the files to graph.
 * @returns {Promise<string>} - Path to the generated graphify-out directory.
 */
async function buildGraph(dirPath) {
  try {
    console.log(`[RAG] Running graphify on ${dirPath}...`);
    // graphifyy .
    // Note: ensure pip binaries are in PATH, or use python3 -m graphifyy if it supports it
    let command = `graphifyy "${dirPath}"`;
    
    // We execute it inside the target directory to ensure graphify-out is created there
    const { stdout, stderr } = await execPromise(command, { cwd: dirPath });
    
    console.log('[RAG] Graphify output:', stdout);
    
    const outDir = path.join(dirPath, 'graphify-out');
    
    // Verify it was created
    try {
      const stats = await fs.stat(outDir);
      if (stats.isDirectory()) {
        return outDir;
      }
    } catch (e) {
      console.warn('[RAG] graphify-out not found after run. It may have failed silently or output elsewhere.');
    }
    
    return outDir;
  } catch (err) {
    console.error('[RAG] Failed to build graph with Graphify:', err.message);
    throw new Error('Failed to generate Knowledge Graph.');
  }
}

/**
 * Dummy function for querying the graph (to be expanded once we inspect graphify-out structure)
 */
async function queryGraph(graphDir, query) {
  // TODO: Read graphify-out files (like entities.json, edges.json) and search for facts related to query.
  // For now, we just return a placeholder.
  return `[RAG] Retrieved context for: ${query}`;
}

/**
 * Scans chat contents for heavy documents (PDF, DOCX, etc.), extracts text using MarkItDown,
 * and replaces the base64 inlineData with the extracted Markdown text.
 */
async function processChatContentsForRAG(contents) {
  for (const msg of contents) {
    if (!msg.parts) continue;
    
    for (let i = 0; i < msg.parts.length; i++) {
      const part = msg.parts[i];
      if (part.inlineData && part.inlineData.mimeType) {
        const mime = part.inlineData.mimeType.toLowerCase();
        // Skip images as Gemini handles them natively
        if (mime.startsWith('image/')) continue;
        
        // It's a document! Let's extract it.
        try {
          console.log(`[RAG] Intercepted document with mimeType: ${mime}. Processing with MarkItDown...`);
          const ext = mime.includes('pdf') ? '.pdf' : mime.includes('word') ? '.docx' : mime.includes('powerpoint') || mime.includes('presentation') ? '.pptx' : '.txt';
          const tempFileName = `rag_doc_${crypto.randomUUID()}${ext}`;
          const tempFilePath = path.join(os.tmpdir(), tempFileName);
          
          // Write base64 to temp file
          const buffer = Buffer.from(part.inlineData.data, 'base64');
          await fs.writeFile(tempFilePath, buffer);
          
          // Parse with MarkItDown
          const markdown = await parseDocument(tempFilePath);
          
          // Cleanup temp file
          await fs.unlink(tempFilePath).catch(() => {});
          
          // Replace inlineData with text
          msg.parts[i] = { text: `\n[Extracted Document Content]:\n${markdown}\n` };
          console.log(`[RAG] Successfully extracted ${markdown.length} characters.`);
          
        } catch (err) {
          console.error(`[RAG] Failed to process document: ${err.message}`);
          // Fallback: tell the LLM it failed
          msg.parts[i] = { text: `\n[System: The user uploaded a document but text extraction failed.]\n` };
        }
      }
    }
  }
}

module.exports = {
  parseDocument,
  buildGraph,
  queryGraph,
  processChatContentsForRAG
};
