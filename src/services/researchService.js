const axios = require('axios');
const { searchWeb } = require('./searchService');

/**
 * Advanced Research Service
 * Integrates Tavily (AI Search) and Firecrawl (Stealth Scraper/CAPTCHA bypass)
 */

/**
 * Deep Search via Tavily
 * optimized for AI research
 */
async function tavilySearch(query, apiKey) {
    try {
        console.log(`🧠 Tavily: Researching query: "${query}"...`);
        const response = await axios.post('https://api.tavily.com/search', {
            api_key: apiKey,
            query: query,
            search_depth: "advanced",
            include_images: false,
            include_answer: true,
            max_results: 5
        }, { timeout: 20000 });

        const data = response.data;
        let formatted = `**Tavily Search Summary:** ${data.answer || "No direct answer found."}\n\n`;
        
        data.results.forEach((res, i) => {
            formatted += `[Source ${i+1}] ${res.title}\nURL: ${res.url}\nContent: ${res.content}\n\n`;
        });

        return formatted;
    } catch (e) {
        console.error("❌ Tavily Search Error:", e.message);
        throw e;
    }
}

/**
 * Stealth Web Scrape via Firecrawl
 * Handles CAPTCHA and anti-bot systems
 */
async function firecrawlScrape(url, apiKey) {
    try {
        console.log(`🕷  Firecrawl: Deep scraping URL: ${url}...`);
        const response = await axios.post('https://api.firecrawl.dev/v0/scrape', {
            url: url,
            pageOptions: {
                onlyMainContent: true,
                includeHtml: false,
                waitFor: 2000
            },
            extractorOptions: {
                mode: "llm-ready"
            }
        }, {
            headers: { 'Authorization': `Bearer ${apiKey}` },
            timeout: 30000
        });

        const data = response.data;
        if (!data.success) throw new Error(data.error || "Scraping failed");

        const content = data.data.content || data.data.markdown || "No content extracted.";
        return `**Deep Scrape Result for ${url}:**\n\n${content.substring(0, 15000)}`; // Cap at 15k chars for prompt
    } catch (e) {
        console.error("❌ Firecrawl Scrape Error:", e.message);
        throw e;
    }
}

/**
 * Unified Advanced Research Tool
 */
async function performResearch(query, userId) {
    const apiKeyManager = require('../utils/apiKeyManager');
    
    // Check for advanced keys
    const tavilyKey = apiKeyManager.keys.find(k => k.type === 'tavily')?.key;
    const firecrawlKey = apiKeyManager.keys.find(k => k.type === 'firecrawl')?.key;
    const serperKey = apiKeyManager.keys.find(k => k.type === 'search')?.key;

    // Phase 1: Intelligent Search
    let results = "";
    if (tavilyKey) {
        try {
            results = await tavilySearch(query, tavilyKey);
        } catch (e) {
            console.warn("⚠️ Tavily failed, falling back to Serper");
            results = await searchWeb(query, serperKey);
        }
    } else {
        results = await searchWeb(query, serperKey);
    }

    return results;
}

module.exports = { 
    tavilySearch, 
    firecrawlScrape, 
    performResearch 
};
