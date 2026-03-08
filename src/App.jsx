import React, { useState, useRef, useEffect } from 'react';
import './App.css';

function App() {
  const [messages, setMessages] = useState([]);
  const [isRecording, setIsRecording] = useState(false);
  const [hasStartedDebate, setHasStartedDebate] = useState(false);
  const [activePersona, setActivePersona] = useState('Financial Analyst');
  const activePersonaRef = useRef('Financial Analyst');
  const [isConnected, setIsConnected] = useState(false);

  // ---- Server Boot Polling ----
  const [serverStatus, setServerStatus] = useState({
      totalFiles: 0,
      processedFiles: 0,
      isDataLoaded: false,
      currentFile: "Initializing..."
  });

  useEffect(() => {
    let pollInterval;
    const fetchStatus = async () => {
        try {
            const res = await fetch('http://localhost:3001/api/status');
            const data = await res.json();
            setServerStatus(data);
            if (data.isDataLoaded) {
                clearInterval(pollInterval);
            }
        } catch (e) {
            // Server might not be up yet, wait for next tick
        }
    };

    pollInterval = setInterval(fetchStatus, 500);
    fetchStatus(); // immediate first call

    return () => clearInterval(pollInterval);
  }, []);

  const ws = useRef(null);
  const playbackAudioContext = useRef(null);
  const recordingAudioContext = useRef(null);
  const stream = useRef(null);
  const scriptNode = useRef(null);
  const messagesEndRef = useRef(null);

  const personas = {
    'Financial Analyst': "You are an expert private equity financial analyst reviewing a deal in a live war room. Focus on revenue, margins, and EBITDA. Only speak out loud. Keep answers under 2 sentences.",
    'Legal Champion': "You are an aggressive corporate lawyer looking for risks in the MSA and contracts. Focus on termination clauses and liabilities. Only speak out loud. Keep answers under 2 sentences.",
    'Market Analyst (Pessimist)': "You are a pessimistic market analyst. You always bring up macro risks and competitor threats. Only speak out loud. Keep answers under 2 sentences.",
    'Optimist': "You are an optimistic growth equity associate. You focus on expansion, cross-sell opportunities, and retention. Only speak out loud. Keep answers under 2 sentences."
  };

  const initWebSocket = () => {
    ws.current = new WebSocket('ws://localhost:3001');

    ws.current.onopen = () => {
      console.log('Connected to local proxy.');
      setIsConnected(true);

      // Update the persona immediately upon connecting
      updatePersona(activePersona);
    };

    ws.current.onmessage = async (event) => {
      let data = event.data;
      if (data instanceof Blob) {
           data = await data.text();
      }

      try {
        const parsed = JSON.parse(data);

        if (parsed.type === 'activeAgent') {
             console.log(`[DEBUG] Proxy signaled active agent: ${parsed.name}`);
             updatePersona(parsed.name);
             return;
        }

        if (parsed.type === 'turnComplete') {
             console.log(`[DEBUG] Received turnComplete for ${parsed.name}. Calculating audio queue drain time...`);
             if (playbackAudioContext.current) {
                 const currentTime = playbackAudioContext.current.currentTime;
                 const delaySeconds = Math.max(0, audioQueueTime.current - currentTime);
                 console.log(`[DEBUG] Audio will finish playing in ${delaySeconds.toFixed(1)} seconds.`);

                 setTimeout(() => {
                     if (ws.current && ws.current.readyState === WebSocket.OPEN) {
                         console.log(`[DEBUG] Audio drained. Telling proxy to advance the debate.`);
                         ws.current.send(JSON.stringify({
                             clientContent: {
                                 action: 'audioFinished',
                                 transcript: parsed.transcript
                             }
                         }));
                     }
                 }, delaySeconds * 1000 + 500); // Add 500ms safety buffer
             } else {
                 // Audio context hasn't been initialized yet (e.g. they didn't hit connect)
                 // Still pass the turn so the text logs keep moving
                 setTimeout(() => {
                     if (ws.current && ws.current.readyState === WebSocket.OPEN) {
                         ws.current.send(JSON.stringify({ clientContent: { action: 'audioFinished', transcript: parsed.transcript } }));
                     }
                 }, 4000); // Artificial 4 sec reading delay if no audio is playing
             }
             return;
        }

        if (parsed.serverContent && parsed.serverContent.modelTurn) {
            const parts = parsed.serverContent.modelTurn.parts;
            for (const part of parts) {
                // 1. Check for text transcript to show in UI
                if (part.text) {
                     console.log(`[DEBUG] Received text response from Gemini: "${part.text.substring(0, 30)}..."`);
                     setMessages(prev => [...prev, {
                        id: Date.now() + Math.random(),
                        sender: activePersonaRef.current + ' AI',
                        role: 'bot',
                        initials: 'AI',
                        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                        text: part.text
                     }]);
                }

                // 2. Check for audio chunks to play back
                if (part.inlineData && part.inlineData.data) {
                     const base64Audio = part.inlineData.data;
                     // Gemini returns 24kHz PCM 16-bit audio
                     playAudioChunk(base64Audio);
                }
            }
        }
      } catch (e) {
        console.error("Error parsing WS message", e);
      }
    };

    ws.current.onerror = (error) => {
      console.error('WebSocket Error:', error);
    };

    ws.current.onclose = () => {
      console.log('WebSocket closed.');
      setIsConnected(false);
      stopRecording();
    };
  };

  const audioQueueTime = useRef(0);

  const playAudioChunk = (base64String) => {
      try {
          // Initialize playback context on demand
          if (!playbackAudioContext.current) {
              playbackAudioContext.current = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
              audioQueueTime.current = playbackAudioContext.current.currentTime;
          }
          // Decode Base64 to binary string
          const binaryString = atob(base64String);
          const len = binaryString.length;

          // Create DataView to read 16-bit PCM
          const buffer = new ArrayBuffer(len);
          const view = new DataView(buffer);

          // Explicitly decode assuming Little-Endian PCM 16-bit
          const float32Array = new Float32Array(len / 2);
          for (let i = 0; i < len; i++) {
              view.setUint8(i, binaryString.charCodeAt(i));
          }
          for (let i = 0; i < len / 2; i++) {
              float32Array[i] = view.getInt16(i * 2, true) / 32768.0;
          }

          // Gemini returns 24kHz audio
          const audioBuffer = playbackAudioContext.current.createBuffer(1, float32Array.length, 24000);
          audioBuffer.getChannelData(0).set(float32Array);

          const source = playbackAudioContext.current.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(playbackAudioContext.current.destination);

          // Un-suspend context if browser autoplay policy blocked it
          if (playbackAudioContext.current.state === 'suspended') {
              playbackAudioContext.current.resume();
          }

          // Schedule playback continuously
          const currentTime = playbackAudioContext.current.currentTime;
          if (audioQueueTime.current < currentTime) {
              audioQueueTime.current = currentTime;
          }
          source.start(audioQueueTime.current);
          audioQueueTime.current += audioBuffer.duration;
      } catch (e) {
          console.error("Error playing audio chunk", e);
      }
  };

  const updatePersona = (personaName) => {
      setActivePersona(personaName);
      activePersonaRef.current = personaName;

      setMessages(prev => [...prev, {
         id: Date.now(),
         sender: 'System',
         role: 'bot',
         initials: '⚙️',
         time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
         text: `Switched active persona to ${personaName}.`
      }]);
  };

  const [interimTranscript, setInterimTranscript] = useState('');
  const recognitionRef = useRef(null);

  const startDebate = async () => {
       try {
           // Explicitly initialize AudioContext during a trusted user gesture to bypass AutoPlay blocks
           if (!playbackAudioContext.current) {
               playbackAudioContext.current = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
               if (playbackAudioContext.current.state === 'suspended') {
                   await playbackAudioContext.current.resume();
               }
           }
           audioQueueTime.current = playbackAudioContext.current.currentTime;
           
           if (ws.current && ws.current.readyState === WebSocket.OPEN) {
               ws.current.send(JSON.stringify({ clientContent: { action: 'kickOff' } }));
           }
           
           setHasStartedDebate(true);
           setMessages(prev => [...prev, {
              id: Date.now(),
              sender: 'System',
              role: 'bot',
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              text: `Autonomous War Room Debate initializing...`
           }]);
       } catch (e) {
           console.error("Audio Context initialization failed", e);
       }
  };

  const startRecording = async () => {
    // 1. Instantly kill ongoing AI voice playback so they stop talking over us
    if (playbackAudioContext.current) {
        playbackAudioContext.current.close();
        playbackAudioContext.current = null;
    }
    audioQueueTime.current = 0; // Reset queue time
    
    startAudioCapture();
  };

  const startAudioCapture = async () => {
     try {
      console.log('Requesting microphone access...');
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!recordingAudioContext.current) {
          recordingAudioContext.current = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      }

      // ---- Setup Speech Recognition for visual feedback ----
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SpeechRecognition) {
          recognitionRef.current = new SpeechRecognition();
          recognitionRef.current.continuous = true;
          recognitionRef.current.interimResults = true;

          recognitionRef.current.onresult = (event) => {
              let final = "";
              let interim = "";
              for (let i = event.resultIndex; i < event.results.length; ++i) {
                  if (event.results[i].isFinal) {
                      final += event.results[i][0].transcript;
                  } else {
                      interim += event.results[i][0].transcript;
                  }
              }
              setInterimTranscript(interim);

              if (final) {
                  setMessages(prev => [...prev, {
                      id: Date.now() + Math.random(),
                      sender: 'Deepak (Associate)',
                      role: 'human',
                      initials: 'D',
                      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                      text: final
                  }]);
                  setInterimTranscript(''); // clear interim once final
              }
          };

          recognitionRef.current.start();
      }

      const source = recordingAudioContext.current.createMediaStreamSource(stream.current);

      // Upgrade to AudioWorkletNode to handle raw PCM conversions without locking the UI thread
      await recordingAudioContext.current.audioWorklet.addModule('/pcm-worker.js');
      scriptNode.current = new AudioWorkletNode(recordingAudioContext.current, 'pcm-processor');

      scriptNode.current.port.onmessage = (event) => {
        const rawPcmBuffer = event.data; // This is an ArrayBuffer containing Int16 PCM

        const base64Audio = btoa(
           String.fromCharCode(...new Uint8Array(rawPcmBuffer))
        );

        if (ws.current && ws.current.readyState === WebSocket.OPEN) {
             const message = {
                 realtimeInput: {
                     mediaChunks: [{
                         mimeType: "audio/pcm;rate=16000",
                         data: base64Audio
                     }]
                 }
             };
             ws.current.send(JSON.stringify(message));
             console.log(`[DEBUG] Sent audio chunk (${base64Audio.length} bytes) to Gemini Proxy.`);
        }
      };

      source.connect(scriptNode.current);
      scriptNode.current.connect(recordingAudioContext.current.destination);

      setIsRecording(true);

      if (ws.current && ws.current.readyState === WebSocket.OPEN) {
          ws.current.send(JSON.stringify({ clientContent: { action: 'startRecording' } }));
      }

      setMessages(prev => [...prev, {
          id: Date.now(),
          sender: 'System',
          role: 'bot',
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          text: `Human override active. Simulating push-to-talk interrupt. Speak to the ${activePersonaRef.current} now.`
      }]);
      console.log("[DEBUG] Recording started successfully. Listening for audio...");
    } catch (err) {
      console.error('Error accessing microphone:', err);
      alert('Could not access microphone. Ensure you are on HTTPS or localhost.');
    }
  };

  const stopRecording = () => {
    if (scriptNode.current) {
      // Explicitly nullify the onmessage listener BEFORE disconnecting to immediately stop console spam
      scriptNode.current.port.onmessage = null;
      scriptNode.current.disconnect();
      scriptNode.current = null;
    }
    if (stream.current) {
      stream.current.getTracks().forEach(track => track.stop());
      stream.current = null;
    }
    // We intentionally DO NOT close playbackAudioContext.current here!
    
    if (recognitionRef.current) {
        recognitionRef.current.stop();
        setInterimTranscript('');
    }

    // Explicitly tell the server proxy that the human override is over
    if (ws.current && ws.current.readyState === WebSocket.OPEN && isRecording) {
        console.log("[DEBUG] Sending stop sequence to Proxy.");
        ws.current.send(JSON.stringify({ clientContent: { action: 'stopRecording' } }));
    }

    setIsRecording(false);
    console.log("[DEBUG] Recording stopped. Audio tracks and context closed.");
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Establish stable proxy WebSocket connection on mount
  useEffect(() => {
      // Prevent StrictMode double-connection race conditions
      if (!ws.current || ws.current.readyState === WebSocket.CLOSED) {
          initWebSocket();
      }

      return () => {
          // In React 18 dev mode, we avoid aggressively closing the socket on unmount
          // to survive the immediate remount, but we do trigger stopRecording.
          stopRecording();
      };
  }, []);

  return (
    <div className="app-container">
      {/* Loading Overlay */}
      {!serverStatus.isDataLoaded && (
        <div style={{
           position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
           background: 'rgba(15, 23, 42, 0.95)',
           zIndex: 9999, display: 'flex', flexDirection: 'column',
           alignItems: 'center', justifyContent: 'center',
           backdropFilter: 'blur(10px)'
        }}>
           <h2 style={{ color: 'white', marginBottom: '1rem', fontSize: '1.5rem', fontWeight: 600 }}>Initializing AI War Room</h2>
           <p style={{ color: 'var(--text-secondary)', marginBottom: '2rem' }}>
              Ingesting Secure Data Room... Ingested {serverStatus.processedFiles} of {serverStatus.totalFiles} documents
           </p>

           <div style={{ width: '300px', height: '8px', background: 'rgba(255,255,255,0.1)', borderRadius: '4px', overflow: 'hidden' }}>
              <div style={{
                 width: `${serverStatus.totalFiles > 0 ? (serverStatus.processedFiles / serverStatus.totalFiles) * 100 : 0}%`,
                 height: '100%',
                 background: 'var(--accent-primary)',
                 transition: 'width 0.3s ease-out'
              }}></div>
           </div>
           {serverStatus.currentFile && (
               <p style={{ color: 'var(--text-muted)', marginTop: '1rem', fontSize: '0.8rem', fontStyle: 'italic', maxWidth: '400px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                 Parsing: {serverStatus.currentFile}
               </p>
           )}
        </div>
      )}

      {/* Left Column: Context & Personas */}
      <div className="column left-panel glass-panel animate-fade-in" style={{ animationDelay: '0ms' }}>
        <div style={{ padding: '1.5rem', borderBottom: '1px solid var(--glass-border)' }}>
          <h2 className="text-gradient" style={{ fontSize: '1.25rem', fontWeight: 600 }}>War Room</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', marginTop: '0.25rem' }}>Live Audio Session</p>
        </div>

        <div style={{ flex: 1, padding: '1.5rem', overflowY: 'auto' }}>
          <h3 style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '1rem' }}>Knowledge Base</h3>
          <div style={{ background: 'rgba(255,255,255,0.03)', padding: '0.75rem', borderRadius: '8px', marginBottom: '0.5rem', fontSize: '0.875rem', borderLeft: '2px solid var(--success)' }}>📄 Q3_Financials_v2.xlsx</div>
          <div style={{ background: 'rgba(255,255,255,0.03)', padding: '0.75rem', borderRadius: '8px', marginBottom: '0.5rem', fontSize: '0.875rem', borderLeft: '2px solid var(--success)' }}>📑 Master_Service_Agreement.pdf</div>
          <div style={{ background: 'rgba(255,255,255,0.03)', padding: '0.75rem', borderRadius: '8px', marginBottom: '1.5rem', fontSize: '0.875rem', borderLeft: '2px solid var(--accent-primary)' }}>🌐 Live Web Feed</div>

          <h3 style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '1rem' }}>Active Agent</h3>

          {Object.keys(personas).map((persona) => (
              <div
                 key={persona}
                 onClick={() => updatePersona(persona)}
                 style={{
                     display: 'flex', alignItems: 'center', marginBottom: '0.75rem', gap: '0.75rem',
                     cursor: 'pointer',
                     padding: '0.5rem',
                     background: activePersona === persona ? 'rgba(255,255,255,0.1)' : 'transparent',
                     borderRadius: '8px',
                     border: activePersona === persona ? '1px solid var(--accent-primary)' : '1px solid transparent'
                 }}>
                <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: activePersona === persona ? 'var(--success)' : 'var(--text-muted)', boxShadow: activePersona === persona ? '0 0 8px var(--success)' : 'none' }}></div>
                <span style={{ fontSize: '0.9rem', color: activePersona === persona ? 'white' : 'var(--text-secondary)' }}>{persona}</span>
              </div>
          ))}
        </div>
      </div>

      {/* Center Column: Collaboration Chat */}
      <div className="column center-panel glass-panel animate-fade-in" style={{ animationDelay: '100ms', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '1.5rem', borderBottom: '1px solid var(--glass-border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <div style={{ width: '40px', height: '40px', borderRadius: '50%', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--glass-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>PE</div>
            <div>
              <h2 style={{ fontSize: '1.1rem', fontWeight: 500 }}>Deal Evaluation: Project Phoenix</h2>
              <p style={{ color: isConnected ? 'var(--success)' : 'var(--text-muted)', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                 <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: isConnected ? 'var(--success)' : 'var(--text-muted)', display: 'inline-block', boxShadow: isConnected ? '0 0 6px var(--success)' : 'none' }}></span>
                 {isConnected ? 'Connected to Gemini Live APIs' : 'Disconnected'}
              </p>
            </div>
          </div>
        </div>

        <div style={{ flex: 1, padding: '1.5rem', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
           {messages.map((msg) => (
             <div key={msg.id} style={{ display: 'flex', gap: '1rem', flexDirection: msg.role === 'human' ? 'row' : 'row-reverse' }}>
               <div style={{
                 width: '32px', height: '32px', borderRadius: '50%',
                 background: msg.role === 'bot' ? 'var(--accent-gradient)' : 'rgba(255,255,255,0.1)',
                 display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.8rem', fontWeight: 600,
                 flexShrink: 0
               }}>
                 {msg.initials}
               </div>
               <div style={{
                 background: msg.role === 'bot' ? 'rgba(94, 106, 210, 0.1)' : 'rgba(255,255,255,0.05)',
                 border: msg.role === 'bot' ? '1px solid var(--accent-primary)' : '1px solid transparent',
                 padding: '1rem',
                 borderRadius: msg.role === 'human' ? '0 12px 12px 12px' : '12px 0 12px 12px',
                 flex: 1,
                 maxWidth: '85%'
               }}>
                 <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem' }}>
                   <p style={{ fontSize: '0.8rem', color: msg.role === 'bot' ? 'var(--accent-primary)' : 'var(--text-muted)', fontWeight: 500 }}>{msg.sender}</p>
                   <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{msg.time}</p>
                 </div>
                 <p style={{ fontSize: '0.95rem', lineHeight: '1.6' }}>{msg.text}</p>
               </div>
             </div>
           ))}
           {interimTranscript && (
             <div style={{ display: 'flex', gap: '1rem', flexDirection: 'row', opacity: 0.7 }}>
               <div style={{
                 width: '32px', height: '32px', borderRadius: '50%',
                 background: 'rgba(255,255,255,0.1)',
                 display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.8rem', fontWeight: 600,
                 flexShrink: 0
               }}>
                 🎙️
               </div>
               <div style={{
                 background: 'transparent',
                 border: '1px dashed rgba(255,255,255,0.2)',
                 padding: '1rem',
                 borderRadius: '0 12px 12px 12px',
                 flex: 1,
                 maxWidth: '85%'
               }}>
                 <p style={{ fontSize: '0.95rem', fontStyle: 'italic', color: 'var(--text-muted)' }}>{interimTranscript}...</p>
               </div>
             </div>
           )}
           <div ref={messagesEndRef} />
        </div>

        <div style={{ padding: '1.5rem', borderTop: '1px solid var(--glass-border)' }}>
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
            {!hasStartedDebate ? (
               <button 
                  onClick={startDebate}
                  style={{ 
                    background: 'var(--success)', 
                    color: 'white', 
                    border: 'none', 
                    borderRadius: '24px', 
                    padding: '0.75rem 2rem', 
                    cursor: 'pointer', 
                    fontWeight: 600, 
                    display: 'flex', 
                    alignItems: 'center', 
                    gap: '0.5rem',
                    transition: 'all 0.2s',
                    boxShadow: '0 4px 14px 0 rgba(52, 211, 153, 0.39)'
                  }}>
                  ▶️ Start Autonomous Debate
               </button>
            ) : isRecording ? (
               <button 
                  onClick={stopRecording}
                  style={{ 
                    background: 'rgba(248, 113, 113, 0.2)', 
                    color: 'var(--danger)', 
                    border: '1px solid var(--danger)', 
                    borderRadius: '24px', 
                    padding: '0.75rem 2rem', 
                    cursor: 'pointer', 
                    fontWeight: 600, 
                    display: 'flex', 
                    alignItems: 'center', 
                    gap: '0.5rem',
                    transition: 'all 0.2s' 
                  }}>
                  <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: 'var(--danger)', display: 'inline-block', animation: 'pulse 1.5s infinite' }}></span>
                  Stop Overriding
               </button>
            ) : (
               <button 
                  onClick={startRecording}
                  style={{ 
                    background: 'var(--accent-primary)', 
                    color: 'white', 
                    border: 'none', 
                    borderRadius: '24px', 
                    padding: '0.75rem 2rem', 
                    cursor: 'pointer', 
                    fontWeight: 600, 
                    display: 'flex', 
                    alignItems: 'center', 
                    gap: '0.5rem',
                    transition: 'all 0.2s',
                    boxShadow: '0 4px 14px 0 rgba(94, 106, 210, 0.39)'
                  }}>
                  🎙️ Interject & Speak
               </button>
            )}
          </div>
        </div>
      </div>

      {/* Right Column: Interactive Panel */}
      <div className="column right-panel glass-panel animate-fade-in" style={{ animationDelay: '200ms', display: 'flex', flexDirection: 'column' }}>
         <div style={{ display: 'flex', borderBottom: '1px solid var(--glass-border)' }}>
           <button style={{ flex: 1, padding: '1rem', background: 'transparent', border: 'none', borderBottom: '2px solid var(--accent-primary)', color: 'white', fontWeight: 500, cursor: 'pointer', transition: 'background 0.2s' }}>Interactive Context</button>
           <button style={{ flex: 1, padding: '1rem', background: 'transparent', border: 'none', color: 'var(--text-secondary)', fontWeight: 500, cursor: 'pointer', transition: 'background 0.2s' }}>Draft Memo</button>
         </div>

         <div style={{ flex: 1, padding: '1.5rem', overflowY: 'auto' }}>
            <h3 style={{ fontSize: '1rem', fontWeight: 500, marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              EBITDA vs CAC Trend
              <span style={{ fontSize: '0.75rem', background: 'rgba(94, 106, 210, 0.2)', color: 'var(--accent-hover)', padding: '0.2rem 0.5rem', borderRadius: '4px' }}>From Private Data</span>
            </h3>

            {/* Mock Chart Area */}
            <div style={{ height: '180px', background: 'linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.01) 100%)', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.05)', padding: '1rem', marginBottom: '1.5rem', position: 'relative', overflow: 'hidden' }}>
              {/* Very Basic Mock Graph using CSS */}
              <div style={{ position: 'absolute', bottom: '1rem', left: '1rem', right: '1rem', height: '100px', display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
                 <div style={{ width: '15%', height: '80%', background: 'rgba(52, 211, 153, 0.6)', borderRadius: '4px' }}></div>
                 <div style={{ width: '15%', height: '70%', background: 'rgba(52, 211, 153, 0.6)', borderRadius: '4px' }}></div>
                 <div style={{ width: '15%', height: '55%', background: 'rgba(52, 211, 153, 0.6)', borderRadius: '4px' }}></div>
                 <div style={{ width: '15%', height: '40%', background: 'rgba(251, 191, 36, 0.6)', borderRadius: '4px' }}></div>
                 <div style={{ width: '15%', height: '30%', background: 'rgba(248, 113, 113, 0.6)', borderRadius: '4px' }}></div>
              </div>
              <div style={{ position: 'absolute', top: '10px', right: '10px', fontSize: '0.75rem', color: 'var(--text-muted)' }}>EBITDA Margins</div>
            </div>

            <h3 style={{ fontSize: '1rem', fontWeight: 500, marginBottom: '0.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              Relevant News Stream
              <span style={{ fontSize: '0.75rem', background: 'rgba(255, 255, 255, 0.1)', padding: '0.2rem 0.5rem', borderRadius: '4px' }}>Live Web</span>
            </h3>
            <div style={{ background: 'rgba(0,0,0,0.2)', padding: '1rem', borderRadius: '8px', borderLeft: '3px solid var(--accent-primary)', marginBottom: '0.75rem' }}>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>TechCrunch • 2 hrs ago</p>
              <h4 style={{ fontSize: '0.95rem', fontWeight: 500, marginBottom: '0.25rem' }}>Competitor X raises $50M Series B</h4>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Market consolidation continues as Customer Acquisition Costs rise across the sector. Several private equity players backing out of early stage deals in favor of secondary market aggregation.</p>
            </div>
         </div>
      </div>
    </div>
  );
}

export default App;
