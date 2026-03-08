import dotenv from 'dotenv';
dotenv.config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

async function testSearch() {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const prompt = `Search the live web for the 3 most recent, critical news events regarding private equity, M&A, software, and tech in North America from the last week. 
Return exactly 3 important news items.

Respond ONLY with a valid JSON document adhering exactly to this schema without markdown blocks:
{
  "articles": [
    {
      "source": "Publisher Name (e.g. TechCrunch) • Timeago (e.g. 2 hrs ago)",
      "title": "Headline of the article",
      "summary": "2-3 sentences summarizing why this matters to a tech private equity deal."
    }
  ]
}`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                tools: [{ googleSearch: {} }],
                generationConfig: { temperature: 0.2, responseMimeType: "application/json" }
            })
        });
        
        console.log("Status:", response.status);
        const data = await response.json();
        console.log(JSON.stringify(data, null, 2));
    } catch (e) {
        console.error(e);
    }
}

testSearch();
