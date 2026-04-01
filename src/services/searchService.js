const axios = require('axios');

async function searchWeb(query, apiKey) {
    const MAX_RETRIES = 2;
    const TIMEOUT = 15000; // 15 seconds per attempt
    
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            console.log(`🔍 Search attempt ${attempt}/${MAX_RETRIES} for query: "${query}"`);
            
            const response = await axios.post('https://google.serper.dev/search', 
                { q: query },
                { 
                    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
                    timeout: TIMEOUT
                }
            );
            
            console.log(`✅ Search succeeded on attempt ${attempt}`);
            const data = response.data;
            
            if (!data.organic || data.organic.length === 0) {
                console.log(`ℹ️  No results found for: "${query}"`);
                return "[SEARCH_NO_RESULTS]";
            }

            let formattedResults = "Here are the web search results:\n\n";
            data.organic.slice(0, 5).forEach((result, index) => {
                formattedResults += `[Result ${index + 1}]\nTitle: ${result.title}\nLink: ${result.link}\nSnippet: ${result.snippet}\n\n`;
            });
            
            console.log(`✅ Formatted ${data.organic.length} results for display`);
            return formattedResults;
            
        } catch (error) {
            const isTimeout = error.code === 'ECONNABORTED' || error.message.includes('timeout');
            const statusCode = error.response?.status;
            const errorMsg = error.response?.data?.error?.message || error.message;
            
            console.warn(`⚠️  Search attempt ${attempt} failed:`, {
                isTimeout,
                statusCode,
                errorMsg,
                code: error.code
            });
            
            // If it's a timeout and we have retries left, retry
            if (isTimeout && attempt < MAX_RETRIES) {
                console.log(`⏱️  Timeout detected. Retrying... (${attempt}/${MAX_RETRIES})`);
                await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s before retry
                continue;
            }
            
            // If it's the last attempt or a non-retryable error, throw
            if (attempt === MAX_RETRIES) {
                const errorDetails = `Search API error after ${MAX_RETRIES} attempts${isTimeout ? ' (timeout)' : ''}: ${errorMsg || error.message}`;
                console.error(`❌ ${errorDetails}`);
                throw new Error(errorDetails);
            }
        }
    }
    
    throw new Error("Search failed after all retries");
}

module.exports = { searchWeb };