import React, { useState, useRef, useEffect } from 'react';
import { ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import './App.css';

function App() {
  const [messages, setMessages] = useState([]);
  const [isRecording, setIsRecording] = useState(false);
  const isRecordingRef = useRef(false);
  const [hasStartedDebate, setHasStartedDebate] = useState(false);
  const [activePersona, setActivePersona] = useState('Financial Analyst');
  const activePersonaRef = useRef('Financial Analyst');
  const [isConnected, setIsConnected] = useState(false);
  const [insights, setInsights] = useState([]);
  const [chartData, setChartData] = useState(null);

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
  const pendingTextRef = useRef('');
  const interruptIdRef = useRef(0); // Add a sequence ID to track interruptions
  const accumulatedSpeechRef = useRef('');

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

        if (parsed.type === 'insightData') {
             console.log("[DEBUG] Received Insight Data:", parsed.data);
             if (parsed.data.insights && parsed.data.insights.length > 0) {
                 setInsights(parsed.data.insights);
             }
             if (parsed.data.chartData) {
                 setChartData(parsed.data.chartData);
             }
             return;
        }

        if (parsed.type === 'turnComplete') {
             console.log(`[DEBUG] Received turnComplete for ${parsed.name}. Calculating audio queue drain time...`);
             const completedText = pendingTextRef.current;
             pendingTextRef.current = ''; // Reset for the next speaker

             if (playbackAudioContext.current) {
                 const currentTime = playbackAudioContext.current.currentTime;
                 const delaySeconds = Math.max(0, audioQueueTime.current - currentTime);
                 console.log(`[DEBUG] Audio will finish playing in ${delaySeconds.toFixed(1)} seconds. Blocking UI update until then.`);

                 // 1. Wait for audio to finish playing, then show the text blob
                 const currentInterruptId = interruptIdRef.current;
                 setTimeout(() => {
                     if (currentInterruptId !== interruptIdRef.current) return; // Abort if user interrupted during the delay

                     // Add the completed text to the UI
                     if (completedText.trim()) {
                         setMessages(prev => [...prev, {
                             id: Date.now() + Math.random(),
                             sender: parsed.name + ' AI',
                             role: 'bot',
                             initials: 'AI',
                             time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                             text: completedText
                         }]);
                     }
                     
                     // 2. Add an explicit 2-second conversational pause before triggering the next agent
                     setTimeout(() => {
                         if (currentInterruptId !== interruptIdRef.current) return; // Abort second delay if interrupted
                         if (ws.current && ws.current.readyState === WebSocket.OPEN) {
                             console.log(`[DEBUG] Conversation delay complete. Telling proxy to advance the debate.`);
                             ws.current.send(JSON.stringify({
                                 clientContent: {
                                     action: 'audioFinished',
                                     transcript: parsed.transcript
                                 }
                             }));
                         }
                     }, 2000);
                     
                 }, delaySeconds * 1000 + 500); // Add 500ms safety buffer
             } else {
                 // Fallback if audio never engaged
                 const currentInterruptId = interruptIdRef.current;
                 if (completedText.trim()) {
                     setMessages(prev => [...prev, {
                         id: Date.now() + Math.random(), sender: parsed.name + ' AI', role: 'bot', initials: 'AI', time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), text: completedText
                     }]);
                 }
                 setTimeout(() => {
                     if (currentInterruptId !== interruptIdRef.current) return;
                     if (ws.current && ws.current.readyState === WebSocket.OPEN) {
                         ws.current.send(JSON.stringify({ clientContent: { action: 'audioFinished', transcript: parsed.transcript } }));
                     }
                 }, 4000); // Artificial 4 sec reading delay
             }
             return;
        }

        if (parsed.serverContent && parsed.serverContent.modelTurn) {
            const parts = parsed.serverContent.modelTurn.parts;
            for (const part of parts) {
                // 1. Buffer text silently so it doesn't appear before audio finishes
                if (part.text) {
                     pendingTextRef.current += part.text;
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
  const [textInput, setTextInput] = useState('');
  const recognitionRef = useRef(null);

  const handleSendText = (e) => {
      e.preventDefault();
      if (!textInput.trim() || !ws.current || ws.current.readyState !== WebSocket.OPEN) return;

      // Instantly kill ongoing AI voice playback so they stop talking over us
      if (playbackAudioContext.current) {
          playbackAudioContext.current.close();
          playbackAudioContext.current = null;
      }
      audioQueueTime.current = 0; // Reset queue time
      pendingTextRef.current = ''; // Wipe whatever text they were generating
      interruptIdRef.current += 1; // Block pending audio/UI timeouts from executing
      accumulatedSpeechRef.current = ''; // Clear the speech accumulator

      ws.current.send(JSON.stringify({
          clientContent: {
              action: 'sendText',
              text: textInput
          }
      }));

      setMessages(prev => [...prev, {
          id: Date.now() + Math.random(),
          sender: 'Deepak (Associate)',
          role: 'human',
          initials: 'D',
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          text: textInput
      }]);

      setTextInput('');
  };

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
    pendingTextRef.current = ''; // Wipe whatever text they were secretly generating
    interruptIdRef.current += 1; // Block pending audio/UI timeouts from executing
    accumulatedSpeechRef.current = ''; // Reset the speech tracking accumulator
    
    startAudioCapture();
  };

  const startAudioCapture = async () => {
     try {
      setIsRecording(true);
      isRecordingRef.current = true;

      // Only build the WebAudio graph if it doesn't already exist
      if (!stream.current) {
          console.log('Requesting microphone access...');
          stream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
          recordingAudioContext.current = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });

          // ---- Setup Speech Recognition for visual feedback ----
          const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
          if (SpeechRecognition) {
              recognitionRef.current = new SpeechRecognition();
              recognitionRef.current.continuous = true;
              recognitionRef.current.interimResults = true;

              recognitionRef.current.onresult = (event) => {
                  if (!isRecordingRef.current) return;

                  let final = "";
                  let interim = "";
                  for (let i = event.resultIndex; i < event.results.length; ++i) {
                      if (event.results[i].isFinal) {
                          final += event.results[i][0].transcript;
                          accumulatedSpeechRef.current += event.results[i][0].transcript + ' ';
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
                      setInterimTranscript('');
                  }
              };
          }

          const source = recordingAudioContext.current.createMediaStreamSource(stream.current);
          await recordingAudioContext.current.audioWorklet.addModule('/pcm-worker.js');
          scriptNode.current = new AudioWorkletNode(recordingAudioContext.current, 'pcm-processor');

          scriptNode.current.port.onmessage = (event) => {
             // Silently drop PCM packets if we are physically muted
             if (!isRecordingRef.current) return;

             const rawPcmBuffer = event.data;
             const base64Audio = btoa(String.fromCharCode(...new Uint8Array(rawPcmBuffer)));

             if (ws.current && ws.current.readyState === WebSocket.OPEN) {
                 ws.current.send(JSON.stringify({
                     realtimeInput: { mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: base64Audio }] }
                 }));
             }
          };

          source.connect(scriptNode.current);
          scriptNode.current.connect(recordingAudioContext.current.destination);
      }

      if (recognitionRef.current) {
          try { recognitionRef.current.start(); } catch(e){}
      }

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
      setIsRecording(false);
      isRecordingRef.current = false;
    }
  };

  const stopRecording = () => {
    isRecordingRef.current = false;
    setIsRecording(false);

    if (recognitionRef.current) {
        recognitionRef.current.stop();
        setInterimTranscript('');
    }

    if (ws.current && ws.current.readyState === WebSocket.OPEN) {
        console.log("[DEBUG] Sending stop sequence to Proxy.");
        ws.current.send(JSON.stringify({ 
            clientContent: { 
                action: 'stopRecording',
                text: accumulatedSpeechRef.current.trim()
            } 
        }));
    }

    console.log("[DEBUG] Recording paused. Microphone graph kept hot for seamless resume.");
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
            ) : (
               <form onSubmit={handleSendText} style={{ display: 'flex', width: '100%', gap: '10px', alignItems: 'center' }}>
                   <input
                      type="text"
                      value={textInput}
                      onChange={(e) => setTextInput(e.target.value)}
                      placeholder="Type a message to the War Room..."
                      style={{
                          flex: 1,
                          background: 'rgba(255,255,255,0.05)',
                          border: '1px solid var(--glass-border)',
                          color: 'white',
                          padding: '0.75rem 1rem',
                          borderRadius: '24px',
                          outline: 'none',
                          fontSize: '0.95rem'
                      }}
                   />
                   <button
                      type="submit"
                      disabled={!textInput.trim()}
                      style={{
                          background: textInput.trim() ? 'var(--accent-primary)' : 'rgba(255,255,255,0.1)',
                          color: textInput.trim() ? 'white' : 'rgba(255,255,255,0.3)',
                          border: 'none',
                          borderRadius: '50%',
                          width: '42px',
                          height: '42px',
                          display: 'flex',
                          justifyContent: 'center',
                          alignItems: 'center',
                          cursor: textInput.trim() ? 'pointer' : 'not-allowed',
                          transition: 'all 0.2s',
                          boxShadow: textInput.trim() ? '0 4px 14px 0 rgba(94, 106, 210, 0.39)' : 'none',
                          flexShrink: 0
                      }}>
                      ↗️
                   </button>
                   {isRecording ? (
                       <button
                          type="button"
                          onClick={stopRecording}
                          style={{
                            background: 'rgba(248, 113, 113, 0.2)',
                            color: 'var(--danger)',
                            border: '1px solid var(--danger)',
                            borderRadius: '24px',
                            padding: '0.75rem 1.5rem',
                            cursor: 'pointer',
                            fontWeight: 600,
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.5rem',
                            transition: 'all 0.2s',
                            flexShrink: 0
                          }}>
                          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--danger)', display: 'inline-block', animation: 'pulse 1.5s infinite' }}></span>
                          Stop Mic
                       </button>
                    ) : (
                       <button
                          type="button"
                          onClick={startRecording}
                          style={{
                            background: 'rgba(255,255,255,0.1)',
                            color: 'white',
                            border: '1px solid rgba(255,255,255,0.2)',
                            borderRadius: '24px',
                            padding: '0.75rem 1.5rem',
                            cursor: 'pointer',
                            fontWeight: 600,
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.5rem',
                            transition: 'all 0.2s',
                            flexShrink: 0
                          }}>
                          🎙️ Talk
                       </button>
                    )}
               </form>
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
            {/* Dynamic Recharts Chart Area or Fallback Mock */ }
            {chartData ? (
               <>
                 <h3 style={{ fontSize: '1rem', fontWeight: 500, marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                   {chartData.title}
                   <span style={{ fontSize: '0.75rem', background: 'rgba(94, 106, 210, 0.2)', color: 'var(--accent-hover)', padding: '0.2rem 0.5rem', borderRadius: '4px' }}>Extracted Insight</span>
                 </h3>
                 <div style={{ height: '220px', background: 'linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.01) 100%)', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.05)', padding: '1rem 1rem 1rem 0', marginBottom: '1.5rem', position: 'relative', overflow: 'hidden' }}>
                    <ResponsiveContainer width="100%" height="100%">
                        {chartData.type === 'bar' ? (
                            <BarChart data={chartData.data}>
                                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" vertical={false} />
                                <XAxis dataKey={chartData.xAxisKey || 'name'} stroke="var(--text-muted)" fontSize={12} tickLine={false} axisLine={false} />
                                <YAxis stroke="var(--text-muted)" fontSize={12} tickLine={false} axisLine={false} />
                                <Tooltip contentStyle={{ backgroundColor: 'rgba(15, 23, 42, 0.9)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', color: 'white' }} itemStyle={{ color: 'white' }} cursor={{ fill: 'rgba(255,255,255,0.05)' }} />
                                <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                                {chartData.lines && chartData.lines.map((line, idx) => (
                                    <Bar key={idx} dataKey={line.key} name={line.name} fill={line.color || 'var(--accent-primary)'} radius={[4, 4, 0, 0]} />
                                ))}
                            </BarChart>
                        ) : (
                            <LineChart data={chartData.data}>
                                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" vertical={false} />
                                <XAxis dataKey={chartData.xAxisKey || 'name'} stroke="var(--text-muted)" fontSize={12} tickLine={false} axisLine={false} />
                                <YAxis stroke="var(--text-muted)" fontSize={12} tickLine={false} axisLine={false} />
                                <Tooltip contentStyle={{ backgroundColor: 'rgba(15, 23, 42, 0.9)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', color: 'white' }} itemStyle={{ color: 'white' }} />
                                <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                                {chartData.lines && chartData.lines.map((line, idx) => (
                                    <Line key={idx} type="monotone" dataKey={line.key} name={line.name} stroke={line.color || 'var(--accent-primary)'} strokeWidth={3} dot={{ r: 4, fill: line.color || 'var(--accent-primary)', strokeWidth: 2, stroke: 'var(--bg-dark)' }} activeDot={{ r: 6 }} />
                                ))}
                            </LineChart>
                        )}
                    </ResponsiveContainer>
                 </div>
               </>
            ) : (
                <>
                    <h3 style={{ fontSize: '1rem', fontWeight: 500, marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      EBITDA vs CAC Trend
                      <span style={{ fontSize: '0.75rem', background: 'rgba(94, 106, 210, 0.2)', color: 'var(--accent-hover)', padding: '0.2rem 0.5rem', borderRadius: '4px' }}>From Private Data</span>
                    </h3>
                    <div style={{ height: '180px', background: 'linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.01) 100%)', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.05)', padding: '1rem', marginBottom: '1.5rem', position: 'relative', overflow: 'hidden' }}>
                      <div style={{ position: 'absolute', bottom: '1rem', left: '1rem', right: '1rem', height: '100px', display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
                         <div style={{ width: '15%', height: '80%', background: 'rgba(52, 211, 153, 0.6)', borderRadius: '4px' }}></div>
                         <div style={{ width: '15%', height: '70%', background: 'rgba(52, 211, 153, 0.6)', borderRadius: '4px' }}></div>
                         <div style={{ width: '15%', height: '55%', background: 'rgba(52, 211, 153, 0.6)', borderRadius: '4px' }}></div>
                         <div style={{ width: '15%', height: '40%', background: 'rgba(251, 191, 36, 0.6)', borderRadius: '4px' }}></div>
                         <div style={{ width: '15%', height: '30%', background: 'rgba(248, 113, 113, 0.6)', borderRadius: '4px' }}></div>
                      </div>
                      <div style={{ position: 'absolute', top: '10px', right: '10px', fontSize: '0.75rem', color: 'var(--text-muted)' }}>EBITDA Margins</div>
                    </div>
                </>
            )}

            {/* Dynamic Key Elements Section */}
            {insights.length > 0 && (
                <>
                    <h3 style={{ fontSize: '1rem', fontWeight: 500, marginBottom: '0.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      Key Elements
                      <span style={{ fontSize: '0.75rem', background: 'rgba(52, 211, 153, 0.2)', color: 'var(--success)', padding: '0.2rem 0.5rem', borderRadius: '4px' }}>Live Inference</span>
                    </h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1.5rem' }}>
                        {insights.map((insight, idx) => (
                            <div key={idx} style={{ background: 'rgba(255,255,255,0.03)', padding: '0.75rem 1rem', borderRadius: '8px', borderLeft: '3px solid var(--success)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{insight.label}</span>
                                <span style={{ fontSize: '0.95rem', fontWeight: 600, color: 'white' }}>{insight.value}</span>
                            </div>
                        ))}
                    </div>
                </>
            )}

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
