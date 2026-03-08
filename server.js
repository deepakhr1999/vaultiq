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
      
      const messageQueue = [];

      // Connect to Gemini
      const geminiWs = new WebSocket(WS_URL);

      geminiWs.on('open', () => {
        console.log('Connected to Gemini Live API.');

        // Send the initial setup message
        const setupMessage = {
          setup: {
            model: "models/gemini-2.5-flash-native-audio-latest",
            systemInstruction: {
              parts: [{
                text: `You are an AI assistant in a war room scenario. You are an expert financial and legal analyst. Keep your answers extremely concise and conversational, as you are speaking out loud in a live meeting. Do not use markdown formatting. Be proactive. 
                
    Here is the private due diligence data for this deal. You must reference this information when answering questions:
    ${privateDataContext.substring(0, 30000)}
                `
              }]
            },
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: "Puck" // "Aoede", "Charon", "Fenrir", "Kore", "Puck"
                }
              }
            }
          }
        }
      };
      geminiWs.send(JSON.stringify(setupMessage));
      
      // Flush any client messages that were sent while we were connecting
      while (messageQueue.length > 0) {
          geminiWs.send(messageQueue.shift());
      }
    });

    geminiWs.on('message', (data) => {
      // Forward Gemini's response (which contains audio and/or text) back to the client
      if (clientWs.readyState === WebSocket.OPEN) {
        try {
            const parsed = JSON.parse(data);
            if (parsed.serverContent) {
                console.log(`[PROXY -> CLIENT] Forwarding Gemini response to Browser.`);
            }
        } catch(e) { /* ignore parse errors for raw audio/binary */ }
        clientWs.send(data);
      }
    });

    geminiWs.on('error', (err) => {
      console.error('Gemini WS Error:', err);
    });

    geminiWs.on('close', (code, reason) => {
      console.log(`Gemini connection closed: ${code} - ${reason.toString()}`);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close(code, reason.toString());
      }
    });

    // Handle incoming messages from the frontend client
    clientWs.on('message', (data) => {
      try {
          const parsed = JSON.parse(data);
          if (parsed.realtimeInput) {
              // Not logging every single chunk to avoid flooding the console
          } else if (parsed.clientContent && parsed.clientContent.turnComplete) {
              console.log("[CLIENT -> PROXY] Received 'turnComplete' signal from Browser.");
          } else if (parsed.clientContent) {
              console.log("[CLIENT -> PROXY] Received Persona/System config from Browser.");
          }
      } catch(e) {}
      
      if (geminiWs.readyState === WebSocket.OPEN) {
        // We safely forward everything to Gemini to maintain the stream.
        geminiWs.send(data);
      } else if (geminiWs.readyState === WebSocket.CONNECTING) {
        console.log("[PROXY] Queuing message for Gemini API...");
        messageQueue.push(data);
      }
    });

  clientWs.on('close', () => {
    console.log('Client disconnected.');
    if (geminiWs.readyState === WebSocket.OPEN) {
      geminiWs.close();
    }
  });
});

server.listen(PORT, () => {
  console.log(`Proxy Server running on http://localhost:${PORT}`);
  console.log(`WebSocket Server listening on ws://localhost:${PORT}`);
});

});
