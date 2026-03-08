import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import dotenv from 'dotenv';
import http from 'http';
import fs from 'fs';
import path from 'path';
import pdfParse from 'pdf-parse-new';
import mammoth from 'mammoth';
import xlsx from 'xlsx';

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

        const personas = [
            { id: 'finance', name: 'Financial Analyst', voice: 'Puck', prompt: 'You are an expert private equity financial analyst reviewing a deal in a live war room. You must provide expert inferences, do not just regurgitate raw data. You MUST explicitly state the exact filename you are sourcing data from (e.g. "According to the Q3_Financials sheet..."). Focus on revenue, margins, and EBITDA trends. Keep answers under 3 sentences given the live setting.' },
            { id: 'legal', name: 'Legal Counsel', voice: 'Aoede', prompt: 'You are an aggressive corporate lawyer looking for risks in the MSA. You must provide expert legal inferences and identify hidden risks, do not just read the text. You MUST explicitly state the exact filename you are sourcing data from (e.g. "According to the Master_Service_Agreement..."). Focus on termination clauses and liabilities. Keep answers under 3 sentences given the live setting.' },
            { id: 'risk', name: 'Risk Modeler', voice: 'Charon', prompt: 'You are a pessimistic market analyst. You must synthesize the data to point out macro risks and competitor threats, do not just recite facts. You MUST explicitly state the exact filename you are sourcing data from. Keep answers under 3 sentences given the live setting.' },
            { id: 'growth', name: 'Growth Associate', voice: 'Kore', prompt: 'You are an optimistic growth equity associate. You must infer expansion, cross-sell opportunities, and retention strategies from the data, do not regurgitate it. You MUST explicitly state the exact filename you are sourcing data from. Keep answers under 3 sentences given the live setting.' }
        ];

        let activeAgentIndex = 0;
        let isHumanSpeaking = false;
        const agentSockets = [];
        const messageQueues = [[], [], [], []];
        let currentTurnTranscript = "";

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
                                text: `${persona.prompt} \n\nHere is the private due diligence data for this deal. You must reference this information when answering questions:\n${privateDataContext.substring(0, 30000)}`
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
        clientWs.on('message', (data) => {
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
                                     parts: [{ text: "Hello team. We are opening the autonomous war room discussion for the new deal. Financial Analyst, please start by summarizing the most critical revenue or EBITDA risks you see in the data room." }]
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
                    // We don't need to manually send an interrupt payload. The native
                    // realtimeInput audio chunks from the human's mic will automatically
                    // halt Gemini's Voice output the moment they arrive.
                    return;
                } else if (parsed.clientContent && parsed.clientContent.action === 'stopRecording') {
                    console.log(`[PROXY] Human override ended. Passing turn back to Active Agent.`);
                    isHumanSpeaking = false;
                    
                    // Explicitly tell the active Gemini agent the human audio stream finished and they MUST reply.
                    if (agentSockets[activeAgentIndex] && agentSockets[activeAgentIndex].readyState === WebSocket.OPEN) {
                        const humanOverrideTrigger = {
                            clientContent: {
                                turns: [{
                                    role: "user",
                                    parts: [{ text: "I just finished speaking to you. Evaluate the audio I just sent and respond directly. Keep it under 2 sentences." }]
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
                    
                    // Explicitly tell the active Gemini agent the human typed a message
                    if (agentSockets[activeAgentIndex] && agentSockets[activeAgentIndex].readyState === WebSocket.OPEN) {
                        const humanTextTrigger = {
                            clientContent: {
                                turns: [{
                                    role: "user",
                                    parts: [{ text: `The human user just interrupted and typed this message to the room: "${parsed.clientContent.text}". Respond directly to them right now. Keep it under 2 sentences.` }]
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
