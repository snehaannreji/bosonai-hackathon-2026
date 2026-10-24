
import { useRef, useState } from "react";
import "./App.css";

type ChatMessage = {
  role: "you" | "student";
  text: string;
};

const STUDENT_PROMPT = `
You are an AI student participating in a learning session with a human teacher.

Your role:
1. Act like a curious student who is learning the topic from the human teacher.
2. Listen carefully to the teacher's explanations and respond naturally.
3. Ask thoughtful questions when something is unclear or when you need more explanation.
4. Occasionally summarize what you have understood in your own words.
5. If you misunderstand something, be open to correction and update your understanding.
6. When appropriate, give examples of your understanding, but do not take over the teaching role.
7. Do not pretend to understand everything. If you are confused, say so and ask for clarification.
8. Keep responses concise, conversational, and suitable for spoken interaction.
9. Encourage the teacher to elaborate by asking relevant follow-up questions.
10. Do not lecture the human teacher or automatically quiz them.

Your goal is to make the interaction feel like a real student learning from a teacher.

Begin by greeting the teacher and asking them to introduce the topic or explain where they would like to start.
`;

const REALTIME_URL = "wss://api.boson.ai/v1/realtime?model=higgs-realtime";

export default function App() {
  const socketRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const nextPlayTimeRef = useRef(0);
  const connectingRef = useRef(false);

  // NEW: Microphone refs go here
  const micStreamRef = useRef<MediaStream | null>(null);
  const micContextRef = useRef<AudioContext | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const micWorkletRef = useRef<AudioWorkletNode | null>(null);
  const conversationHistoryRef = useRef<string[]>([]);

  // NEW: Microphone state
  const [isMicOn, setIsMicOn] = useState(false);

  const [topic, setTopic] = useState("");
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState("Disconnected");
  const [events, setEvents] = useState<string[]>([]);

  const [understandingSummary, setUnderstandingSummary] = useState(
  "I haven't learned anything yet. Teach me something!");

const [understoodConcepts, setUnderstoodConcepts] = useState<string[]>([]);

const [openQuestions, setOpenQuestions] = useState<string[]>([]);

const [isUpdatingUnderstanding, setIsUpdatingUnderstanding] = useState(false);

  function logEvent(text: string) {
    setEvents((previous) => [...previous.slice(-39), text]);
  }

  
function floatToBase64PCM(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);

  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    const pcm = sample < 0
      ? Math.round(sample * 32768)
      : Math.round(sample * 32767);

    view.setInt16(i * 2, pcm, true);
  }

  // Avoid spreading a large array into String.fromCharCode.
  let binary = "";
  const step = 8192;

  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + step, bytes.length))
    );
  }

  return btoa(binary);
}

function resampleTo24k(
  input: Float32Array,
  inputRate: number
): Float32Array {
  if (inputRate === 24000) return input;

  const outputLength = Math.floor(
    input.length * 24000 / inputRate
  );
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const position = i * inputRate / 24000;
    const left = Math.floor(position);
    const fraction = position - left;
    const right = Math.min(left + 1, input.length - 1);

    output[i] =
      input[left] * (1 - fraction) +
      input[right] * fraction;
  }

  return output;
}


async function startMicrophone() {
  const socket = socketRef.current;

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    setStatus("Connect to Boson before starting the microphone.");
    return;
  }

  if (micStreamRef.current) return;

  try {
    setStatus("Requesting microphone permission...");

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: true,
        channelCount: 1,
      },
    });

    micStreamRef.current = stream;

    // Use the browser's preferred sample rate, then resample explicitly.
    const context = new AudioContext();
    await context.audioWorklet.addModule("/capture-processor.js");
    await context.resume();

    micContextRef.current = context;

    const source = context.createMediaStreamSource(stream);
    micSourceRef.current = source;

    const worklet = new AudioWorkletNode(
      context,
      "capture-processor"
    );
    micWorkletRef.current = worklet;

    worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const currentSocket = socketRef.current;

      if (!currentSocket ||
          currentSocket.readyState !== WebSocket.OPEN) {
        return;
      }

      const input = event.data as Float32Array;
      const resampled = resampleTo24k(input, context.sampleRate);
      const audio = floatToBase64PCM(resampled);

      currentSocket.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio,
        })
      );
    };

    source.connect(worklet);

    // A silent destination connection keeps the worklet processing.
    const mute = context.createGain();
    mute.gain.value = 0;
    worklet.connect(mute);
    mute.connect(context.destination);

    setIsMicOn(true);
    setStatus("Listening — explain your concept!");
    logEvent(`Microphone started at ${context.sampleRate} Hz`);
  } catch (error) {
    stopMicrophone();

    setStatus(
      error instanceof Error
        ? `Microphone error: ${error.message}`
        : "Could not start microphone"
    );
  }
}


function stopMicrophone() {
  micWorkletRef.current?.port.close();
  micWorkletRef.current?.disconnect();
  micSourceRef.current?.disconnect();

  micStreamRef.current?.getTracks().forEach((track) => track.stop());

  if (micContextRef.current &&
      micContextRef.current.state !== "closed") {
    void micContextRef.current.close();
  }

  micWorkletRef.current = null;
  micSourceRef.current = null;
  micStreamRef.current = null;
  micContextRef.current = null;

  setIsMicOn(false);

  if (socketRef.current?.readyState === WebSocket.OPEN) {
    setStatus("Connected — microphone off");
  }
}


  
async function updateUnderstandingPanel() {
  console.log("Starting understanding analysis...");
  setIsUpdatingUnderstanding(true);

  let analysisSocket: WebSocket | null = null;

  try {
    const tokenResponse = await fetch("/api/token");
    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || !tokenData.value) {
      throw new Error(tokenData.error || "Could not get analysis token");
    }

    const history = conversationHistoryRef.current.join("\n\n");

    const prompt = `
    You are tracking your own understanding as a student being taught by a human.

    ${topic.trim() ? `The topic is: ${topic.trim()}` : ""}

    Here is the conversation so far:
    ${history}

    Reflect honestly on what you have learned. Do not act as the teacher.
    Return ONLY valid JSON with exactly these fields:
    {
      "summary": "A short first-person summary of what I have learned",
      "understoodConcepts": ["Concepts I believe I understand"],
      "openQuestions": ["Questions or concepts I am still confused about"]
    }

    Do not claim to understand something unless the conversation supports it.
    Use empty arrays if appropriate.
    `;

    analysisSocket = new WebSocket(REALTIME_URL, [
      "realtime",
      `bai-client-secret.${tokenData.value}`,
    ]);

    const socket = analysisSocket;
    let requestSent = false;

    socket.onopen = () => {
      console.log("Analysis WebSocket connected");
      socket.send(
        JSON.stringify({
          type: "session.update",
          session: {
            model: "higgs-realtime",
            instructions:
              "You are a text-only assistant that returns the requested JSON accurately.",
            output_modalities: ["text"],
          },
        })
      );
    };

    socket.onmessage = (event) => {
      
      let data: Record<string, any>;

      try {
        data = JSON.parse(event.data);
        
      } catch {
        return;
      }

      console.log("Analysis event received:", data.type, data);

      if (data.type === "error") {
        console.error("Understanding analysis error:", data);
        setIsUpdatingUnderstanding(false);
        socket.close();
        return;
      }

      if ((data.type === "session.created" || data.type === "session.updated") && !requestSent) {
        requestSent = true;

        socket.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: prompt }],
            },
          })
        );

        socket.send(JSON.stringify({ type: "response.create" }));
      }

      if (data.type === "response.done") {
        try {
          const output = data.response?.output;

          const rawText = Array.isArray(output)
            ? output
                .flatMap((item: any) =>
                  Array.isArray(item.content) ? item.content : []
                )
                .map((content: any) =>
                  typeof content.text === "string" ? content.text : ""
                )
                .filter((text: string) => text.length > 0)
                .join("\n")
            : "";

          const cleanedText = rawText
            .replace(/^```(?:json)?\s*/i, "")
            .replace(/\s*```$/, "")
            .trim();

          const result = JSON.parse(cleanedText);

          if (
            typeof result.summary !== "string" ||
            !Array.isArray(result.understoodConcepts) ||
            !Array.isArray(result.openQuestions)
          ) {
            throw new Error("Analysis response has an unexpected format");
          }

          setUnderstandingSummary(result.summary);
          setUnderstoodConcepts(
            result.understoodConcepts.filter(
              (item: unknown): item is string => typeof item === "string"
            )
          );
          setOpenQuestions(
            result.openQuestions.filter(
              (item: unknown): item is string => typeof item === "string"
            )
          );
        } catch (error) {
          console.error("Could not parse understanding analysis:", error);
        } finally {
          setIsUpdatingUnderstanding(false);
          socket.close();
        }
      }
    };

    socket.onerror = () => {
      console.error("Understanding analysis WebSocket error");
      setIsUpdatingUnderstanding(false);
    };

    socket.onclose = () => {
      setIsUpdatingUnderstanding(false);
    };
  } catch (error) {
    console.error("Understanding analysis failed:", error);
    setIsUpdatingUnderstanding(false);
    analysisSocket?.close();
  }
}


  async function connect() {
    if (
      connectingRef.current ||
      socketRef.current?.readyState === WebSocket.OPEN ||
      socketRef.current?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }

    connectingRef.current = true;
    setStatus("Getting temporary token...");

    try {
      const tokenResponse = await fetch("/api/token");
      const tokenData = await tokenResponse.json();

      if (!tokenResponse.ok || !tokenData.value) {
        throw new Error(tokenData.error || "Could not get token");
      }

      // Create/resume audio inside the user's click action.
      const audioContext = new AudioContext({ sampleRate: 24000 });
      await audioContext.resume();
      audioContextRef.current = audioContext;
      nextPlayTimeRef.current = audioContext.currentTime;

      const socket = new WebSocket(REALTIME_URL, [
        "realtime",
        `bai-client-secret.${tokenData.value}`,
      ]);

      socketRef.current = socket;
      setStatus("Connecting...");

      socket.onopen = () => {
        connectingRef.current = false;
        setStatus("Connected");
        logEvent("WebSocket connected");

        socket.send(
          JSON.stringify({
            type: "session.update",
            session: {
              model: "higgs-realtime",
              instructions:
                STUDENT_PROMPT +
                (topic.trim()
                  ? ` The concept being taught is: ${topic.trim()}.`
                  : ""),
              output_modalities: ["audio"],
              audio: {
               input: {
                  format: { type: "audio/pcm", rate: 24000 },
                  transcription: {
                    model: "higgs-stt-3.1",
                    language: "en",
                  },
                  turn_detection: {
                    type: "server_vad",
                  },
                },
                output: {
                  format: { type: "audio/pcm", rate: 24000 },
                  voice: "default",
                },
              },
            },
          })
        );
      };

      socket.onmessage = (event) => {
        let data: Record<string, any>;

        try {
          data = JSON.parse(event.data);
        } catch {
          logEvent("Received a non-JSON event");
          return;
        }

        logEvent(data.type || "Unknown event");

        if (data.type === "conversation.item.input_audio_transcription.completed") {
          const transcript = data.transcript;

          if (typeof transcript === "string" && transcript.trim()) {
            conversationHistoryRef.current.push(
              `Human (teacher): ${transcript}`
            );
            setMessages((previous) => [
              ...previous,
              { role: "you", text: transcript },
            ]);
          }
        }
        
        if (data.type === "session.created") {
          setStatus("Ready — teach your student!");
        }

        if (data.type === "error") {
          console.error("Boson realtime error:", data);
          setStatus(
            data.error?.message || "Realtime API returned an error"
          );
        }

        if (data.type === "response.output_audio_transcript.delta") {
          const text = data.delta;
          if (typeof text === "string" && text.length > 0) {
            setMessages((previous) => {
              const last = previous[previous.length - 1];

              if (last?.role === "student") {
                return [
                  ...previous.slice(0, -1),
                  { ...last, text: last.text + text },
                ];
              }

              return [...previous, { role: "student", text }];
            });
          }
        }

        if (
          data.type === "response.output_audio.delta" &&
          typeof data.delta === "string"
        ) {
          playPcmAudio(data.delta);
        }

        
        if (data.type === "response.done") {
          const output = data.response?.output;

          if (Array.isArray(output)) {
            const transcript = output
              .flatMap((item: any) =>
                Array.isArray(item.content) ? item.content : []
              )
              .map((content: any) => content.transcript || "")
              .filter((text: string) => text.length > 0)
              .join(" ");

            if (transcript) {
              console.log("Completed student response:", transcript);

              conversationHistoryRef.current.push(
                `AI student: ${transcript}`
              );

              void updateUnderstandingPanel();
            }
          }
        }

      };

      socket.onerror = () => {
        setStatus("WebSocket error — check the event log and console");
        connectingRef.current = false;
      };

      socket.onclose = (event) => {
        connectingRef.current = false;
        setStatus(`Disconnected (${event.code})`);
        logEvent(`Socket closed: ${event.code} ${event.reason}`);
      };
    } catch (error) {
      connectingRef.current = false;
      setStatus(
        error instanceof Error ? error.message : "Connection failed"
      );
    }
  }

  function playPcmAudio(base64: string) {
    const context = audioContextRef.current;
    if (!context) return;

    try {
      const binary = atob(base64);
      const samples = new Int16Array(binary.length / 2);

      for (let i = 0; i < samples.length; i++) {
        const low = binary.charCodeAt(i * 2);
        const high = binary.charCodeAt(i * 2 + 1);
        let value = low | (high << 8);

        if (value >= 32768) value -= 65536;
        samples[i] = value;
      }

      const audioBuffer = context.createBuffer(
        1,
        samples.length,
        24000
      );

      const channel = audioBuffer.getChannelData(0);

      for (let i = 0; i < samples.length; i++) {
        channel[i] = samples[i] / 32768;
      }

      const source = context.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(context.destination);

      const startAt = Math.max(
        context.currentTime + 0.03,
        nextPlayTimeRef.current
      );

      source.start(startAt);
      nextPlayTimeRef.current = startAt + audioBuffer.duration;
    } catch (error) {
      console.error("Could not play audio chunk:", error);
    }
  }

  function sendMessage() {
    const socket = socketRef.current;
    const text = message.trim();

    if (!text || socket?.readyState !== WebSocket.OPEN) return;

    setMessages((previous) => [...previous, { role: "you", text }]);
    conversationHistoryRef.current.push(`Human (teacher): ${text}`);
    setMessage("");

    socket.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      })
    );

    socket.send(JSON.stringify({ type: "response.create" }));
  }

  // stopMicrophone();

  function disconnect() {
    socketRef.current?.close();
    socketRef.current = null;
    connectingRef.current = false;

    audioContextRef.current?.close();
    audioContextRef.current = null;
    nextPlayTimeRef.current = 0;

    setStatus("Disconnected");
  }

  return (
    <main className="app">
      <header>
        <h1>AI Student</h1>
        <p>Teach a concept. See what your student learns.</p>
      </header>

      <section className="panel">
        <label htmlFor="topic">What concept will you teach?</label>
        <input
          id="topic"
          value={topic}
          onChange={(event) => setTopic(event.target.value)}
          placeholder="e.g. Neural networks, recursion, photosynthesis"
          disabled={status === "Connected" || status.startsWith("Ready")}
        />

        <div className="connection">
          <span>{status}</span>
          {status === "Disconnected" ||
          status.startsWith("Disconnected (") ||
          status.startsWith("Getting") ||
          status.startsWith("Connecting") ? (
            <button onClick={connect} disabled={connectingRef.current}>
              Connect
            </button>
          ) : (
            <button className="secondary" onClick={disconnect}>
              Disconnect
            </button>
          )}

          {/* NEW: Microphone button */}
          <button
            onClick={isMicOn ? stopMicrophone : startMicrophone}
            disabled={
              status === "Disconnected" ||
              status.startsWith("Disconnected (") ||
              status.startsWith("Connecting") ||
              status.startsWith("Getting")
            }
          >
            {isMicOn ? "Stop speaking" : "Start speaking"}
          </button>
        </div>
      </section>

      <section className="chat panel">
        <h2>Lesson conversation</h2>

        {messages.length === 0 && (
          <p className="muted">
            Connect, then send a message to start teaching your AI student.
          </p>
        )}

        {messages.map((item, index) => (
          <article className={`bubble ${item.role}`} key={index}>
            <strong>{item.role === "you" ? "You" : "AI Student"}</strong>
            <p>{item.text}</p>
          </article>
        ))}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            sendMessage();
          }}
          className="composer"
        >
          <input
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Explain a concept to your student..."
            disabled={status !== "Ready — teach your student!"}
          />
          <button
            type="submit"
            disabled={
              !message.trim() ||
              status !== "Ready — teach your student!"
            }
          >
            Send
          </button>
        </form>
      </section>

      <section className="understanding-panel">
        <h2>My Understanding</h2>
        {isUpdatingUnderstanding && (
          <p>I'm reflecting on what I've learned...</p>
        )}

        <div className="understanding-section">
          <h3>What I've learned</h3>
          <p>{understandingSummary}</p>
        </div>

        <div className="understanding-section">
          <h3>What I understand</h3>
          {understoodConcepts.length === 0 ? (
            <p>I'm still learning. Teach me a concept!</p>
          ) : (
            <ul>
              {understoodConcepts.map((concept, index) => (
                <li key={index}>{concept}</li>
              ))}
            </ul>
          )}
        </div>

        <div className="understanding-section">
          <h3>What I'm confused about</h3>
          {openQuestions.length === 0 ? (
            <p>I don't have any questions yet.</p>
          ) : (
            <ul>
              {openQuestions.map((question, index) => (
                <li key={index}>{question}</li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <details className="panel">
        <summary>Debug events ({events.length})</summary>
        <ol className="event-list">
          {events.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ol>
      </details>
    </main>
  );
}
