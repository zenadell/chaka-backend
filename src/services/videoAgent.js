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

// ── YouTube cookie auth ──────────────────────────────────────────────────────
// YouTube's bot-check ("Sign in to confirm you're not a bot") gates ALL yt-dlp
// extraction (video AND captions) from datacenter/cloud IPs at the metadata
// step — no player-client trick bypasses it. It genuinely requires an
// authenticated session. Cookies are configured ONCE on the server and apply
// to every user automatically; no end user ever touches this.
//
// Source priority (first match wins), all writable-temp-copied so yt-dlp can
// refresh session cookies back to the file without hitting read-only errors:
//   1. Render Secret File at /etc/secrets/youtube-cookies.txt  (RECOMMENDED —
//      preserves the tab-delimited Netscape format exactly, unlike env vars)
//   2. YOUTUBE_COOKIES env var (raw cookies.txt content)
//   3. Local ./youtube-cookies.txt in project root (dev convenience, gitignored)
let _cookiesFilePath = null;
let _cookiesFileChecked = false;
function getCookiesFilePath() {
    if (_cookiesFileChecked) return _cookiesFilePath;
    _cookiesFileChecked = true;
    const writableCopy = (contents) => {
        const p = path.join(os.tmpdir(), 'chaka-youtube-cookies.txt');
        fs.writeFileSync(p, contents, 'utf8');
        return p;
    };
    try {
        const secretPath = '/etc/secrets/youtube-cookies.txt';
        const raw = process.env.YOUTUBE_COOKIES;
        const localPath = path.join(__dirname, '..', '..', 'youtube-cookies.txt');

        if (fs.existsSync(secretPath)) {
            _cookiesFilePath = writableCopy(fs.readFileSync(secretPath, 'utf8'));
            console.log('✅ VideoAgent: YouTube cookies loaded from Render secret file.');
        } else if (raw && raw.trim()) {
            _cookiesFilePath = writableCopy(raw);
            console.log('✅ VideoAgent: YouTube cookies loaded from YOUTUBE_COOKIES env var.');
        } else if (fs.existsSync(localPath)) {
            _cookiesFilePath = writableCopy(fs.readFileSync(localPath, 'utf8'));
            console.log('✅ VideoAgent: YouTube cookies loaded from local youtube-cookies.txt.');
        } else {
            console.warn('⚠️  VideoAgent: no YouTube cookies configured — YouTube will fail with "Sign in to confirm you\'re not a bot" on cloud IPs (other platforms unaffected).');
        }
    } catch (e) {
        console.warn('⚠️  VideoAgent: failed to set up YouTube cookies file:', e.message);
    }
    return _cookiesFilePath;
}

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
        const cookiesPath = getCookiesFilePath();
        const args = [
            '--use-extractors', 'default,-generic',
            // YouTube specifically requires a proof-of-origin token from its
            // default web client, which cloud/datacenter IPs (Render, AWS, etc.)
            // routinely fail to satisfy — showing up as a plain download failure
            // with no useful message. The android client isn't gated the same
            // way, so we ask for it first and let yt-dlp fall back to web for
            // every other site (this arg is a no-op for non-YouTube extractors).
            '--extractor-args', 'youtube:player_client=android,web',
            ...(cookiesPath ? ['--cookies', cookiesPath] : []),
            '-f', 'worst[ext=mp4]/lowest[ext=mp4]/best[ext=mp4]',
            '--max-filesize', '50M',
            '-o', tempFilePath,
            url
        ];

        // Ensure we don't leave zombie processes running forever (e.g. infinite loop livestreams)
        const dlProcess = execFile(YTDLP_PATH, args, { timeout: 60000 }, (error, stdout, stderr) => {
            if (error) {
                const detail = String(stderr || error.message || '').trim().split('\n').slice(-3).join(' | ').slice(0, 300);
                console.error(`❌ VideoAgent Download Error (might be timeout or restriction):`, stderr || error.message);
                return reject(new Error(`VideoAgent failed to fetch. It may be restricted, live, or too large. [${detail}]`));
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
 * Strips VTT formatting down to plain spoken text (drops cue numbers,
 * timestamps, and inline <00:00:01.000> tags).
 */
function vttToPlainText(vtt) {
    const stripTags = (s) => s.replace(/<[^>]+>/g, '');

    // YouTube's auto-caption VTT uses a "rolling" format: each cue block
    // shows [previous stabilized line, new growing line], so the SAME line
    // reappears across several consecutive cues before scrolling off. Taking
    // just the last text line of each cue block, then collapsing consecutive
    // duplicates, reconstructs the real spoken sequence without repetition.
    const blocks = vtt.split(/\r?\n\r?\n+/);
    const lastLines = [];
    for (const block of blocks) {
        const rawLines = block.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const textLines = rawLines.filter(l =>
            !l.includes('-->') && l !== 'WEBVTT' && !l.startsWith('Kind:') && !l.startsWith('Language:') && !l.startsWith('NOTE')
        );
        if (!textLines.length) continue;
        const last = stripTags(textLines[textLines.length - 1]).trim();
        if (last) lastLines.push(last);
    }

    const deduped = [];
    for (const line of lastLines) {
        if (deduped.length === 0 || deduped[deduped.length - 1] !== line) deduped.push(line);
    }
    return deduped.join(' ')
        .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ').trim();
}

/**
 * Caption-only fallback for when full video download is blocked (YouTube's
 * "Sign in to confirm you're not a bot" wall on cloud IPs). Fetching just the
 * caption track + metadata is a much lighter request than streaming the
 * actual video file and isn't subject to the same gate, so this needs no
 * cookies or user action — it's what most AI products do for YouTube anyway
 * (transcript-based summary rather than literal frame-by-frame viewing).
 */
async function fetchCaptionsOnly(url) {
    await ensureYtDlp();
    const tmpDir = path.join(os.tmpdir(), `chaka_cap_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const cookiesPath = getCookiesFilePath();
    const args = [
        '--use-extractors', 'default,-generic',
        '--extractor-args', 'youtube:player_client=android,web',
        ...(cookiesPath ? ['--cookies', cookiesPath] : []),
        '--skip-download',
        '--write-auto-sub', '--write-sub',
        '--sub-lang', 'en.*,en',
        '--sub-format', 'vtt',
        '--print', 'after_move:%(title)s|||%(description)s',
        '-o', path.join(tmpDir, 'media'),
        url
    ];
    return new Promise((resolve, reject) => {
        execFile(YTDLP_PATH, args, { timeout: 30000 }, (error, stdout, stderr) => {
            let title = '', description = '', transcript = '';
            try {
                const printedLine = (stdout || '').trim().split('\n').filter(Boolean).pop() || '';
                const parts = printedLine.split('|||');
                if (parts.length === 2) { [title, description] = parts; }
                const vttFiles = fs.readdirSync(tmpDir).filter(f => f.endsWith('.vtt'));
                if (vttFiles.length) {
                    transcript = vttToPlainText(fs.readFileSync(path.join(tmpDir, vttFiles[0]), 'utf8'));
                }
            } catch {}
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

            if (!transcript) {
                const detail = String(stderr || error?.message || 'no captions available').trim().split('\n').slice(-2).join(' | ').slice(0, 200);
                return reject(new Error(`No captions available. [${detail}]`));
            }
            resolve({ title, description, transcript: transcript.slice(0, 50000) });
        });
    });
}

/**
 * Fast, no-download check: does yt-dlp actually recognize this URL as
 * extractable media? yt-dlp maintains its own extractor list for 1800+
 * sites (YouTube, TikTok, Twitter/X, Instagram, Vimeo, Reddit, etc.) plus a
 * generic direct-file fallback, so this is far more accurate than any
 * domain/regex check we could write ourselves — and it costs a couple of
 * seconds instead of a full download.
 */
async function probeVideo(url, timeoutMs = 8000) {
    try {
        await ensureYtDlp();
    } catch {
        return false;
    }
    return new Promise((resolve) => {
        // --use-extractors default,-generic is the key flag here: it keeps every
        // named site extractor (YouTube, TikTok, Twitter/X, Instagram, Vimeo,
        // Reddit, etc. — matched almost instantly via yt-dlp's own URL regexes)
        // but disables yt-dlp's "generic" fallback, which otherwise fetches and
        // parses the full page looking for embedded media. Without this, every
        // plain webpage (github.com, example.com, ...) took 15s+ to be correctly
        // rejected instead of ~0.4s — unacceptable when this probe runs on every
        // single browse/scrape call.
        const cookiesPath = getCookiesFilePath();
        const probeArgs = [
            '--use-extractors', 'default,-generic',
            '--extractor-args', 'youtube:player_client=android,web',
            ...(cookiesPath ? ['--cookies', cookiesPath] : []),
            '--no-warnings', '--skip-download', '--print', 'id', url
        ];
        execFile(YTDLP_PATH, probeArgs, { timeout: timeoutMs }, (error, stdout) => {
            resolve(!error && !!stdout && !!stdout.trim());
        });
    });
}

/**
 * Best-effort video pipeline. Probes first so we never spend time downloading
 * a page that isn't actually a video, and NEVER throws — callers should treat
 * a null return as "this isn't a video, fall back to normal handling"
 * rather than as an error. This is what lets any URL (YouTube, TikTok,
 * Twitter/X, Instagram, a raw .mp4 link, etc.) be handled the same way
 * without us ever having to classify it ourselves.
 */
async function tryProcessVideo(url) {
    try {
        const isVideo = await probeVideo(url);
        if (!isVideo) return null;
        return await processVideo(url);
    } catch (e) {
        console.warn(`[VideoAgent] tryProcessVideo: treating as non-video (${e.message})`);
        return null;
    }
}

/**
 * Main VideoAgent Pipeline
 */
async function processVideo(url) {
    const keyInfo = apiKeyManager.getCurrentKey();
    // Throw (not return a string) so callers — especially tryProcessVideo's
    // truthy-return check — can't mistake this failure message for real
    // analysis content.
    if (!keyInfo) throw new Error('Video processing failed. No API Key available.');

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

        // When the full video download fails on YouTube — whether from the
        // bot-check ("sign in to confirm you're not a bot") OR the n-challenge
        // ("challenge solving failed" / "formats may be missing", which needs a
        // JS runtime the server lacks) — fall back to captions + metadata.
        // Captions come from a separate timedtext endpoint that doesn't go
        // through the streaming-format n-challenge, so they succeed where the
        // video stream doesn't. No visual analysis, but a real, honest answer
        // (title + description + full transcript) instead of nothing.
        const isYouTube = /youtube\.com|youtu\.be/i.test(url);
        const captionsWorthTrying = isYouTube || /sign in to confirm|not a bot|challenge solving failed|formats may be missing|requested format is not available|only images are available/i.test(e.message);
        if (captionsWorthTrying) {
            try {
                console.warn('[VideoAgent] Full video failed — falling back to captions-only.');
                const { title, description, transcript } = await fetchCaptionsOnly(url);
                return `Video title: ${title}\n\nDescription: ${description}\n\nTranscript:\n${transcript}`;
            } catch (capErr) {
                console.error('[VideoAgent] Captions fallback also failed:', capErr.message);
                throw new Error(e.message);
            }
        }

        throw new Error(e.message);
    }
}

module.exports = { processVideo, probeVideo, tryProcessVideo };
