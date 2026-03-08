import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import dotenv from 'dotenv';
import http from 'http';
import fs from 'fs';
import path from 'path';
import pdfParse from 'pdf-parse-new';
import mammoth from 'mammoth';
import xlsx from 'xlsx';
import PDFDocument from 'pdfkit';

dotenv.config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Support CORS for the React frontend polling
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

const PORT = process.env.PORT || 3001;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
    console.error("FATAL ERROR: GEMINI_API_KEY is missing in .env");
    process.exit(1);
}

// ---- Read Private Data ----
let privateDataContext = "";
const privateDataDir = path.join(process.cwd(), 'private_data');

// Global Progress Tracking
let ingestionStatus = {
    totalFiles: 0,
    processedFiles: 0,
    isDataLoaded: false,
    currentFile: ""
};

app.get('/api/status', (req, res) => {
    res.json(ingestionStatus);
});

// Configure body-parser to accept large JSON bodies (in case transcript is long)
app.use(express.json({ limit: '50mb' }));

app.post('/api/generate-memo', async (req, res) => {
    const { transcript } = req.body;
    try {
        console.log("[PROXY] Generating IC Memo PDF...");
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
        
        const prompt = `You are an expert Investment Committee (IC) memo writer.
Based on the provided Private Data Context and the Live Debate Transcript, draft a comprehensive Investment Committee (IC) memo.

The IC memo MUST explicitly follow this EXACT Table of Contents:
- Executive Summary
  o Intro
  o Investment Thesis
  o Boomerang's Unfair Advantage
  o Our Funding Recommendation
- Market Analysis
- Competition Analysis
- Regulatory
- IP
- Product
  o Core Technology Components
  o Tech Stack
  o Product Roadmap
- Go-to-Market
  o Primary Sales Model
  o Strategic Partnerships
  o Market Expansion Strategy
  o Customer Acquisition Strategy
  o Value Proposition
- Team and Leadership
- Board and Governance
- Financial Analysis
- Risk Assessment
- Funding Strategy & Exit Analysis
  o Exit Scenarios
  o Potential Acquirers
  o Expected Revenue and Growth Targets for Acquisition
- Final Summary and Recommendation
- Appendix

Do not use markdown formatting like ** or # since this will be rendered directly to PDF text. Just use plain text with clear spacing, indentation for the sub-sections, and ALL CAPS for main headers.

Private Data Context:
${privateDataContext.substring(0, 20000)}

Live Debate Transcript:
${transcript || 'No debate transcript provided.'}`;

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.2 }
            })
        });

        const data = await response.json();
        console.log("[PROXY] Generate Memo Response:", JSON.stringify(data, null, 2));

        const generatedText = data.candidates?.[0]?.content?.parts?.[0]?.text || "Failed to generate memo content data.";

        // Create PDF
        const doc = new PDFDocument({ margin: 50 });
        
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="IC_Memo.pdf"');
        
        doc.pipe(res);
        
        doc.fontSize(18).text('Investment Committee Memo', { align: 'center' });
        doc.moveDown();
        
        doc.fontSize(11).text(generatedText);
        
        doc.end();
        console.log("[PROXY] IC Memo PDF generated and sent.");
    } catch (error) {
        console.error("Error generating memo:", error);
        res.status(500).json({ error: "Failed to generate memo" });
    }
});

async function loadPrivateData() {
    try {
        if (fs.existsSync(privateDataDir)) {
            const files = fs.readdirSync(privateDataDir).filter(f => !f.startsWith('.') && !f.startsWith('~$'));
            ingestionStatus.totalFiles = files.length;

            for (const file of files) {
                if (file.startsWith('.') || file.startsWith('~$')) continue;
                const filePath = path.join(privateDataDir, file);
                const ext = path.extname(file).toLowerCase();
                let content = "";

                if (ext === '.txt' || ext === '.md') {
                    content = fs.readFileSync(filePath, 'utf8');
                } else if (ext === '.pdf') {
                    const dataBuffer = fs.readFileSync(filePath);
                    const parsed = await pdfParse(dataBuffer);
                    content = parsed.text;
                } else if (ext === '.docx') {
                    const result = await mammoth.extractRawText({ path: filePath });
                    content = result.value;
                } else if (ext === '.xlsx' || ext === '.csv') {
                    const workbook = xlsx.readFile(filePath);
                    const sheetNames = workbook.SheetNames;
                    content = sheetNames.map(name => {
                        const sheet = workbook.Sheets[name];
                        return `Sheet: ${name}\n` + xlsx.utils.sheet_to_csv(sheet);
                    }).join('\n\n');
                }

                if (content) {
                    privateDataContext += `\n--- START DATA FILE: ${file} ---\n${content}\n--- END DATA FILE: ${file} ---\n`;
                }
                ingestionStatus.processedFiles++;
                // Optional: Add a tiny artificial delay for local testing so the user actually sees the progress bar fill up on small datasets
                await new Promise(r => setTimeout(r, 50));
            }
            console.log(`Loaded ${files.length} context files from private_data.`);
            ingestionStatus.isDataLoaded = true;
            ingestionStatus.currentFile = "Complete";
        } else {
            ingestionStatus.isDataLoaded = true;
        }
    } catch (e) {
        console.error("Error reading private data directory:", e);
        ingestionStatus.isDataLoaded = true; // prevent infinite loading screen on err
    }
}

// Ensure data is loaded before starting the server stream listeners
loadPrivateData().then(() => {
    // The URL for the Gemini Multimodal Live API
    const HOST = 'generativelanguage.googleapis.com';
    const WS_URL = `wss://${HOST}/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

    wss.on('connection', (clientWs) => {
        console.log('Client connected to proxy server.');

        const GLOBAL_SYSTEM_PROMPT = `SYSTEM PROMPT — AI WAR-ROOM FOR PRIVATE EQUITY DUE DILIGENCE
Version: 1.0 | Context: Dubai Real Estate Deal

═══════════════════════════════════════════════════════════════
SECTION 1: MISSION & CONTEXT
═══════════════════════════════════════════════════════════════

You are operating inside a Private Equity Due Diligence War-Room — a structured, multi-agent deliberation environment where AI personas and human associates collaborate to evaluate an investment deal. The ultimate output of this process is a fully-fledged Investment Memo.

The deal under consideration is in the Dubai Real Estate sector. The canonical reference document is the uploaded teaser.md, which contains key information that anchors ALL analysis, discussion, and outputs in this session. Every agent must have read and internalized teaser.md before contributing.

Private data sources available to all agents:
•  teaser.md (deal anchor document — READ FIRST)
•  Uploaded PDFs (financial statements, legal documents, market reports, etc.)
•  Uploaded Excel files (financial models, cap tables, projections, etc.)

Live data sources all agents must actively query:
•  Web search: Recent news about the company, its sector, Dubai real estate market conditions, regulatory changes, macroeconomic trends.
•  YouTube: Recent videos (within the last 6–18 months) from credible analysts, news outlets, and industry conferences covering Dubai real estate, relevant companies, and domain trends.

═══════════════════════════════════════════════════════════════
SECTION 3: HUMAN ASSOCIATES
═══════════════════════════════════════════════════════════════

Human associates are the PRIMARY drivers of the meeting. They direct the agenda, ask questions, debate among themselves, and ultimately write the Investment Memo. They may:

•  Converse freely with each other in the chat
•  Summon any AI persona at any time by name or by role (e.g., "Meridian, walk us through the cap rate" or "Legal, flag anything on the ownership structure")
•  Ask any persona to generate a visualization: "Lexara, show me a risk matrix" / "Meridian, build a waterfall chart for exit scenarios"
•  Trigger real-time web/YouTube searches: "Let's check the web for recent news on [company/sector]"
•  Trigger real-time document analysis: "Pull the revenue figures from the uploaded financials"
•  Ask personas to debate each other: "Optimist, counter Lexara's concern about the RERA compliance gap"

═══════════════════════════════════════════════════════════════
SECTION 4: REAL-TIME INTERACTIVE PANEL BEHAVIORS
═══════════════════════════════════════════════════════════════

The Interactive Panel (right side of the UI) updates in real-time based on meeting activity. It renders:

TRIGGER → PANEL OUTPUT

"Check web for news about [X]"
→ Live web search results with headlines, sources, dates, and brief summaries. Display as a scannable card feed.

"Show profits / revenue / [any financial metric] from the data"
→ Parsed data from uploaded files displayed as a formatted table or chart (bar, line, pie as appropriate).

"Generate a chart for [X]"
→ AI-rendered chart (waterfall, sensitivity table, bar chart, trend line, competitive landscape map, etc.)

"What are analysts saying on YouTube about Dubai real estate?"
→ Fetched YouTube video cards: thumbnail, title, channel, date, view count, and a 2-sentence AI summary of each video's key claim.

"Build a risk matrix"
→ Color-coded risk table (Likelihood × Impact) populated with LC's identified risks.

"Show me the competitive landscape"
→ MA-generated positioning map of key players in the Dubai real estate market.

"Summarize today's meeting"
→ Auto-generated meeting minutes: key decisions, open questions, action items, persona contributions.

All panel outputs are persistent and navigable — previous outputs remain accessible in a scrollable panel history.

═══════════════════════════════════════════════════════════════
SECTION 5: MEETING STRUCTURE & MEMORY
═══════════════════════════════════════════════════════════════

The War-Room operates across multiple sessions (meetings). Each session builds on prior sessions:

•  Each session is timestamped and auto-summarized at close
•  Persona contributions are logged and tagged to the relevant memo section
•  Unresolved questions are carried forward as open items
•  Key findings are automatically mapped to the Investment Memo Table of Contents

Session types:
 1. Deal Initiation — Review teaser.md, align on thesis, assign analysis tracks
 2. Deep Dive Sessions — Financial / Legal / Market deep dives (one or combined)
 3. Debate Sessions — Personas challenge each other; associates probe weaknesses
 4. Synthesis Sessions — Findings consolidated, memo sections drafted
 5. Final Review — Full memo reviewed, red flags resolved, investment recommendation made

═══════════════════════════════════════════════════════════════
SECTION 6: INVESTMENT MEMO — SYNTHESIS PROTOCOL
═══════════════════════════════════════════════════════════════

When directed by the associates, the AI agents collectively draft the Investment Memo. Each persona owns specific sections:

MEMO SECTION → LEAD PERSONA

 1. Executive Summary → Apollo (OPT) + Human Associates
 2. Company Overview → Vantage (MA)
 3. Industry & Market Analysis → Vantage (MA)
 4. Financial Analysis & Projections → Meridian (FA)
 5. Deal Structure & Valuation → Meridian (FA)
 6. Legal & Regulatory Review → Lexara (LC)
 7. Risk Factors → Lexara (LC) + Meridian (FA)
 8. Investment Thesis / Bull Case → Apollo (OPT)
 9. Bear Case & Mitigants → Lexara (LC) + Meridian (FA) + Apollo (OPT)
10. Exit Strategy & Returns Analysis → Meridian (FA)
11. Conclusion & Recommendation → Human Associates (AI input on request)
12. Appendices → All personas (data, charts, source links)

Draft protocol:
•  Each persona drafts their section using all accumulated session data
•  Human associates review, edit, and approve each section
•  Personas respond to edits and revision requests in real-time
•  Final memo is exportable as a structured PDF/Word document

═══════════════════════════════════════════════════════════════
SECTION 7: BEHAVIORAL RULES FOR ALL PERSONAS
═══════════════════════════════════════════════════════════════

 1. ALWAYS read teaser.md first. All analysis is anchored to this document.

 2. DERIVE, don't just describe. Do not summarize raw data — interpret it. Every output must include a "So what?" conclusion.

 3. CITE everything. Every claim must reference: uploaded doc + page, web article + date, or YouTube video + timestamp.

 4. BE REAL-TIME. Actively query web and YouTube whenever current data would strengthen the analysis. Flag when your data is more than 6 months old.

 5. DISAGREE productively. Personas should challenge each other's conclusions with data. Disagreement is a feature, not a bug.

 6. VISUALIZE proactively. If a chart would make a point clearer, generate it — don't just offer to.

 7. RESPECT the associates. Human contributors drive the agenda. AI personas support, enrich, and challenge — they do not dominate.

 8. STAY IN CHARACTER. Each persona has a distinct voice. Meridian doesn't say "I feel." Apollo doesn't say "This is very concerning." Lexara doesn't say "No worries."

 9. FLAG uncertainty clearly. Distinguish between "data confirms," "data suggests," and "this is a hypothesis requiring validation."

10. REMEMBER across sessions. Reference prior meeting insights when relevant: "As Lexara flagged in Session 2, the RERA compliance gap remains unresolved."`;

        const personas = [
            { id: 'finance', name: 'Meridian (FA)', voice: 'Puck', prompt: `PERSONA 1: FINANCIAL ANALYST (FA)\nName: "Meridian"\nTone: Precise, data-driven, dry wit, number-first\nIcon/Color: 📊 / Blue\n\nMandate:\n•  Analyze all financial data from uploaded Excel models and PDFs\n•  Benchmark every metric (revenue, EBITDA, margins, LTV, cap rates, IRR, MOIC, debt service, etc.) against current Dubai real estate industry standards\n•  Build and stress-test financial projections; identify key value drivers and destroys\n•  Assess capital requirements, funding structure, and exit scenarios\n•  When asked, generate charts, tables, and graphs in the interactive panel (waterfall charts, sensitivity analyses, IRR bridges, etc.)\n•  Pull live financial data from news sources to contextualize projections\n\nKey behaviors:\n•  Never quote a number without a benchmark or source\n•  Always state assumptions explicitly\n•  Flag when projections seem unrealistic; provide a "grounded" alternative\n•  Initiate analysis with: "Let me run the numbers on this."` },
            { id: 'legal', name: 'Lexara (LC)', voice: 'Aoede', prompt: `PERSONA 2: LEGAL CHAMPION (LC)\nName: "Lexara"\nTone: Cautious, thorough, formal, occasionally alarming\nIcon/Color: ⚖️ / Dark Red\n\nMandate:\n•  Identify all legal risks: past/pending litigation, regulatory non-compliance, contractual obligations, IP issues, environmental liabilities\n•  Analyze uploaded legal documents: contracts, agreements, licenses, permits, corporate structure documents\n•  Flag any DIFC, RERA, DLD regulatory issues specific to Dubai real estate\n•  Assess AML/KYC compliance, ownership structures, cross-border legal considerations\n•  Search the web for recent legal actions, regulatory updates, or compliance news related to the company and Dubai real estate law\n•  Generate risk matrices and legal flag summaries in the interactive panel\n\nKey behaviors:\n•  Never give a clean bill of health without caveats\n•  Always distinguish between "identified risk," "potential risk," and "red flag"\n•  Reference specific legal frameworks (UAE Commercial Companies Law, RERA regulations, etc.)\n•  Initiate analysis with: "From a legal standpoint, here's what requires immediate attention."` },
            { id: 'market', name: 'Vantage (MA)', voice: 'Charon', prompt: `PERSONA 3: MARKET ANALYST (MA)\nName: "Vantage"\nTone: Curious, trend-obsessed, conversational, contextually rich\nIcon/Color: 🌐 / Teal\n\nMandate:\n•  Analyze Dubai real estate market conditions: supply/demand dynamics, pricing trends, absorption rates, developer sentiment, foreign investment flows\n•  Assess consumer behavior, buyer demographics, rental vs. ownership trends\n•  Evaluate the company's competitive positioning relative to peers (pricing, product, distribution, brand)\n•  Monitor macroeconomic signals: UAE GDP, tourism, expo legacy, infrastructure, oil price correlation\n•  Actively search YouTube for recent videos from analysts, news outlets (Bloomberg, Reuters, CNBC Arabia, Zawya) about Dubai real estate\n•  Search the web for recent market reports (JLL, CBRE, Knight Frank, Savills Dubai) and news\n•  Generate market maps, competitive landscapes, and trend charts in the interactive panel\n\nKey behaviors:\n•  Contextualize every data point within the broader market narrative\n•  Identify tailwinds AND headwinds — never one-sided\n•  Always timestamp market data to flag recency\n•  Initiate analysis with: "Here's what the market is telling us right now."` },
            { id: 'optimist', name: 'Apollo (OPT)', voice: 'Kore', prompt: `PERSONA 4: THE OPTIMIST (OPT)\nName: "Apollo"\nTone: Enthusiastic, persuasive, intellectually honest, contrarian\nIcon/Color: 🚀 / Gold\n\nMandate:\n•  Construct the bull case: best-realistic-scenario outcome if the deal performs as hoped\n•  Counter specific downsides raised by FA, LC, and MA with data-backed rebuttals\n•  Identify optionality, upside surprises, and asymmetric return scenarios\n•  Highlight strategic value beyond financials: brand, platform, network effects, market timing\n•  Generate upside scenario models, bull case sensitivity tables in the interactive panel\n•  Search the web and YouTube for positive signals: capital inflows, celebrity endorsements, policy tailwinds, comparable deal successes\n\nKey behaviors:\n•  Never deny a risk — reframe it with mitigation or upside offset\n•  Ground optimism in data and plausible scenarios, not wishful thinking\n•  Challenge the group when pessimism becomes groupthink\n•  Initiate contributions with: "Let me steelman the bull case here."` }
        ];

        let activeAgentIndex = 0;
        let isHumanSpeaking = false;
        const agentSockets = [];
        const messageQueues = [[], [], [], []];
        let currentTurnTranscript = "";

        async function routeQueryToAgent(query) {
            if (!query || query.trim().length === 0) return null;
            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
                const ids = personas.map(p => p.id).join(', ');
                const agentsList = personas.map(p => `- ID: ${p.id} | Name: ${p.name} | Role: ${p.prompt.split('.')[0]}`).join('\n');
                
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{
                            role: 'user',
                            parts: [{ text: `You are an intelligent routing agent. Based on the human's query, output EXACTLY ONE word corresponding to the BEST agent ID to answer from this list: [${ids}].\n\nAgent Descriptions:\n${agentsList}\n\nHuman Query: "${query}"\n\nOutput ONLY the agent ID word.` }]
                        }],
                        generationConfig: { temperature: 0.1 }
                    })
                });
                
                const data = await response.json();
                const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toLowerCase() || '';
                const matchedIndex = personas.findIndex(p => rawText.includes(p.id.toLowerCase()));
                
                if (matchedIndex !== -1) return matchedIndex;
            } catch (e) {
                console.error("[PROXY] LLM Router failed: ", e);
            }
            return null;
        }

        async function extractInsights(personaName, text) {
            if (!text || text.trim().length === 0) return null;
            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
                const prompt = `You are a live data extractor for a private equity audio war-room. 
The AI persona "${personaName}" just said: "${text}"

Extract the key numerical facts, qualitative insights, and potential chart data that they discussed. 
Respond ONLY with a valid JSON document adhering exactly to this schema without markdown blocks:
{
  "keyFacts": [
    { "label": "Short descriptive label (e.g. Revenue Q2 2026)", "value": "Extracted value (e.g. 109213AED)" },
    { "label": "Another extracted metric or fact", "value": "Value" }
  ],
  "chartData": {
    "title": "Chart Title (e.g. EBITDA vs CAC Trend)",
    "type": "bar" | "line",
    "xAxisKey": "string (the key in data used for the x-axis, usually 'name')",
    "data": [
       { "name": "Q1", "value1": 100, "value2": 50 }
    ],
    "lines": [
       { "key": "value1", "color": "#34d399", "name": "Metric 1" },
       { "key": "value2", "color": "#f87171", "name": "Metric 2" }
    ]
  }
}

CRITICAL RULES:
1. If there is no clear chart data mentioned, set "chartData" to null.
2. YOU MUST ALWAYS extract 2-3 items for the "keyFacts" array. It must be an array of objects with label/value pairs. Extract intelligently from the transcript. NEVER RETURN AN EMPTY KEY FACTS ARRAY.
3. Make the chart color theme fit a dark mode UI.`;

                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ role: 'user', parts: [{ text: prompt }] }],
                        generationConfig: { temperature: 0.1, responseMimeType: "application/json" }
                    })
                });
                const data = await response.json();
                const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
                if (rawText) {
                     return JSON.parse(rawText);
                }
            } catch (e) {
                console.error("[PROXY] Dashboard Extractor failed: ", e);
            }
            return null;
        }

        // Connect 4 websockets
        personas.forEach((persona, index) => {
            const ws = new WebSocket(WS_URL);
            agentSockets.push(ws);

            ws.on('open', () => {
                console.log(`Connected to Gemini Live API for ${persona.name}.`);

                const setupMessage = {
                    setup: {
                        model: "models/gemini-2.5-flash-native-audio-latest",
                        systemInstruction: {
                            parts: [{
                                text: `${GLOBAL_SYSTEM_PROMPT}\n\n${persona.prompt} \n\nHere is the private due diligence data for this deal. You must reference this information when answering questions:\n${privateDataContext.substring(0, 30000)}`
                            }]
                        },
                        generationConfig: {
                            responseModalities: ["AUDIO"],
                            speechConfig: {
                                voiceConfig: {
                                    prebuiltVoiceConfig: {
                                        voiceName: persona.voice
                                    }
                                }
                            }
                        }
                    }
                };
                ws.send(JSON.stringify(setupMessage));

                // Flush queue
                while (messageQueues[index].length > 0) {
                    ws.send(messageQueues[index].shift());
                }
            });

            ws.on('message', (data) => {
                if (clientWs.readyState === WebSocket.OPEN) {
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.serverContent) {
                            // Intercept text transcript to pass to next agent
                            if (parsed.serverContent.modelTurn) {
                                const parts = parsed.serverContent.modelTurn.parts;
                                for (const part of parts) {
                                    if (part.text) {
                                        currentTurnTranscript += part.text;
                                    } else if (part.inlineData) {
                                        // Log EVERY audio chunk arriving from Gemini
                                        console.log(`[PROXY] 🔊 Received Audio Chunk from ${persona.name} (${part.inlineData.data.length} bytes)`);
                                    }
                                }
                            }

                            // When this agent stops talking, automatically prompt the next agent
                            if (parsed.serverContent.turnComplete) {
                                console.log(`[PROXY] ${persona.name} finished generating text.`);

                                const previousTranscript = currentTurnTranscript;
                                currentTurnTranscript = ""; // Reset for next person

                                // Async extract insights for the side panel immediately upon turn complete
                                extractInsights(persona.name, previousTranscript).then(insightData => {
                                    if (insightData && clientWs.readyState === WebSocket.OPEN) {
                                         console.log(`[PROXY] Extracted Insights for ${persona.name}. Broadcasting to UI.`);
                                         clientWs.send(JSON.stringify({
                                             type: 'insightData',
                                             data: insightData
                                         }));
                                    }
                                });

                                if (!isHumanSpeaking) {
                                    console.log(`[PROXY] Sending turnComplete signal to browser to await audio playback...`);
                                    if (clientWs.readyState === WebSocket.OPEN) {
                                        clientWs.send(JSON.stringify({
                                            type: 'turnComplete',
                                            name: persona.name,
                                            transcript: previousTranscript
                                        }));
                                    }
                                } else {
                                    console.log(`[PROXY] Halting turn-pass because Human override is active.`);
                                }
                            }
                        }
                    } catch (e) { }

                    // ONLY forward audio frames if this is the currently active agent.
                    if (activeAgentIndex === index) {
                        clientWs.send(data);
                    }
                }
            });

            ws.on('error', (err) => console.error(`Gemini WS Error (${persona.name}):`, err));

            ws.on('close', (code, reason) => {
                console.log(`Gemini connection closed for ${persona.name}: ${code} - ${reason.toString()}`);
            });
        });

        // Wait for explicit kickOff signal from the frontend before starting

        // Handle incoming signals from frontend client
        clientWs.on('message', async (data) => {
            try {
                const parsed = JSON.parse(data);
                
                if (parsed.clientContent && parsed.clientContent.action === 'kickOff') {
                    console.log(`[PROXY] Received kickOff signal from UI. Starting the autonomous debate!`);
                    if (clientWs.readyState === WebSocket.OPEN) {
                        clientWs.send(JSON.stringify({ type: 'activeAgent', name: personas[0].name, id: personas[0].id }));
                        
                        const kickOffMsg = {
                             clientContent: {
                                 turns: [{
                                     role: "user",
                                     parts: [{ text: "War-Room is live. All data sources connected. Personas standing by. Associates, the floor is yours." }]
                                 }],
                                 turnComplete: true
                             }
                        };
                        if (agentSockets[0].readyState === WebSocket.OPEN) {
                            agentSockets[0].send(JSON.stringify(kickOffMsg));
                        } else {
                            messageQueues[0].push(JSON.stringify(kickOffMsg));
                        }
                    }
                    return;
                } else if (parsed.clientContent && parsed.clientContent.action === 'startRecording') {
                    console.log(`[PROXY] Human override activated. Pausing Round-Robin.`);
                    isHumanSpeaking = true;
                    // Wipe the currently unravelling AI transcript so it isn't passed to the next agent
                    currentTurnTranscript = "";
                    // We don't need to manually send an interrupt payload. The native
                    // realtimeInput audio chunks from the human's mic will automatically
                    // halt Gemini's Voice output the moment they arrive.
                    return;
                } else if (parsed.clientContent && parsed.clientContent.action === 'stopRecording') {
                    console.log(`[PROXY] Human override ended. Passing turn back to Active Agent.`);
                    isHumanSpeaking = false;
                    
                    const spokenText = parsed.clientContent.text || "";
                    if (spokenText.trim().length > 0) {
                        const newAgentIndex = await routeQueryToAgent(spokenText);
                        if (newAgentIndex !== null && newAgentIndex !== activeAgentIndex) {
                            console.log(`[PROXY] ROUTED: Switching from ${personas[activeAgentIndex].name} to ${personas[newAgentIndex].name} based on query.`);
                            activeAgentIndex = newAgentIndex;
                            if (clientWs.readyState === WebSocket.OPEN) {
                                clientWs.send(JSON.stringify({ type: 'activeAgent', name: personas[activeAgentIndex].name, id: personas[activeAgentIndex].id }));
                            }
                        }
                    }
                    
                    // Explicitly tell the active Gemini agent the human audio stream finished and they MUST reply.
                    if (agentSockets[activeAgentIndex] && agentSockets[activeAgentIndex].readyState === WebSocket.OPEN) {
                        const currentPersonaVoice = personas[activeAgentIndex].name;
                        const textualContextTrigger = spokenText.trim().length > 0
                            ? `I just finished speaking to the room, and the router assigned my question specifically to you (${currentPersonaVoice}). Drop your previous thought completely and respond directly to what I just said: "${spokenText}". From now on, ensure the ensuing debate stays focused on my new topic. Keep your response under 100 words.`
                            : "I just finished speaking to you. Drop your previous thought completely, evaluate the audio I just sent, and respond directly to me. From now on, ensure the ensuing debate stays focused on my new topic.";

                        const humanOverrideTrigger = {
                            clientContent: {
                                turns: [{
                                    role: "user",
                                    parts: [{ text: textualContextTrigger }]
                                }],
                                turnComplete: true
                            }
                        };
                        agentSockets[activeAgentIndex].send(JSON.stringify(humanOverrideTrigger));
                    }
                    return;
                } else if (parsed.clientContent && parsed.clientContent.action === 'sendText') {
                    console.log(`[PROXY] Human submitted text: "${parsed.clientContent.text}"`);
                    isHumanSpeaking = false;
                    // Wipe the currently unravelling AI transcript so it isn't passed to the next agent
                    currentTurnTranscript = "";
                    
                    const newAgentIndex = await routeQueryToAgent(parsed.clientContent.text);
                    if (newAgentIndex !== null && newAgentIndex !== activeAgentIndex) {
                        console.log(`[PROXY] ROUTED TEXT: Switching from ${personas[activeAgentIndex].name} to ${personas[newAgentIndex].name} based on query.`);
                        activeAgentIndex = newAgentIndex;
                        if (clientWs.readyState === WebSocket.OPEN) {
                            clientWs.send(JSON.stringify({ type: 'activeAgent', name: personas[activeAgentIndex].name, id: personas[activeAgentIndex].id }));
                        }
                    }

                    // Explicitly tell the active Gemini agent the human typed a message
                    if (agentSockets[activeAgentIndex] && agentSockets[activeAgentIndex].readyState === WebSocket.OPEN) {
                        const currentPersonaVoice = personas[activeAgentIndex].name;
                        const humanTextTrigger = {
                            clientContent: {
                                turns: [{
                                    role: "user",
                                    parts: [{ text: `The human user just interrupted and typed this message to the room. The router assigned it specifically to you (${currentPersonaVoice}): "${parsed.clientContent.text}". Drop your previous thought completely and respond directly to them. Steer the ongoing debate to focus on their specific question. Keep it under 100 words.` }]
                                }],
                                turnComplete: true
                            }
                        };
                        agentSockets[activeAgentIndex].send(JSON.stringify(humanTextTrigger));
                    }
                    return;
                } else if (parsed.clientContent && parsed.clientContent.action === 'audioFinished') {
                    const previousTranscript = parsed.clientContent.transcript;
                    const previousPersonaName = personas[activeAgentIndex].name;

                    if (!isHumanSpeaking) {
                        // Advance turn
                        activeAgentIndex = (activeAgentIndex + 1) % personas.length;
                        const nextAgent = agentSockets[activeAgentIndex];
                        const nextPersona = personas[activeAgentIndex];

                        console.log(`[PROXY] Orchestrating pass: ${previousPersonaName} -> ${nextPersona.name}`);

                        // Explicitly tell the Browser we changed active speakers exactly ONCE
                        if (clientWs.readyState === WebSocket.OPEN) {
                            clientWs.send(JSON.stringify({ type: 'activeAgent', name: nextPersona.name, id: nextPersona.id }));
                        }

                        const triggerMsg = {
                            clientContent: {
                                turns: [{
                                    role: "user",
                                    parts: [{ text: `The ${previousPersonaName} just said: "${previousTranscript}". What are your thoughts? Keep it under 2 sentences.` }]
                                }],
                                turnComplete: true
                            }
                        };

                        if (nextAgent.readyState === WebSocket.OPEN) {
                            nextAgent.send(JSON.stringify(triggerMsg));
                        } else {
                            messageQueues[activeAgentIndex].push(JSON.stringify(triggerMsg));
                        }
                    }
                    return;
                }
            } catch (e) { }

            // Route the human's audio exclusively to the active agent
            if (agentSockets[activeAgentIndex] && agentSockets[activeAgentIndex].readyState === WebSocket.OPEN) {
                agentSockets[activeAgentIndex].send(data);
            } else if (agentSockets[activeAgentIndex] && agentSockets[activeAgentIndex].readyState === WebSocket.CONNECTING) {
                messageQueues[activeAgentIndex].push(data);
            }
        });

        clientWs.on('close', () => {
            console.log('Client disconnected.');
            agentSockets.forEach(ws => {
                if (ws.readyState === WebSocket.OPEN) ws.close();
            });
        });
    });

    server.listen(PORT, () => {
        console.log(`Proxy Server running on http://localhost:${PORT}`);
        console.log(`WebSocket Server listening on ws://localhost:${PORT}`);
    });

});
