const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:3001');

ws.on('open', () => {
    console.log('Test Client connected to Proxy');
    // Start recording signal
    ws.send(JSON.stringify({ clientContent: { action: 'startRecording' } }));
});

ws.on('message', (data) => {
    try {
        const parsed = JSON.parse(data.toString());
        if (parsed.type) {
             console.log('PROXY SIGNAL:', parsed);
        }
        if (parsed.serverContent) {
           if (parsed.serverContent.modelTurn) {
               const parts = parsed.serverContent.modelTurn.parts;
               for (const part of parts) {
                   if (part.text) {
                       console.log('GEMINI TEXT:', part.text.replace(/\n/g, ' '));
                   }
                   if (part.inlineData) {
                       console.log('GEMINI AUDIO CHUNK:', part.inlineData.mimeType, 'length:', part.inlineData.data.length);
                   }
               }
           }
           if (parsed.serverContent.turnComplete) {
               console.log('GEMINI TURN COMPLETE');
           }
        }
    } catch(e) {
        console.error("Parse Error:", e.message);
    }
});

ws.on('close', () => console.log('Proxy closed'));
ws.on('error', (err) => console.error(err));

setTimeout(() => {
    ws.close();
    process.exit(0);
}, 20000); // 20 seconds is enough to catch the kickoff debate
