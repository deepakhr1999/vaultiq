const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:3001');

ws.on('open', () => {
    console.log('Connected to proxy');
    // Send a message so the proxy knows we're alive, although the proxy connects to Gemini immediately
    ws.send(JSON.stringify({ ping: true }));
    
    // Wait for the kickOff message to pass through, then exit
    setTimeout(() => {
        console.log('Closing test proxy connection');
        ws.close();
    }, 5000);
});

ws.on('message', (data) => {
    // Ignore raw audio chunks to avoid binary spam in logs
    if (data instanceof Buffer) {
        console.log('Received raw buffer chunk');
        return;
    }
    const str = data.toString();
    if (str.includes('activeAgent')) {
        console.log('Proxy sent: ', str);
    }
});

ws.on('error', (err) => {
    console.error('Test Proxy Error: ', err);
});
