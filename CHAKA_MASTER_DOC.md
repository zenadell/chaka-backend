# 🧠 The Chaka AI Documentation: Master Manual

> [!IMPORTANT]
> This document is the definitive source of truth for the **Chaka AI Platform**. It covers architectural philosophy, functional specifications, and deep technical implementation details for both the backend and frontend ecosystems.

---

## 1. Executive Summary & Identity

### 1.1 The Vision
Chaka is not just an AI chatbot; she is an **Autonomous Multimodal Intelligence** designed to be the ultimate personal assistant. Created by **Templeton** (`@un_seen_me` / `timtemple2024@gmail.com`), Chaka represents a leap toward "Emotional Intelligence" in AI, combining real-time voice interaction with a sophisticated memory and tool-use system.

### 1.2 Core Attributes
- **Name**: CHAKA
- **Creator**: Templeton (Temple AI Systems)
- **Primary Goal**: To assist, research, learn, and evolve alongside her users.
- **Personality**: Expressive, friendly, yet highly professional and capable.

---

## 2. Technical Infrastructure (Backend)

The Chaka backend is a high-performance **Node.js/Express** application architected for durability, real-time readiness, and "Warm Performance."

### 2.1 The "Warm" Strategy
Unlike traditional backends that start cold, Chaka uses an aggressive **Warmup Pipeline** during the blocking startup phase:
- **DNS Pre-warming**: Resolves critical domains (Cloudinary, Google API, Rework) to shave milliseconds off the first external request.
- **Sharp & Sanitizer Warmup**: Pre-initializes image processing libraries to prevent "first-run" lag in image editing tasks.
- **Keep-Alive Pulse**: Pings the **Turso Database** every 45 seconds and the server itself every 10 minutes to prevent resource idling on hosters like Render or Railway.

### 2.2 Core Technologies
- **Runtime**: Node.js v18+
- **Database**: **Turso (SQLite)** – Chosen for its edge-ready distributed architecture and low-latency SQLite compatibility.
- **Auth**: **Firebase Admin** – Handles secure token verification and user state syncing.
- **Real-time**: **Socket.io** & Native WebSocket Proxy for multimodal streaming.

### 2.3 AI Orchestration Deep-Dive
Chaka utilizes a multi-model strategy to balance speed and power:

| Capacity | Model | Purpose |
| :--- | :--- | :--- |
| **Live Interaction** | `gemini-2.5-flash-native-audio` | Real-time voice/visual interaction via WebSocket. |
| **Reasoning & Chat** | `gemini-2.0-flash` | General conversation, research, and logic. |
| **Visual Analysis** | `gemini-2.0-flash` | Multimodal input/image inspection. |
| **Image Generation** | `Vertex AI (Imagen 3)` | High-quality image creation via Google Cloud. |
| **Transcription** | `OpenAI Whisper (Large-v3)` | Near-perfect audio-to-text conversion. |
| **TTS** | `ElevenLabs / Multimodal` | High-fidelity voice output with persona-sync. |

### 2.4 API Key Management (`ApiKeyManager`)
Chaka features a robust key rotation system that prevents service interruption:
- **Multi-Type Support**: Handles specific keys for `text`, `search`, `tavily`, `firecrawl`, `tts`, and `multimodal-live`.
- **Automatic Rotation**: Switches to the next available key upon failure or rate-limit detection.
- **Usage Tracking**: Monitors "Heartbeat" usage to ensure keys are healthily distributed.

---

## 3. Frontend Architecture & UI/UX

Chaka's frontend is a lightweight, responsive, and visually stunning web application built on the principle of **High Aesthetic Performance**.

### 3.1 Design Philosophy: "Neon HUD"
The UI follows a modern **Glassmorphism / Futuristic HUD** aesthetic:
- **Responsive Layout**: Seamlessly transitions between desktop "Wide HUD" and mobile "Chat Focus."
- **Micro-Animations**: All interactive elements (buttons, inputs, avatars) feature subtle GSAP-driven transitions.
- **Dynamic Themes**: Supports both optimized Dark and Light modes, with theme persistence across sessions.

### 3.2 The "Expressive Face" HUD (`liveMode.js`)
One of Chaka's standout features is the **Interactive Face Visualizer**, implemented via a high-performance HTML5 Canvas:
- **6 Emotional States**: Neutral, Happy, Sad, Angry, Surprised, and Thinking.
- **Gaze Tracking**: The eyes follow the user's cursor or touch points in real-time using smooth interpolation.
- **Blink Engine**: Randomized natural blinking to simulate lifelike behavior.
- **Micro-saccades**: High-frequency, small-magnitude eye movements to prevent a "staring" effect.
- **Vibrant Color Palettes**: Each emotion triggers a specific HSL color shift (e.g., Toxic Red for Angry, Electric Blue for Sad).

### 3.3 Hybrid RAG Orchestration (`rag_worker.js`)
Chaka implements a sophisticated **Retrieval-Augmented Generation** pattern directly in the browser:
- **Web Worker Architecture**: Vector embeddings and cosine similarity math are offloaded to a background worker to ensure the UI remains running at 60fps.
- **Double-Layer Retrieval**:
  1. **Primary**: Local Vector Cache using IndexedDB (for instant recall).
  2. **Backup**: Cloud Persistence via Turso Vector Chunks (for cross-device memory).
- **Smart Chunking**: Text is split respecting sentence boundaries and semantic overlaps to maximize context quality for the Gemini model.

### 3.4 Key Components
- **`script25.js`**: Total orchestrator handling Firebase Auth, Turso client interactions, and Main Chat UI logic.
- **`tursoClient.js`**: Specialized library for secure, authenticated communication with the backend DB.
- **`val.html` / `cklive.html`**: Specialized immersive scenes for specific modes (Birthday, Valentine's, Live).

---

## 4. AI & Advanced Capabilities

### 4.1 Multimodal Live Mode
The crown jewel of the Chaka platform is **Live Mode**, which enables low-latency, real-time voice and vision interaction.

#### 4.1.1 WebSocket Handshake & Proxy
- **Protocol**: Chaka uses a WebSocket proxy (`/api/live/stream`) to securely bridge the frontend to Google's **Multimodal Live API**.
- **Audio Specs**: 16kHz, single-channel PCM audio chunks are sent at high frequency to ensure minimal lag.
- **Interruption Logic**: The backend detects "Interruption" signals from the server, immediately dumping the audio queue on the frontend to allow the user to speak over Chaka naturally.

#### 4.1.2 Predictive Emotional Intelligence
While the LLM produces thoughts, Chaka uses a **Parallel Emotion Capture** system:
1. **Model Thoughts**: Chaka analyzes her own "internal reasoning" to select an emotion.
2. **User Speech Analysis**: The frontend uses the **Web Speech API** to transcribe user speech in parallel, predicting Chaka's emotional response (e.g., if the user says something sad, Chaka's eyes shift to a "Sad" state before she even starts generating a response).

### 4.2 VideoAgent: The Visual Researcher
Chaka can "watch" videos to help users understand visual content:
- **Engine**: **`yt-dlp`** (dynamic binary) downloads the video in the lowest quality (for speed).
- **Processing**: The video is uploaded to Google's GenAI File Manager.
- **Analysis**: **`gemini-2.5-flash`** (optimized for speed/cost) performs a "Short Media Inspection," providing scene-by-scene summaries and audio transcripts.

### 4.3 Deep Scrape & Web Research
For research tasks, Chaka utilizes a tiered approach:
- **Tier 1 (Surface)**: Serper.dev / Google Search for quick facts.
- **Tier 2 (Advanced)**: **Tavily Search** for structured, research-ready data.
- **Tier 3 (Deep)**: **Firecrawl** integration for bypassing captchas and scraping sites that block standard bots (e.g., restricted documentation sites).

### 4.4 Image Generation & Editing
Chaka leverages **Google Vertex AI (Imagen 3)** for high-fidelity visual creativity:
- **Generation**: Creates images from scratch based on user prompts.
- **Creative Edit**: Uses the "Inpainting" capability to modify existing images based on natural language instructions.
- **Auto-Warmup**: The system pre-warms the Vertex AI client and Sharp image headers during boot to ensure the first image request is as fast as the hundredth.

---

## 5. Memory System: The AI Soul

Chaka doesn't just "remember" text; she builds a structured cognitive model of her users to ensure every interaction feels personal and continuous.

### 5.1 Episodic Memory (Moments)
- **Definition**: Every interaction, thought, and emotion is logged as an "Episode."
- **Storage**: Turso `memories` table.
- **Context**: Episodes include `topic`, `emotion`, and `timestamp`.
- **Status**: Memories can be `ACTIVE` or `ARCHIVED` (if replaced by a newer/corrected memory).

### 5.2 Semantic Memory (Identity)
- **Definition**: A high-level, distilled summary of "Who the user is."
- **Storage**: `users` table (`semanticMemory` field).
- **Function**: This serves as the permanent context injected into every conversation, allowing Chaka to remember long-term goals, preferences, and complex relationships without re-reading thousands of chat logs.

### 5.3 The Reflection Process (Dreaming)
To prevent "Memory Bloat," Chaka uses an autonomous background process called **Reflection**:
1. **Trigger**: Manually or via time-based check (typically when new memories exceed a threshold).
2. **Analysis**: Chaka reviews up to 50 recent `ACTIVE` memories.
3. **Consolidation**: A dedicated AI model (Gemini Flash) synthesizes these episodes into a new, updated `semanticMemory`.
4. **Pruning**: Redundant or outdated information is distilled, while core facts are preserved.

### 5.4 Self-Correction & Update Loop
Chaka is designed to be self-improving:
- **Correction Handling**: If a user corrects a fact, the system creates a new memory and updates the `replacedBy` field of the old memory, ensuring Chaka doesn't hold conflicting information.
- **Open Loops**: Chaka identifies "unfinished business" (Open Loops) during her thought process.

### 5.5 Proactive Interaction (`loopManager.js`)
Unlike passive bots, Chaka can initiate contact:
- **Proactive Follow-ups**: If Chaka detects an "Open Loop" (e.g., a user mentioned a job interview tomorrow), she can proactively ask how it went after a certain period of inactivity has passed.

---

## 6. Data Schema & Tool Ecosystem

### 6.1 Turso Database Schema
Chaka's data architecture is centralized in Turso. Below is the breakdown of the primary tables used to maintain state.

| Table | Purpose | Key Columns |
| :--- | :--- | :--- |
| `users` | Core user profile & authentication. | `firebase_uid`, `displayName`, `semanticMemory`, `ttsVoiceId`. |
| `sessions` | Logic for grouping chat messages. | `session_id`, `user_uid`, `personalityId`, `status`. |
| `chats` | Individual message history. | `message_id`, `session_id`, `sender`, `text`, `image_urls`. |
| `memories` | Episodic memory units. | `id`, `userId`, `text`, `topic`, `emotion`, `status`. |
| `personalities`| Multi-agent definitions. | `id`, `name`, `systemPrompt`, `avatarUrl`, `isDefault`. |
| `vector_chunks`| RAG data points. | `chunk_id`, `user_uid`, `fileId`, `text`, `metadata`. |
| `config` | Global system settings. | `config_key`, `config_value` (JSON). |
| `announcements`| System updates & news. | `id`, `title`, `description`, `mediaUrl`, `active`. |

### 6.2 The Multi-Tool Framework
Chaka's capability is extended through a series of specialized "Tools" that she can call autonomously.

#### 6.2.1 Core Search Tools
- **`search_web(query)`**: Performs a live Google search. Silently executed in Live Mode to ensure natural flow.
- **`scrape_url(url)`**: Uses Firecrawl to extract content from complex, bot-shielded websites.

#### 6.2.2 Creative Tools
- **`generate_image(prompt)`**: High-resolution image synthesis via Vertex AI.
- **`edit_image(imageUrl, message)`**: Context-aware image manipulation.
- **`tts(text, voiceId)`**: Converts AI response into a high-fidelity voice stream.

#### 6.2.3 Utility Tools
- **`send_email(to, subject, body)`**: Direct email integration for notifications or summaries.
- **`transcribe_audio(filePath)`**: High-accuracy transcription for uploaded voice notes.
- **`database_query(collection, field, value)`**: A safe, restricted tool allowing Chaka to look up specific, non-sensitive records (e.g., subscription status).

### 6.3 Tool Execution Philosophy: "Silent Stealth"
In **Live Mode**, Chaka is instructed to use tools (like `search_web`) with **Absolute Silence**. 
- **Instruction**: DO NOT narrate your intention to search. 
- **Goal**: To mimic human cognition—thinking before speaking—rather than behaving like a command-line interface.

---

## 7. Deployment & System Resilience

### 7.1 Resilience: The "Always-On" Pulse
Chaka is designed to survive in transient hosting environments (e.g., Render Free/Starter tiers, Serverless functions).

#### 7.1.1 Keep-Alive Logic
The backend maintains three distinct "Heartbeat" loops:
1. **Database Socket (45s)**: Sends a `SELECT 1` ping to Turso. This prevents the TCP socket from timing out, which often occurs at the 60s mark in distributed databases.
2. **HTTP Traffic (5m)**: Sets the `Keep-Alive: timeout=300` header on all responses, signaling to the browser and CDN to hold the connection for 5 minutes.
3. **Self-Ping (10m)**: The server uses `axios` to ping its own external URL. This prevents "Scale-to-Zero" platforms from putting Chaka to sleep during inactivity.

#### 7.1.2 Blocking Startup Warmup
Chaka will NOT start accepting requests until her internal components are ready. This "Blocking" phase includes:
- **DNS Resolve**: Pings `api.cloudinary.com`, `files.rework.ink`, and Google API domains.
- **Library Warmup**: Pre-initializes the Vertex AI and Sharp libraries to ensure zero-lag execution of the first visual request.

### 7.2 Configuration & Security
To deploy a full instance of Chaka, the following environment variables are mandatory:

| Variable | Requirement |
| :--- | :--- |
| `FIREBASE_SERVICE_ACCOUNT` | JSON string for authentication. |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path or temp-file pointer for Vertex AI. |
| `TURSO_DATABASE_URL` | Endpoint for the primary DB. |
| `TURSO_AUTH_TOKEN` | Bearer token for database access. |
| `SERPER_API_KEY` | Key for standard web search. |
| `TAVILY_API_KEY` | Key for advanced research. |
| `FIRECRAWL_API_KEY` | Key for deep scraping. |

---

## 8. Looking Forward: The Future of Chaka

Chaka's architecture includes stubs for several upcoming "Humanoid" features:
- **`thoughtEngine.js`**: A framework for internal reasoning (hidden from the user but influencing output).
- **Inference Engine**: Potential for local or edge-based reasoning models.
- **Multimodal Gaze 2.0**: Full webcam-based visual awareness to allow Chaka to "see" the user's environment in real-time.

---

# 📝 Conclusion

Chaka is a masterclass in modern AI system design—marrying aesthetic excellence with a robust, multimodal technical core. She is built not just to respond, but to understand, remember, and proactively assist her users in an increasingly digital world.

**Document Version**: 5.2.0 (Expressive Face Edition)  
**Last Updated**: 2026-04-21  
**Project Lead**: Templeton / un_seen_me

---
**[END OF DOCUMENT]**
