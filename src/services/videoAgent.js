const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const axios = require('axios');
const { GoogleAIFileManager } = require("@google/generative-ai/server");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const apiKeyManager = require('../utils/apiKeyManager');

const BIN_DIR = path.join(__dirname, '..', 'bin');
// Use the macos build if on darwin, otherwise the standard linux binary (we assume linux on hostinger)
const YTDLP_BINARY_NAME = process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp';
const YTDLP_PATH = path.join(BIN_DIR, 'yt-dlp'); 

/**
 * Ensures yt-dlp is downloaded and executable.
 */
async function ensureYtDlp() {
    if (!fs.existsSync(BIN_DIR)) {
        fs.mkdirSync(BIN_DIR, { recursive: true });
    }

    if (fs.existsSync(YTDLP_PATH)) {
        return; // Already installed
    }

    console.log(`⬇️ VideoAgent: Downloading yt-dlp binary for ${process.platform}...`);
    const releaseUrl = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP_BINARY_NAME}`;
    
    try {
        const response = await axios({
            url: releaseUrl,
            method: 'GET',
            responseType: 'stream'
        });

        const writer = fs.createWriteStream(YTDLP_PATH);
        
        await new Promise((resolve, reject) => {
            response.data.pipe(writer);
            let error = null;
            writer.on('error', err => {
                error = err;
                writer.close();
                reject(err);
            });
            writer.on('close', () => {
                if (!error) resolve(true);
            });
        });

        // Make executable
        fs.chmodSync(YTDLP_PATH, 0o755);
        console.log(`✅ VideoAgent: yt-dlp perfectly installed.`);
    } catch (e) {
        console.error("❌ VideoAgent Failed to download yt-dlp:", e.message);
        throw new Error("Could not initialize VideoAgent because yt-dlp failed to download.");
    }
}

/**
 * Downloads a video using yt-dlp and saves it to a temporal path
 */
async function downloadVideo(url, tempFilePath) {
    console.log(`⬇️ VideoAgent: Downloading Media from ${url} ...`);
    return new Promise((resolve, reject) => {
        // -f "best[height<=480]" gets a reasonably small size, perfect for AI vision
        // --merge-output-format mp4 ensures it's an mp4 container.
        const args = [
            '-f', 'bestvideo[ext=mp4][height<=480]+bestaudio[ext=m4a]/best[ext=mp4][height<=480]/best',
            '--merge-output-format', 'mp4',
            '-o', tempFilePath,
            url
        ];

        execFile(YTDLP_PATH, args, (error, stdout, stderr) => {
            if (error) {
                console.error(`❌ VideoAgent Download Error:`, stderr);
                return reject(new Error("VideoAgent failed to download the requested media. It might be private or age-restricted."));
            }
            console.log(`✅ VideoAgent: Media completely downloaded to ${tempFilePath}`);
            resolve(tempFilePath);
        });
    });
}

function getFileManager(apiKey) { return new GoogleAIFileManager(apiKey); }
function getGenAI(apiKey) { return new GoogleGenerativeAI(apiKey); }

/**
 * Main VideoAgent Pipeline
 */
async function processVideo(url) {
    const keyInfo = apiKeyManager.getCurrentKey(); 
    if (!keyInfo) return "[SYSTEM_INFO: Video processing failed. No API Key available.]";

    await ensureYtDlp();

    const tempFilePath = path.join(os.tmpdir(), `chaka_video_${Date.now()}.mp4`);
    
    try {
        await downloadVideo(url, tempFilePath);

        if (!fs.existsSync(tempFilePath)) {
            throw new Error("Download failed, temporal file not found.");
        }

        const fileManager = getFileManager(keyInfo.key);
        const genAI = getGenAI(keyInfo.key);
        // Using Gemini 1.5 Pro to better extract detailed transcripts and visual events systematically
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

        console.log("☁️ VideoAgent: Uploading Video to Gemini...");
        const uploadResult = await fileManager.uploadFile(tempFilePath, {
            mimeType: "video/mp4",
            displayName: "Chaka Video Media"
        });

        console.log(`✅ VideoAgent: Uploaded successfully. Waiting for AI Processing to spin up...`);
        
        let fileInfo = await fileManager.getFile(uploadResult.file.name);
        while (fileInfo.state === "PROCESSING") {
            process.stdout.write(".");
            await new Promise((resolve) => setTimeout(resolve, 5000));
            fileInfo = await fileManager.getFile(uploadResult.file.name);
        }
        console.log(""); // newline after dots

        if (fileInfo.state === "FAILED") {
            throw new Error("Video processing fundamentally failed inside Google's systems.");
        }

        console.log("🧠 VideoAgent: Extracting Audio and Systematically analyzing frames...");
        const promptText = `
You are an advanced Video Agent. Analyze the attached video thoroughly.
1. Provide a precise frame-by-frame or scene-by-scene analysis of the visual elements (what happens, the setting, text on screen).
2. Afterwards, provide a complete and accurate verbatim transcript of any spoken words or significant audio events.
Be extremely detailed.
`;
        
        const result = await model.generateContent([
            promptText,
            {
                fileData: {
                    fileUri: uploadResult.file.uri,
                    mimeType: uploadResult.file.mimeType,
                },
            },
        ]);

        // Cleanup temp file autonomously
        if (fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
        }

        console.log("✅ VideoAgent: Analysis completely successful.");
        return result.response.text();

    } catch (e) {
        console.error("❌ VideoAgent Error Pipeline:", e.message);
        if (fs.existsSync(tempFilePath)) {
            // Failsafe Cleanup
            try { fs.unlinkSync(tempFilePath); } catch (err) {}
        }
        return `[SYSTEM_INFO: The VideoAgent encountered an error while trying to process this media: ${e.message}]`;
    }
}

module.exports = { processVideo };
