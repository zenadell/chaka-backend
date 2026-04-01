const { VertexAI } = require('@google-cloud/vertexai');
const axios = require('axios');
const FormData = require('form-data');
const sharp = require('sharp');
const https = require('https');
const { exec } = require('child_process');
// We don't use 'dns' module anymore because local resolution is broken. 
// We use HTTP-based DNS (DoH) instead.

// --- CONFIGURATION ---
const CLOUDINARY_CLOUD_NAME = "dvjs45kft";
const CLOUDINARY_UPLOAD_PRESET = "vevapvkv";
const PROJECT_ID = "chakachaka-e672a"; 
const LOCATION = "us-central1"; 
const MODEL_NAME = "gemini-2.5-flash-image"; 

// Initialize Vertex AI
const vertexAI = new VertexAI({ project: PROJECT_ID, location: LOCATION });

// Warmup state
let warmupReady = false;
let warmupInProgress = false;



/**
 * 🌐 HELPER: Resolve IP via DoH (Google + Cloudflare)
 */
async function resolveDoH(hostname) {
    const providers = [
        'https://dns.google/resolve',
        'https://cloudflare-dns.com/dns-query'
    ];

    for (const provider of providers) {
        try {
            const response = await axios.get(provider, {
                params: { name: hostname, type: 'A' },
                headers: { 'Accept': 'application/dns-json' },
                timeout: 3000,
                validateStatus: () => true
            });
            if (response.data?.Answer) {
                const record = response.data.Answer.find(r => r.type === 1);
                if (record) return record.data;
            }
        } catch (e) { /* ignore and try next */ }
    }
    return null;
}

// System curl fallback to bypass container DNS/SSL quirks
function downloadWithCurl(url) {
    return new Promise((resolve, reject) => {
        console.log(`📥 Downloading via System Curl: ${url.substring(0, 80)}...`);
        const command = `curl -L -s --fail -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" --output - "${url}"`;
        exec(command, { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                const errMsg = stderr?.toString() || error.message;
                console.warn(`⚠️ Curl failed: ${errMsg.substring(0, 200)}`);
                return reject(new Error(`Curl download failed: ${errMsg}`));
            }
            if (!stdout || stdout.length === 0) {
                return reject(new Error("Curl returned empty data."));
            }
            console.log(`✅ Curl Success! Downloaded ${stdout.length} bytes.`);
            resolve(stdout);
        });
    });
}

/**
 * 🔄 UTILITY: Strictly Segregated Downloader
 * 1) Cloud storage (Azure/S3/GCS): standard axios, no IP swap, minimal headers
 * 2) Bing: native fetch with browser headers (no IP swap)
 * 3) Everything else (e.g., rework/replit): DoH + direct IP, then curl
 */
async function downloadWithRetry(url, retries = 5) {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;

    const isBing = hostname.includes('bing') || hostname.includes('copilot');
    const isCloudStorage = hostname.includes('blob.core.windows.net') ||
                           hostname.includes('amazonaws.com') ||
                           hostname.includes('googleapis.com') ||
                           hostname.includes('cdn.openai');

    if (isCloudStorage) {
        console.log(`📥 Strategy: Cloud Storage (no IP swap) for ${hostname}`);
        return await downloadStandard(url, retries);
    }

    if (isBing) {
        console.log(`📥 Strategy: Bing fetch for ${hostname}`);
        return await downloadWithFetch(url, retries);
    }

    console.log(`📥 Strategy: DoH/IP for ${hostname}`);
    return await downloadWithDirectIP(url, hostname, retries);
}

// --- WORKER FUNCTIONS ---

async function downloadStandard(url, retries) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: 30000,
                headers: { 'Accept': '*/*' },
                family: 4
            });
            if (res.status === 200) return Buffer.from(res.data);
            throw new Error(`Status ${res.status}`);
        } catch (e) {
            if (i === retries - 1) {
                // Last resort: curl without touching the URL
                try { return await downloadWithCurl(url); } catch (curlErr) { throw curlErr; }
            }
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
        }
    }
}

async function downloadWithFetch(url, retries) {
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.bing.com/'
    };
    for (let i = 0; i < retries; i++) {
        try {
            if (!global.fetch) throw new Error('Native fetch missing');
            const res = await fetch(url, { headers, redirect: 'follow' });
            if (!res.ok) throw new Error(`Fetch status ${res.status}`);
            return Buffer.from(await res.arrayBuffer());
        } catch (e) {
            if (i === retries - 1) {
                try { return await downloadWithCurl(url); } catch (curlErr) { throw curlErr; }
            }
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
        }
    }
}

async function downloadWithDirectIP(url, hostname, retries) {
    let targetUrl = url;
    let httpsAgent = new https.Agent({ rejectUnauthorized: false, servername: hostname });
    const headers = { 'User-Agent': 'Mozilla/5.0', 'Host': hostname };

    const ip = await resolveDoH(hostname);
    if (ip) {
        console.log(`✅ DoH resolved ${hostname} -> ${ip}`);
        targetUrl = url.replace(hostname, ip);
    }

    for (let i = 0; i < retries; i++) {
        try {
            const res = await axios.get(targetUrl, {
                responseType: 'arraybuffer',
                timeout: 30000,
                headers,
                httpsAgent,
                family: 4
            });
            if (res.status === 200) return Buffer.from(res.data);
            throw new Error(`Status ${res.status}`);
        } catch (e) {
            if (ip && i === 0) {
                // First failure after IP swap → try original hostname
                targetUrl = url;
                httpsAgent = new https.Agent({ rejectUnauthorized: false });
                continue;
            }
            if (i === retries - 1) {
                try { return await downloadWithCurl(url); } catch (curlErr) { throw curlErr; }
            }
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
        }
    }
}

/**
 * 🧼 UTILITY: Image Sanitizer
 */
async function sanitizeImageForVertex(inputBuffer) {
    let sharpInstance;
    try {
        console.log("🧼 Sanitizing image format with Sharp...");
        sharpInstance = sharp(inputBuffer)
            .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
            .toFormat('png');
        
        const pngBuffer = await sharpInstance.toBuffer();
        
        return pngBuffer.toString('base64');
    } catch (error) {
        console.error("Sharp processing failed:", error);
        // Force cleanup
        if (sharpInstance) {
            try { sharpInstance.destroy(); } catch (e) { /* ignore */ }
        }
        // Small delay to let native resources release
        await new Promise(r => setTimeout(r, 100));
        throw new Error("Could not process image format.");
    }
}

// --- WARMUP: initialize heavy native modules (sharp) to avoid cold-start failures ---
async function warmup() {
    try {
        console.log('⚡️ vertexImageService warmup: Initializing Sharp...');

        // Warm Sharp
        const tiny = await sharp({
            create: {
                width: 2,
                height: 2,
                channels: 4,
                background: { r: 255, g: 255, b: 255, alpha: 1 }
            }
        }).png().toBuffer();

        const base64 = await sanitizeImageForVertex(tiny);
        if (base64 && base64.length > 0) {
            warmupReady = true;
            console.log('⚡️ vertexImageService warmup: Sharp sanitizer initialized successfully.');
        } else {
            console.warn('⚠️ vertexImageService warmup: sanitizer returned empty result.');
        }
    } catch (e) {
        console.warn('⚠️ vertexImageService warmup failed (non-fatal):', e.message || e);
        throw e;
    }
}

// Ensure warmup has run before handling an edit request (blocking, runs once per process)
async function ensureWarmupReady() {
    if (warmupReady) return;
    if (warmupInProgress) {
        // Wait for in-progress warmup
        while (warmupInProgress) {
            await new Promise(r => setTimeout(r, 50));
        }
        return;
    }
    // Start warmup
    warmupInProgress = true;
    try {
        await warmup();
    } catch (e) {
        console.error('ensureWarmupReady: warmup failed, rethrowing:', e.message);
        throw e;
    } finally {
        warmupInProgress = false;
    }
}

/**
 * 1. GENERATE IMAGE (Text-to-Image)
 */
async function generateImageVertex(prompt) {
    try {
        console.log(`🎨 Generating with Vertex (${MODEL_NAME})...`);
        const generativeModel = vertexAI.getGenerativeModel({ model: MODEL_NAME });

        const request = {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
                responseModalities: ["IMAGE"],
                temperature: 0.4
            }
        };

        // Retry logic for 429 Resource Exhausted
        let response;
        for (let i = 0; i < 3; i++) {
            try {
                response = await generativeModel.generateContent(request);
                break; // Success
            } catch (e) {
                if (e.message.includes('429') || e.message.includes('Resource exhausted')) {
                    console.warn(`⚠️ Vertex 429 (Attempt ${i+1}/3). Retrying in 2s...`);
                    await new Promise(r => setTimeout(r, 2000 * (i + 1)));
                } else {
                    throw e; // Fatal error
                }
            }
        }
        
        if (!response || !response.response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data) {
             throw new Error("Google Vertex returned no image data (or quota exhausted).");
        }
        
        const imageBase64 = response.response.candidates[0].content.parts[0].inlineData.data;
        return await uploadToCloudinary(imageBase64);

    } catch (error) {
        console.error("Vertex Gen Error:", error);
        throw new Error(`Image Generation Failed: ${error.message}`);
    }
}

/**
 * 2. EDIT IMAGE (Inpainting)
 * 🧠 NOW INTELLIGENTLY HANDLES URL vs BASE64
 */
async function editImageVertex(imageUrl, prompt) {
    try {
        // Ensure Sharp/sanitizer is warmed before heavy work
        await ensureWarmupReady();

        console.log(`🎨 Vertex Edit Request: "${prompt}"`);

        // STEP A: INTELLIGENT INPUT PARSING
        let imageBuffer;

        if (!imageUrl) {
            throw new Error("No image source provided.");
        }

        // Check 1: Is it a Data URI? (e.g., data:image/png;base64,...)
        if (typeof imageUrl === 'string' && imageUrl.startsWith('data:image')) {
            console.log("🔹 Input identified as Data URI.");
            imageBuffer = Buffer.from(imageUrl.split(',')[1], 'base64');
        } 
        // Check 2: Is it a Web URL? (http:// or https://)
        else if (typeof imageUrl === 'string' && (imageUrl.startsWith('http://') || imageUrl.startsWith('https://'))) {
            console.log("🔹 Input identified as Web URL.");
            imageBuffer = await downloadWithRetry(imageUrl);
        }
        // Check 3: Is it Raw Base64? (No prefix, just data)
        // Heuristic: No http, no data:, and length > 100
        else if (typeof imageUrl === 'string' && imageUrl.length > 100) {
            console.log("🔹 Input identified as Raw Base64 string. converting directly.");
            try {
                imageBuffer = Buffer.from(imageUrl, 'base64');
            } catch (err) {
                throw new Error("Input string looked like Base64 but failed to parse.");
            }
        }
        else {
            throw new Error("Invalid image source format. Must be URL or Base64.");
        }

        // STEP B: Sanitize
        const cleanBase64 = await sanitizeImageForVertex(imageBuffer);

        // STEP C: Strict Prompt Engineering
        const engineeredPrompt = `${prompt} . Maintain high fidelity, photorealistic style, keep original lighting and composition.`;

        console.log(`🚀 Sending payload to Google Vertex...`);
        const generativeModel = vertexAI.getGenerativeModel({ model: MODEL_NAME });

        const request = {
            contents: [
                { role: 'user', parts: [
                    { text: engineeredPrompt },
                    { inlineData: { mimeType: 'image/png', data: cleanBase64 } }
                ]}
            ],
            generationConfig: {
                responseModalities: ["IMAGE"],
                temperature: 0.4 
            }
        };

        // Retry logic for 429 Resource Exhausted
        let response;
        for (let i = 0; i < 3; i++) {
            try {
                response = await generativeModel.generateContent(request);
                break; // Success
            } catch (e) {
                if (e.message.includes('429') || e.message.includes('Resource exhausted')) {
                    console.warn(`⚠️ Vertex 429 (Attempt ${i+1}/3). Retrying in 2s...`);
                    await new Promise(r => setTimeout(r, 2000 * (i + 1)));
                } else {
                    throw e; // Fatal error
                }
            }
        }
        
        if (!response || !response.response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data) {
             console.error("Vertex Empty Response:", JSON.stringify(response?.response, null, 2));
             throw new Error("The AI returned no image. Try rephrasing.");
        }

        const generatedImageBase64 = response.response.candidates[0].content.parts[0].inlineData.data;
        return await uploadToCloudinary(generatedImageBase64);

    } catch (error) {
        console.error("Vertex Edit Error:", error);
        throw new Error(`Edit Failed: ${error.message}`);
    }
}

// Helper: Cloudinary Upload (Handles Base64 OR Remote URLs)
async function uploadToCloudinary(fileSource) {
    console.log("☁️ Uploading/Proxying via Cloudinary...");
    const url = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`;
    const form = new FormData();
    
    // Cloudinary accepts a remote URL string OR a Base64 data URI
    if (typeof fileSource === 'string' && fileSource.startsWith('http')) {
        form.append('file', fileSource);
    } else {
        // Assume raw base64 or data URI
        const payload = fileSource.startsWith('data:') ? fileSource : `data:image/png;base64,${fileSource}`;
        form.append('file', payload);
    }
    
    form.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
    
    // We also use the agent here just in case Cloudinary has handshake issues
    const httpsAgent = new https.Agent({ rejectUnauthorized: false });
    
    try {
        const res = await axios.post(url, form, { 
            headers: form.getHeaders(),
            httpsAgent: httpsAgent,
            timeout: 60000  // Give Cloudinary time to fetch remote files
        });
        
        const imageUrl = res.data.secure_url;
        console.log("✅ Cloudinary operation successful:", imageUrl);
        return imageUrl;
    } catch (e) {
        console.error("Cloudinary Upload Failed:", e.response?.data || e.message);
        throw new Error(`Cloudinary Proxy Failed: ${e.message}`);
    }
}

module.exports = { generateImageVertex, editImageVertex, ensureWarmupReady, warmup, uploadToCloudinary, downloadWithRetry };

// --- WARMUP: initialize heavy native modules (sharp) to avoid cold-start failures ---
async function warmup() {
    try {
        console.log('⚡️ vertexImageService warmup: Initializing Sharp and internal helpers...');
        // Create a tiny 2x2 PNG in memory to exercise sharp and our sanitizer
        const tiny = await sharp({
            create: {
                width: 2,
                height: 2,
                channels: 4,
                background: { r: 255, g: 255, b: 255, alpha: 1 }
            }
        }).png().toBuffer();

        // Call sanitizeImageForVertex to force the image pipeline to initialize
        const base64 = await sanitizeImageForVertex(tiny);
        if (base64 && base64.length > 0) {
            console.log('⚡️ vertexImageService warmup: Sharp sanitizer initialized successfully.');
        } else {
            console.warn('⚠️ vertexImageService warmup: sanitizer returned empty result.');
        }
    } catch (e) {
        console.warn('⚠️ vertexImageService warmup failed (non-fatal):', e.message || e);
    }
}

module.exports.warmup = warmup;