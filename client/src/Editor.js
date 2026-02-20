import React, { useEffect, useMemo, useRef, useState } from "react";
import MonacoEditor from "@monaco-editor/react";

import { db } from "./auth/firebase";
import { doc, setDoc, onSnapshot, serverTimestamp } from "firebase/firestore";

const templates = {
  c: `#include <stdio.h>
int main() {
  int a,b;
  scanf("%d %d",&a,&b);
  printf("%d\\n", a+b);
  return 0;
}`,
  cpp: `#include <bits/stdc++.h>
using namespace std;
int main(){
  int a,b; cin>>a>>b;
  cout << (a+b) << "\\n";
  return 0;
}`,
  java: `import java.util.*;
public class Main {
  public static void main(String[] args){
    Scanner sc = new Scanner(System.in);
    int a=sc.nextInt(), b=sc.nextInt();
    System.out.println(a+b);
  }
}`,
  python: `a,b = map(int, input().split())
print(a+b)
`,
  javascript: `let a = 10;
let b = 20;
console.log("Answer =", a+b);
`,
};

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < (s || "").length; i++) h = (h << 5) - h + s.charCodeAt(i);
  return h;
}
const FALLBACK_COLORS = ["#22c55e", "#60a5fa", "#f59e0b", "#f472b6", "#a78bfa", "#fb7185"];
function fallbackColorFor(socketId) {
  return FALLBACK_COLORS[Math.abs(hashCode(socketId)) % FALLBACK_COLORS.length];
}

function safeCssId(id) {
  return String(id || "").replace(/[^a-zA-Z0-9_-]/g, "");
}

function explainLine(line) {
  const t = (line || "").trim();
  if (!t) return null;

  if (t.startsWith("import ")) {
    return {
      meaning: "Imports modules/packages into this file.",
      use: "Used to reuse code from other files/libraries.",
      importance: "Helps keep code modular and organized.",
      alternative: "In Node/CommonJS you can use: const x = require('x')",
    };
  }

  if (t.startsWith("const ") || t.startsWith("let ") || t.startsWith("var ")) {
    return {
      meaning: "Creates a variable in JavaScript.",
      use: "Stores values you want to use later.",
      importance: "Variables are essential for logic.",
      alternative: "Prefer const when value won’t change; let when it will.",
    };
  }

  if (t.includes("socket.on(")) {
    return {
      meaning: "Listens for a socket event.",
      use: "Receives real-time updates (chat/code).",
      importance: "Main part of collaboration.",
      alternative: "You can use any custom event name in socket.on().",
    };
  }

  if (t.includes("socket.emit(")) {
    return {
      meaning: "Sends a socket event.",
      use: "Broadcasts your changes to others.",
      importance: "Enables live collaboration.",
      alternative: "emit() can send any JSON payload.",
    };
  }

  return {
    meaning: "A JavaScript statement/instruction.",
    use: "Part of your program logic.",
    importance: "Every line contributes to behavior.",
    alternative: "Often multiple valid ways exist to write the same logic.",
  };
}

// ✅ ADD-ON (cursor-related): motion arrow helper
function motionArrow(motion) {
  const dir = motion?.dir;
  if (dir === "left") return "←";
  if (dir === "right") return "→";
  if (dir === "up") return "↑";
  if (dir === "down") return "↓";
  return "";
}

export default function Editor({ socket, roomId, username, learningMode, onlineUsers = [] }) {
  const editorRef = useRef(null);
  const monacoRef = useRef(null);

  const isRemoteChange = useRef(false);
  const hasAskedGoal = useRef(false);

  const [aiReport, setAiReport] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);

  const [output, setOutput] = useState([]);
  const [hasRuntimeError, setHasRuntimeError] = useState(false);

  const [language, setLanguage] = useState("javascript");
  const [stdin, setStdin] = useState("");

  const [cursorLine, setCursorLine] = useState("");
  const explanation = learningMode ? explainLine(cursorLine) : null;

  // ---- live cursor refs ----
  const remoteDecorationsRef = useRef({}); // socketId -> decorationIds
  const remoteWidgetsRef = useRef({}); // socketId -> contentWidget
  const injectedCssRef = useRef({}); // cssId -> true
  const lastCursorEmit = useRef(0);

  // ✅ People Windows state
  const [peers, setPeers] = useState({}); // socketId -> {username,color,language,position,lastSeen}
  const [windowIndex, setWindowIndex] = useState(0);

  // ✅ ADD-ON: keep my socketId ref so we can ignore self cursor updates safely
  const mySocketIdRef = useRef("");
  useEffect(() => {
    mySocketIdRef.current = socket?.id || "";
  }, [socket?.id]);

  // ✅ ADD-ON (Canva-style pointer): overlay wrapper + remote pointers state
  const editorBoxRef = useRef(null);
  const [remotePointers, setRemotePointers] = useState({}); // socketId -> {x,y,username,color,lastSeen}

  // ✅ Firestore code doc (room-specific)
  const codeDocRef = useMemo(() => {
    if (!roomId) return null;
    return doc(db, "rooms", roomId, "files", "main");
  }, [roomId]);

  const ensureCursorCss = (socketId, color) => {
    const sid = safeCssId(socketId);
    if (injectedCssRef.current[sid]) return;
    injectedCssRef.current[sid] = true;

    const style = document.createElement("style");
    style.id = `rc-style-${sid}`;
    style.innerHTML = `
      .rc-caret-${sid}{
        border-left: 2px solid ${color} !important;
        margin-left: -1px;
      }
      .rc-sel-${sid}{
        background: ${color}22 !important;
      }
      .rc-name-${sid}{
        background: ${color};
        color: white;
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 800;
        box-shadow: 0 6px 16px rgba(0,0,0,0.35);
        transform: translateY(-6px);
        white-space: nowrap;
        pointer-events: none;
      }
    `;
    document.head.appendChild(style);
  };

  const removeRemoteCursor = (socketId) => {
    const editor = editorRef.current;
    if (!editor) return;

    const ids = remoteDecorationsRef.current[socketId] || [];
    editor.deltaDecorations(ids, []);
    delete remoteDecorationsRef.current[socketId];

    const w = remoteWidgetsRef.current[socketId];
    if (w) {
      editor.removeContentWidget(w);
      delete remoteWidgetsRef.current[socketId];
    }
  };

  // ✅ FIX (related to duplicate/stale users): auto cleanup stale peers/pointers on reload/network glitches
  useEffect(() => {
    const STALE_MS = 15000; // 15s
    const interval = setInterval(() => {
      const now = Date.now();

      // cleanup peers
      setPeers((prev) => {
        const next = { ...prev };
        for (const sid of Object.keys(next)) {
          const last = next[sid]?.lastSeen || 0;
          if (last && now - last > STALE_MS) {
            removeRemoteCursor(sid); // also remove decorations/widgets
            delete next[sid];
          }
        }
        return next;
      });

      // cleanup pointers
      setRemotePointers((prev) => {
        const next = { ...prev };
        for (const sid of Object.keys(next)) {
          const last = next[sid]?.lastSeen || 0;
          if (last && now - last > STALE_MS) {
            delete next[sid];
          }
        }
        return next;
      });
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  // ✅ Seed peers from presence (so People Windows never shows 0/0 just because cursor not moved)
  useEffect(() => {
    if (!onlineUsers?.length) return;

    setPeers((prev) => {
      const next = { ...prev };
      for (const u of onlineUsers) {
        if (!u?.socketId) continue;
        // don't include myself in sliding windows
        if (u.socketId === socket?.id) continue;

        next[u.socketId] = {
          ...(next[u.socketId] || {}),
          socketId: u.socketId,
          username: u.username,
          color: u.color,
          language: next[u.socketId]?.language || null,
          position: next[u.socketId]?.position || null,
          selection: next[u.socketId]?.selection || null,
          // ✅ IMPORTANT: presence should refresh lastSeen too
          lastSeen: Date.now(),

          motion: next[u.socketId]?.motion || null,
          scroll: next[u.socketId]?.scroll || null,
        };
      }
      return next;
    });
  }, [onlineUsers, socket?.id]);

  // ✅ clamp windowIndex automatically when peers count changes (Prev/Next stuck fix)
  useEffect(() => {
    const total = Object.values(peers).filter((p) => p?.socketId).length;
    if (!total) {
      if (windowIndex !== 0) setWindowIndex(0);
      return;
    }
    const maxIdx = total - 1;
    if (windowIndex > maxIdx) setWindowIndex(maxIdx);
    if (windowIndex < 0) setWindowIndex(0);
  }, [peers, windowIndex]);

  // ✅ Firestore: auto-load latest code
  useEffect(() => {
    if (!codeDocRef) return;

    const unsub = onSnapshot(codeDocRef, (snap) => {
      const data = snap.data();
      const code = data?.code;
      if (!code) return;

      if (!editorRef.current) return;
      const current = editorRef.current.getValue?.() || "";
      if (current === code) return;

      isRemoteChange.current = true;
      editorRef.current.setValue(code);
      isRemoteChange.current = false;
    });

    return () => unsub();
  }, [codeDocRef]);

  // Receive code updates (socket realtime)
  useEffect(() => {
    if (!socket) return;

    const onUpdate = (newCode) => {
      if (!editorRef.current) return;
      isRemoteChange.current = true;
      editorRef.current.setValue(newCode);
      isRemoteChange.current = false;
    };

    socket.on("code-update", onUpdate);
    return () => socket.off("code-update", onUpdate);
  }, [socket]);

  // GLOBAL UNDO shortcut (Ctrl+Alt+Z)
  useEffect(() => {
    const handler = (e) => {
      if (e.ctrlKey && e.altKey && (e.key === "z" || e.key === "Z")) {
        socket?.emit("global-undo", { roomId });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [socket, roomId]);

  // ---- LIVE CURSOR: receive + render + update peers ----
  useEffect(() => {
    if (!socket) return;

    const onCursorUpdate = ({
      socketId,
      username: u,
      color,
      position,
      selection,
      language: lang,
      motion,
      scroll,
    }) => {
      const editor = editorRef.current;
      const monaco = monacoRef.current;
      if (!editor || !monaco) return;

      if (!socketId) return;
      if (!position?.lineNumber || !position?.column) return;

      // ✅ ignore my own cursor updates
      if (mySocketIdRef.current && socketId === mySocketIdRef.current) return;

      // ✅ update people windows cache
      setPeers((prev) => ({
        ...prev,
        [socketId]: {
          ...(prev[socketId] || {}),
          socketId,
          username: u || prev[socketId]?.username || "User",
          color: color || prev[socketId]?.color,
          language: lang || prev[socketId]?.language || null,
          position,
          selection: selection || null,
          lastSeen: Date.now(),

          motion: motion || prev[socketId]?.motion || null,
          scroll: scroll || prev[socketId]?.scroll || null,
        },
      }));

      const sid = safeCssId(socketId);
      const c = color || fallbackColorFor(socketId);
      const name = u || "User";

      ensureCursorCss(socketId, c);

      const caretRange = new monaco.Range(
        position.lineNumber,
        position.column,
        position.lineNumber,
        position.column
      );

      let selRange = null;
      if (
        selection &&
        selection.startLineNumber &&
        selection.startColumn &&
        selection.endLineNumber &&
        selection.endColumn
      ) {
        selRange = new monaco.Range(
          selection.startLineNumber,
          selection.startColumn,
          selection.endLineNumber,
          selection.endColumn
        );
      }

      const decos = [];
      if (selRange) {
        decos.push({
          range: selRange,
          options: {
            className: `rc-sel-${sid}`,
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          },
        });
      }

      decos.push({
        range: caretRange,
        options: {
          className: `rc-caret-${sid}`,
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      });

      const oldIds = remoteDecorationsRef.current[socketId] || [];
      const newIds = editor.deltaDecorations(oldIds, decos);
      remoteDecorationsRef.current[socketId] = newIds;

      let widget = remoteWidgetsRef.current[socketId];
      if (!widget) {
        widget = {
          getId: () => `rc-name-${sid}`,
          domNode: null,
          pos: position,
          getDomNode: function () {
            if (this.domNode) return this.domNode;
            const node = document.createElement("div");
            node.className = `rc-name-${sid}`;
            node.innerText = name;
            this.domNode = node;
            return node;
          },
          getPosition: function () {
            return {
              position: { lineNumber: this.pos.lineNumber, column: this.pos.column },
              preference: [
                monaco.editor.ContentWidgetPositionPreference.ABOVE,
                monaco.editor.ContentWidgetPositionPreference.BELOW,
              ],
            };
          },
        };
        remoteWidgetsRef.current[socketId] = widget;
        editor.addContentWidget(widget);
      }

      const arrow = motionArrow(motion);
      widget.pos = position;
      widget.getDomNode().innerText = arrow ? `${name} ${arrow}` : name;
      editor.layoutContentWidget(widget);
    };

    const onCursorRemove = ({ socketId }) => {
      if (!socketId) return;
      removeRemoteCursor(socketId);

      setPeers((prev) => {
        const next = { ...prev };
        delete next[socketId];
        return next;
      });
      setWindowIndex(0);
    };

    // ✅ pointer receive
    const onPointerUpdate = ({ socketId, username: u, color, x, y }) => {
      if (!socketId) return;
      if (mySocketIdRef.current && socketId === mySocketIdRef.current) return;

      setRemotePointers((prev) => ({
        ...prev,
        [socketId]: {
          socketId,
          username: u || prev[socketId]?.username || "User",
          color: color || prev[socketId]?.color || fallbackColorFor(socketId),
          x: typeof x === "number" ? x : prev[socketId]?.x || 0,
          y: typeof y === "number" ? y : prev[socketId]?.y || 0,
          lastSeen: Date.now(),
        },
      }));
    };

    const onPointerRemove = ({ socketId }) => {
      if (!socketId) return;
      setRemotePointers((prev) => {
        const next = { ...prev };
        delete next[socketId];
        return next;
      });
    };

    socket.on("cursor-update", onCursorUpdate);
    socket.on("cursor-remove", onCursorRemove);

    socket.on("pointer-update", onPointerUpdate);
    socket.on("pointer-remove", onPointerRemove);

    return () => {
      socket.off("cursor-update", onCursorUpdate);
      socket.off("cursor-remove", onCursorRemove);

      socket.off("pointer-update", onPointerUpdate);
      socket.off("pointer-remove", onPointerRemove);
    };
  }, [socket]);

  useEffect(() => {
    const onBlur = () => socket?.emit("cursor-leave", { roomId });
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [socket, roomId]);

  useEffect(() => {
    const onUnload = () => socket?.emit("cursor-leave", { roomId });
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [socket, roomId]);

  const handleEditorChange = (value) => {
    if (!socket || isRemoteChange.current) return;

    if (learningMode && !hasAskedGoal.current) {
      window.prompt("Learning Mode: Tum kya banana chahti ho? (Goal)");
      hasAskedGoal.current = true;
    }

    socket.emit("code-change", { roomId, code: value, username });

    if (codeDocRef) {
      setDoc(
        codeDocRef,
        {
          code: value,
          updatedAt: serverTimestamp(),
          updatedBy: username || "User",
          language,
        },
        { merge: true }
      ).catch(() => {});
    }
  };

  const runCodeAndCaptureOutput = async () => {
    if (!editorRef.current) return;

    const code = editorRef.current.getValue();
    setHasRuntimeError(false);

    if (language === "javascript") {
      const logs = [];
      const originalLog = console.log;
      const originalError = console.error;

      console.log = (...args) => logs.push(args.join(" "));
      console.error = (...args) => {
        logs.push("ERROR: " + args.join(" "));
        setHasRuntimeError(true);
      };

      try {
        // eslint-disable-next-line no-new-func
        new Function(code)();
      } catch (e) {
        logs.push("RUNTIME ERROR: " + (e?.message || String(e)));
        setHasRuntimeError(true);
      }

      console.log = originalLog;
      console.error = originalError;

      setOutput(logs.length ? logs : ["(No output)"]);
      return;
    }

    setOutput([]);
    setHasRuntimeError(false);

    try {
      let pistonLang = language;

      if (language === "javascript") pistonLang = "javascript";
      if (language === "c") pistonLang = "c";
      if (language === "cpp") pistonLang = "cpp";
      if (language === "python") pistonLang = "python";
      if (language === "java") pistonLang = "java";

      const res = await fetch("https://emkc.org/api/v2/piston/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          language: pistonLang,
          version: "*",
          files: [{ content: code }],
          stdin: stdin || "",
        }),
      });

      const data = await res.json();

      const output =
        data?.run?.output ??
        data?.compile?.output ??
        data?.run?.stderr ??
        "No output";

      if (data?.run?.stderr) setHasRuntimeError(true);

      setOutput([output]);
    } catch (e) {
      setHasRuntimeError(true);
      setOutput(["ERROR: " + String(e)]);
    }
  };

  const runAIDebug = async () => {
    if (!editorRef.current) return;

    const code = editorRef.current.getValue();
    setAiLoading(true);
    setAiReport(null);

    try {
      const resp = await fetch("http://localhost:5001/api/ai-debug", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });

      const data = await resp.json();
      setAiReport(data);
    } catch (e) {
      setAiReport({ ok: false, error: String(e) });
    } finally {
      setAiLoading(false);
    }
  };

  // ✅ People Windows list
  const peerList = Object.values(peers)
    .filter((p) => p?.socketId)
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));

  const total = peerList.length;
  const clampedIndex = total ? Math.min(windowIndex, total - 1) : 0;
  const activePeer = total ? peerList[clampedIndex] : null;

  // ✅ Code preview around peer cursor (shared file snapshot)
  const getPreview = () => {
    const code = editorRef.current?.getValue?.() || "";
    const lines = code.split("\n");
    const lineNo = activePeer?.position?.lineNumber || 1;

    const start = Math.max(1, lineNo - 6);
    const end = Math.min(lines.length || 1, lineNo + 6);

    const chunk = [];
    for (let i = start; i <= end; i++) {
      chunk.push({ no: i, text: lines[i - 1] ?? "" });
    }
    return { chunk, lineNo };
  };

  const preview = activePeer ? getPreview() : null;

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
        <select
          value={language}
          onChange={(e) => {
            const lang = e.target.value;
            setLanguage(lang);
            if (editorRef.current && templates[lang]) {
              editorRef.current.setValue(templates[lang]);
            }
          }}
        >
          <option value="javascript">JavaScript</option>
          <option value="c">C</option>
          <option value="cpp">C++</option>
          <option value="java">Java</option>
          <option value="python">Python</option>
        </select>

        <input
          value={stdin}
          onChange={(e) => setStdin(e.target.value)}
          placeholder="stdin (optional)"
          style={{ flex: 1 }}
        />
      </div>

      <div ref={editorBoxRef} style={{ position: "relative" }}>
        <MonacoEditor
          height="360px"
          language={language}
          defaultLanguage="javascript"
          defaultValue="// Start coding here"
          theme="vs-dark"
          onMount={(editor, monaco) => {
            editorRef.current = editor;
            monacoRef.current = monaco;

            editor.onDidChangeCursorSelection(() => {
              const model = editor.getModel();
              const pos = editor.getPosition();
              const sel = editor.getSelection();

              const line = model?.getLineContent(pos?.lineNumber || 1) || "";
              setCursorLine(line);

              const now = Date.now();
              if (now - lastCursorEmit.current < 40) return;
              lastCursorEmit.current = now;

              const visible = editor.getVisibleRanges?.()?.[0];

              socket?.emit(
                "cursor-change",
                {
                  roomId,
                  username,
                  language,
                  position: {
                    lineNumber: pos?.lineNumber || 1,
                    column: pos?.column || 1,
                  },
                  selection: sel
                    ? {
                        startLineNumber: sel.startLineNumber,
                        startColumn: sel.startColumn,
                        endLineNumber: sel.endLineNumber,
                        endColumn: sel.endColumn,
                      }
                    : null,
                  scroll: visible
                    ? { topLine: visible.startLineNumber, bottomLine: visible.endLineNumber }
                    : null,
                },
                () => {}
              );
            });

            editor.onDidScrollChange(() => {
              const now = Date.now();
              if (now - lastCursorEmit.current < 60) return;
              lastCursorEmit.current = now;

              const pos = editor.getPosition();
              const sel = editor.getSelection();
              const visible = editor.getVisibleRanges?.()?.[0];

              socket?.emit(
                "cursor-change",
                {
                  roomId,
                  username,
                  language,
                  position: {
                    lineNumber: pos?.lineNumber || 1,
                    column: pos?.column || 1,
                  },
                  selection: sel
                    ? {
                        startLineNumber: sel.startLineNumber,
                        startColumn: sel.startColumn,
                        endLineNumber: sel.endLineNumber,
                        endColumn: sel.endColumn,
                      }
                    : null,
                  scroll: visible
                    ? { topLine: visible.startLineNumber, bottomLine: visible.endLineNumber }
                    : null,
                },
                () => {}
              );
            });

            const dom = editor.getDomNode();
            if (dom) {
              let last = 0;

              const onMove = (ev) => {
                if (!roomId) return;

                const now = Date.now();
                if (now - last < 30) return;
                last = now;

                const rect = dom.getBoundingClientRect();
                const x = ev.clientX - rect.left;
                const y = ev.clientY - rect.top;

                socket?.emit("pointer-move", { roomId, x, y });
              };

              const onLeave = () => {
                if (!roomId) return;
                socket?.emit("pointer-leave", { roomId });
              };

              dom.addEventListener("mousemove", onMove);
              dom.addEventListener("mouseleave", onLeave);

              editor.onDidDispose(() => {
                dom.removeEventListener("mousemove", onMove);
                dom.removeEventListener("mouseleave", onLeave);
              });
            }
          }}
          onChange={handleEditorChange}
          options={{
            minimap: { enabled: false },
            wordWrap: "on",
            fontSize: 14,
          }}
        />

        {Object.values(remotePointers).map((p) => (
          <div
            key={p.socketId}
            style={{
              position: "absolute",
              left: p.x,
              top: p.y,
              transform: "translate(6px, 6px)",
              pointerEvents: "none",
              zIndex: 50,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 999,
                  background: p.color || "#fff",
                  boxShadow: "0 6px 16px rgba(0,0,0,0.35)",
                }}
              />
              <div
                style={{
                  background: p.color || "#111",
                  color: "white",
                  padding: "2px 8px",
                  borderRadius: 999,
                  fontSize: 11,
                  fontWeight: 800,
                  boxShadow: "0 6px 16px rgba(0,0,0,0.35)",
                  whiteSpace: "nowrap",
                }}
              >
                {p.username}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button onClick={runCodeAndCaptureOutput}>Run Code ▶️</button>
        <button onClick={runAIDebug}>{aiLoading ? "AI Debugging..." : "AI Debug"}</button>
      </div>

      {output.length > 0 && (
        <div
          style={{
            marginTop: 12,
            padding: 10,
            borderRadius: 8,
            border: "1px solid #333",
            background: "#0f172a",
            color: hasRuntimeError ? "#f87171" : "#a7f3d0",
            fontFamily: "monospace",
            fontSize: 13,
            maxHeight: 170,
            overflowY: "auto",
          }}
        >
          <b>Output Window</b>
          <div style={{ marginTop: 6 }}>
            {output.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop: 16, padding: 12, border: "1px solid #233", borderRadius: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <div style={{ fontWeight: 800, fontSize: 16 }}>People Windows</div>

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button
              onClick={() => setWindowIndex((i) => Math.max(0, i - 1))}
              disabled={!total || clampedIndex === 0}
            >
              ◀ Prev
            </button>
            <button
              onClick={() => setWindowIndex((i) => Math.min(total - 1, i + 1))}
              disabled={!total || clampedIndex === total - 1}
            >
              Next ▶
            </button>
            <div style={{ opacity: 0.8 }}>{total ? `${clampedIndex + 1}/${total}` : "0/0"}</div>
          </div>
        </div>

        {!activePeer ? (
          <div style={{ marginTop: 10, opacity: 0.7 }}>
            No peer window yet. (Tip: other user cursor move kare to window fill hoti hai.)
          </div>
        ) : (
          <div style={{ marginTop: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  display: "inline-block",
                  background: activePeer.color || "#999",
                }}
              />
              <b>{activePeer.username}</b>

              <span
                style={{
                  marginLeft: 6,
                  padding: "2px 8px",
                  borderRadius: 999,
                  border: "1px solid #334",
                  fontSize: 12,
                  opacity: 0.85,
                }}
              >
                {activePeer.language ? String(activePeer.language).toUpperCase() : "LANG ?"}
              </span>

              <span
                style={{
                  padding: "2px 8px",
                  borderRadius: 999,
                  border: "1px solid #334",
                  fontSize: 12,
                  opacity: 0.85,
                }}
              >
                {activePeer.motion?.dir ? `${motionArrow(activePeer.motion)} ${activePeer.motion.dir}` : "MOVE ?"}
                {typeof activePeer.motion?.speed === "number" ? ` • ${activePeer.motion.speed}/s` : ""}
              </span>

              <span style={{ marginLeft: "auto", opacity: 0.75, fontSize: 12 }}>
                {activePeer.scroll?.topLine
                  ? `View ${activePeer.scroll.topLine}–${activePeer.scroll.bottomLine}`
                  : activePeer.position?.lineNumber
                  ? `Line ${activePeer.position.lineNumber}`
                  : "No cursor yet"}
              </span>
            </div>

            <div
              style={{
                border: "1px solid #233",
                borderRadius: 12,
                padding: 10,
                background: "#0b1220",
                fontFamily: "monospace",
                fontSize: 12,
                maxHeight: 180,
                overflowY: "auto",
              }}
            >
              {preview?.chunk?.map((l) => (
                <div
                  key={l.no}
                  style={{
                    display: "flex",
                    gap: 10,
                    padding: "2px 0",
                    color: l.no === preview.lineNo ? (activePeer.color || "#fff") : "#cbd5e1",
                    fontWeight: l.no === preview.lineNo ? 800 : 400,
                  }}
                >
                  <span style={{ width: 36, opacity: 0.6, textAlign: "right" }}>{l.no}</span>
                  <span style={{ whiteSpace: "pre-wrap" }}>{l.text}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {learningMode && explanation && (
        <div
          style={{
            marginTop: 10,
            padding: "10px",
            border: "1px solid #333",
            borderRadius: 8,
            background: "#111",
            color: "#eee",
            fontSize: 13,
          }}
        >
          <div style={{ fontWeight: "bold", marginBottom: 6 }}>Learning Mode (Line Explanation)</div>

          <div style={{ fontFamily: "monospace", fontSize: 12, color: "#cbd5e1" }}>
            {cursorLine ? cursorLine : "Move cursor to any line to see explanation."}
          </div>

          <div style={{ marginTop: 8, lineHeight: 1.4 }}>
            <div>
              <b>Meaning:</b> {explanation.meaning}
            </div>
            <div>
              <b>Use:</b> {explanation.use}
            </div>
            <div>
              <b>Importance:</b> {explanation.importance}
            </div>
            <div>
              <b>Alternative:</b> {explanation.alternative}
            </div>
            <div style={{ marginTop: 6, color: "#94a3b8", fontSize: 12 }}>
              Global Undo shortcut: <b>Ctrl + Alt + Z</b>
            </div>
          </div>
        </div>
      )}

      {aiReport && (
        <div style={{ marginTop: 10, padding: 10, border: "1px solid #333", borderRadius: 8 }}>
          <b>AI Debugger Report</b>
          {!aiReport.ok && <div style={{ marginTop: 8, color: "tomato" }}>Error: {aiReport.error}</div>}
          {aiReport.ok && (
            <>
              <div style={{ marginTop: 10 }}>
                <b>Lint Issues</b>
                {aiReport.lint?.length ? (
                  aiReport.lint.map((m, i) => (
                    <div key={i} style={{ marginTop: 6 }}>
                      <span style={{ color: m.severity === "error" ? "tomato" : "gold" }}>
                        [{String(m.severity || "").toUpperCase()}]
                      </span>{" "}
                      Line {m.line}:{m.column} — {m.message}
                      <div style={{ color: "#94a3b8", fontSize: 12 }}>Hint: {m.hint}</div>
                    </div>
                  ))
                ) : (
                  <div style={{ marginTop: 6, color: "lightgreen" }}>No lint issues ✅</div>
                )}
              </div>

              {aiReport.suggestions?.length ? (
                <div style={{ marginTop: 10 }}>
                  <b>Suggestions</b>
                  <ul>
                    {aiReport.suggestions.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          )}
        </div>
      )}
    </div>
  );
}
