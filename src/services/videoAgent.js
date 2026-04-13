const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const axios = require('axios');
const { GoogleAIFileManager } = require("@google/generative-ai/server");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const apiKeyManager = require('../utils/apiKeyManager');

const BIN_DIR = path.join(__dirname, '..', 'bin');
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
        return; 
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
            writer.on('error', err => reject(err));
            writer.on('finish', () => resolve(true));
        });

        fs.chmodSync(YTDLP_PATH, 0o755);
        console.log(`✅ VideoAgent: yt-dlp installed.`);
    } catch (e) {
        console.error("❌ VideoAgent Failed to download yt-dlp:", e.message);
        throw new Error("Could not initialize VideoAgent because yt-dlp failed to download.");
    }
}

/**
 * Downloads a video using yt-dlp and saves it to a temporal path
 */
async function downloadVideo(url, tempFilePath) {
    console.log(`⬇️ VideoAgent: Fetching Media from ${url} ...`);
    return new Promise((resolve, reject) => {
        // -f "worst" selects the lowest quality pre-merged format (video+audio embedded),
        // guaranteeing lightning-fast downloads and completely removing the need for ffmpeg to merge streams.
        // It's perfectly fine for Gemini to "see" what's happening.
        // --max-filesize 50M ensures we do not download ultra-huge files.
        const args = [
            '-f', 'worst[ext=mp4]/lowest[ext=mp4]/best[ext=mp4]',
            '--max-filesize', '50M',
            '-o', tempFilePath,
            url
        ];

        // Ensure we don't leave zombie processes running forever (e.g. infinite loop livestreams)
        const dlProcess = execFile(YTDLP_PATH, args, { timeout: 60000 }, (error, stdout, stderr) => {
            if (error) {
                console.error(`❌ VideoAgent Download Error (might be timeout or restriction):`, stderr || error.message);
                return reject(new Error("VideoAgent failed to fetch. It may be restricted, live, or too large."));
            }
            if (!fs.existsSync(tempFilePath)) {
                return reject(new Error("File was not fully downloaded by yt-dlp"));
            }
            console.log(`✅ VideoAgent: Download complete -> ${tempFilePath}`);
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

        const fileManager = getFileManager(keyInfo.key);
        const genAI = getGenAI(keyInfo.key);
        // CRITICAL FIX: Reverting to gemini-2.5-flash to completely eliminate the severe API rate-limiting 
        // and sluggishness caused by 1.5-pro globally starving all other queries sharing the key.
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        console.log("☁️ VideoAgent: Uploading Video...");
        const uploadResult = await fileManager.uploadFile(tempFilePath, {
            mimeType: "video/mp4",
            displayName: "Chaka Short Media"
        });

        // Cleanup local immediately after upload
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);

        console.log(`⏳ VideoAgent: Analyzing...`);
        let fileInfo = await fileManager.getFile(uploadResult.file.name);
        
        let attempts = 0;
        // Limit processing wait loops to 15 (approx 45 seconds total)
        while (fileInfo.state === "PROCESSING" && attempts < 15) {
            attempts++;
            await new Promise((resolve) => setTimeout(resolve, 3000));
            fileInfo = await fileManager.getFile(uploadResult.file.name);
        }

        if (fileInfo.state === "FAILED" || fileInfo.state === "PROCESSING") {
            throw new Error(fileInfo.state === "FAILED" ? "Google's internal video processing failed." : "Video inspection timed out.");
        }

        const promptText = `
Watch the attached video quickly.
Provide a clear scene-by-scene summary of visual events, and provide a text transcript of spoken audio. 
Keep it very clear and informative.
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

        console.log("✅ VideoAgent: Finished inspection.");
        return result.response.text();

    } catch (e) {
        console.error("❌ VideoAgent Error Pipeline:", e.message);
        if (fs.existsSync(tempFilePath)) {
            try { fs.unlinkSync(tempFilePath); } catch (err) {}
        }
        throw new Error(e.message);
    }
}

module.exports = { processVideo };
