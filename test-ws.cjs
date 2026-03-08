const WebSocket = require('ws');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const HOST = 'generativelanguage.googleapis.com';
const WS_URL = `wss://${HOST}/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

const models = [
  "models/gemini-2.0-flash-exp",
  "models/gemini-2.0-flash",
  "models/gemini-2.5-flash-native-audio-latest",
  "models/gemini-2.5-flash-native-audio-preview-09-2025",
  "models/gemini-2.5-flash-native-audio-preview-12-2025"
];

async function testModels() {
  for (const model of models) {
    await new Promise(resolve => {
      const ws = new WebSocket(WS_URL);
      ws.on('open', () => {
        ws.send(JSON.stringify({ 
           setup: { 
               model: model,
               generationConfig: { responseModalities: ["AUDIO"] }
           } 
        }));
      });
      ws.on('close', (code, reason) => {
        console.log(`Model ${model} closed with ${code} ${reason.toString()}`);
        resolve();
      });
      ws.on('message', (data) => {
        console.log(`Model ${model} CONNECTED: ${data}`);
        ws.close();
        resolve();
      });
      ws.on('error', (e) => {
          console.log(`Model ${model} error: ${e.message}`);
          resolve();
      });
    });
  }
}

testModels();
