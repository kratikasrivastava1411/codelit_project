import React, { useEffect, useMemo, useRef, useState } from "react";
import io from "socket.io-client";
import Editor from "./Editor";
import "./App.css";

import { onAuthStateChanged } from "firebase/auth";
import { auth, db } from "./auth/firebase";
import Login from "./auth/Login";
import VerifyEmail from "./auth/VerifyEmail";

import {
  collection,
  addDoc,
  serverTimestamp,
  onSnapshot,
  query,
  orderBy,
  limit,
} from "firebase/firestore";

function getOrCreateSystemId() {
  const key = "collab_system_id_v1";
  let id = localStorage.getItem(key);
  if (!id) {
    id = "sys_" + Math.random().toString(16).slice(2) + "_" + Date.now();
    localStorage.setItem(key, id);
  }
  return id;
}

function getOrCreateUsername() {
  const key = "collab_username_v2";
  let u = localStorage.getItem(key);
  if (!u) {
    const fingerprint = Math.random().toString(36).substr(2, 6);
    u = `User-${fingerprint}`;
    localStorage.setItem(key, u);
  }
  return u;
}

const LS_ROOM = "collab_room_id_v1";
const LS_JOINED = "collab_joined_v1";
const LS_USERNAME = "collab_username_v2";

function dedupeOnlineUsers(list = []) {
  // Prefer systemId if server sends it, else fallback to username
  const map = new Map();
  for (const u of list) {
    const key = u.systemId || u.username || u.socketId;
    if (!key) continue;
    // last wins (latest update)
    map.set(key, u);
  }
  return Array.from(map.values());
}

export default function App() {
  const [onlineUsers, setOnlineUsers] = useState([]);

  const [user, setUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);

  // ✅ Editable username
  const [username, setUsername] = useState(() => getOrCreateUsername());
  const [usernameDraft, setUsernameDraft] = useState(() => getOrCreateUsername());

  const [socket, setSocket] = useState(null);
  const [socketReady, setSocketReady] = useState(false);

  const [mySocketId, setMySocketId] = useState("");
  const [myColor, setMyColor] = useState("");

  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");

  const [roomId, setRoomId] = useState(() => localStorage.getItem(LS_ROOM) || "");
  const [joined, setJoined] = useState(() => localStorage.getItem(LS_JOINED) === "1");

  const [learningMode, setLearningMode] = useState(false);
  const [chatEnabled, setChatEnabled] = useState(true);

  const systemId = useMemo(() => getOrCreateSystemId(), []);
  const chatUnsubRef = useRef(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u || null);
      setAuthChecked(true);
    });
    return () => unsub();
  }, []);

  const refreshUser = async () => {
    try {
      await auth.currentUser?.reload();
      setUser(auth.currentUser || null);
    } catch {}
  };

  const attachChatListener = (rid) => {
    try {
      if (chatUnsubRef.current) {
        chatUnsubRef.current();
        chatUnsubRef.current = null;
      }

      const q = query(
        collection(db, "rooms", rid, "messages"),
        orderBy("createdAt", "asc"),
        limit(200)
      );

      chatUnsubRef.current = onSnapshot(q, (snap) => {
        const msgs = snap.docs.map((d) => d.data());
        setMessages(msgs);
      });
    } catch (e) {
      console.log("❌ Firestore chat listener failed:", e);
    }
  };

  useEffect(() => {
    const s = io("http://localhost:5001", {
      transports: ["websocket", "polling"],
      withCredentials: true,
    });

    s.on("connect", () => {
      setSocketReady(true);
      setMySocketId(s.id);
      console.log("✅ socket connected:", s.id);

      const savedRoom = localStorage.getItem(LS_ROOM);
      const wasJoined = localStorage.getItem(LS_JOINED) === "1";

      if (savedRoom && wasJoined) {
        setMessages([]);

        let done = false;
        const t = setTimeout(() => {
          if (!done) {
            console.log("⚠️ Auto-join timeout");
            setJoined(false);
            localStorage.removeItem(LS_JOINED);
          }
        }, 4000);

        s.emit("join-room", { roomId: savedRoom, username, systemId }, (resp) => {
          done = true;
          clearTimeout(t);
          console.log("AUTO JOIN ACK:", resp);

          if (resp?.ok) {
            if (resp?.user?.color) setMyColor(resp.user.color);
            setRoomId(savedRoom);
            setJoined(true);
            attachChatListener(savedRoom);
          } else {
            setJoined(false);
            localStorage.removeItem(LS_JOINED);
          }
        });
      }
    });

    s.on("disconnect", () => setSocketReady(false));

    s.on("connect_error", (err) =>
      console.log("❌ connect_error:", err?.message || err)
    );

    setSocket(s);
    return () => s.disconnect();
  }, [username, systemId]);

  useEffect(() => {
    if (!socket) return;

    const onChat = (data) => {
      if (chatUnsubRef.current) return;
      setMessages((prev) => [...prev, data]);
    };

    socket.on("chat-message", onChat);
    return () => socket.off("chat-message", onChat);
  }, [socket]);

  useEffect(() => {
    if (!socket) return;

    const onPresence = (data) => {
      if (data?.roomId !== roomId) return;
      // ✅ Client-side de-dupe so reload doesn’t show duplicates in UI
      setOnlineUsers(dedupeOnlineUsers(data.users || []));
    };

    socket.on("presence-update", onPresence);
    return () => socket.off("presence-update", onPresence);
  }, [socket, roomId]);

  const saveUsername = () => {
    const cleaned = usernameDraft.trim();
    if (!cleaned) return;

    // Prevent weird long names
    const safe = cleaned.slice(0, 24);
    localStorage.setItem(LS_USERNAME, safe);
    setUsername(safe);
    setUsernameDraft(safe);
  };

  const joinRoom = () => {
    const rid = roomId.trim();
    if (!rid || !socket || !socketReady) return;

    setRoomId(rid);

    let done = false;
    const t = setTimeout(() => {
      if (!done) alert("Join timeout: server reply nahi aaya. Server running hai?");
    }, 4000);

    socket.emit("join-room", { roomId: rid, username, systemId }, (resp) => {
      done = true;
      clearTimeout(t);
      console.log("JOIN ACK:", resp);

      if (resp?.ok) {
        if (resp?.user?.color) setMyColor(resp.user.color);

        setJoined(true);
        setMessages([]);

        localStorage.setItem(LS_ROOM, rid);
        localStorage.setItem(LS_JOINED, "1");

        attachChatListener(rid);
      } else {
        alert("Join failed: " + (resp?.error || "unknown"));
      }
    });
  };

  const sendMessage = async () => {
    if (!socket || !joined) return;
    if (!text.trim()) return;

    const msg = text.trim();

    try {
      await addDoc(collection(db, "rooms", roomId, "messages"), {
        username,
        message: msg,
        createdAt: serverTimestamp(),
      });
    } catch (e) {
      console.log("❌ Firestore message save failed:", e);
    }

    socket.emit("send-message", { roomId, username, message: msg }, (resp) => {
      if (!resp?.ok) alert("Message failed: " + (resp?.error || "unknown"));
    });

    setText("");
  };

  const globalUndo = () => {
    if (!socket) return;
    socket.emit("global-undo", { roomId });
  };

  useEffect(() => {
    return () => {
      if (chatUnsubRef.current) {
        chatUnsubRef.current();
        chatUnsubRef.current = null;
      }
    };
  }, []);

  if (!authChecked) {
    return (
      <div className="landing">
        <div className="pill">Loading…</div>
      </div>
    );
  }

  // ✅ Email login UI shows here, IF your Login.js has email/password option
  if (!user) return <Login />;

  if (user && !user.emailVerified)
    return <VerifyEmail user={user} onRefresh={refreshUser} />;

  if (!joined) {
    return (
      <div className="landing">
        <div className="landingWrap">
          <div className="landingTop">
            <div className="brand">
              <div className="logoDot" />
              <div>
                <div className="brandTitle">CodeLit</div>
                <div className="brandSub">Realtime editor • chat • learning mode</div>
              </div>
            </div>

            <div className="pill">{socketReady ? "Online ✅" : "Connecting…"}</div>
          </div>

          <div className="landingGrid">
            <div className="hero">
              <h1>Code together. Learn together.</h1>
              <p>
                Create a room, invite teammates, collaborate in real-time. Enable
                Learning Mode to see line-by-line guidance.
              </p>
            </div>

            <div className="joinCard">
              <div className="cardHead">
                <div>
                  <div className="cardTitle">Enter Workspace</div>
                  <div className="cardSub">Join or create a room</div>
                </div>
                <div className="smallPill">You: {username}</div>
              </div>

              {/* ✅ Username input (edit + save) */}
              <div className="field" style={{ marginBottom: 10 }}>
                <label>Username</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    value={usernameDraft}
                    onChange={(e) => setUsernameDraft(e.target.value)}
                    placeholder="e.g. Aadya"
                  />
                  <button
                    className="btn"
                    type="button"
                    onClick={saveUsername}
                    title="Save username"
                  >
                    Save
                  </button>
                </div>
              </div>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  joinRoom();
                }}
              >
                <div className="field">
                  <label>Room ID</label>
                  <input
                    value={roomId}
                    onChange={(e) => setRoomId(e.target.value)}
                    placeholder="e.g. team-frontend"
                    autoFocus
                  />
                </div>

                <button className="primaryBtn" type="submit" disabled={!socketReady}>
                  {socketReady ? "Enter Room →" : "Connecting…"}
                </button>
              </form>

              <div className="tinyNote">
                Tip: same Room ID = same collaboration space.
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="appShell">
      <div className="topbar">
        <div className="topLeft">
          <div className="brandSmall">
            <div className="logoDot" />
            <div className="brandTitleSmall">CodeLit</div>
          </div>
          <div className="pill">Room: {roomId}</div>
        </div>

        <div className="topActions">
          <button
            className={learningMode ? "btn btnPrimary" : "btn"}
            onClick={() => setLearningMode((v) => !v)}
          >
            Learning: {learningMode ? "ON" : "OFF"}
          </button>

          <button
            className={chatEnabled ? "btn btnPrimary" : "btn"}
            onClick={() => setChatEnabled((v) => !v)}
          >
            Chat: {chatEnabled ? "ON" : "OFF"}
          </button>

          <button className="btn" onClick={globalUndo}>
            Global Undo
          </button>
        </div>
      </div>

      <div className="mainGrid">
        <aside className="sidebar">
          <div className="sideCard">
            <div className="sideTitle">Workspace</div>
            <div className="sideRow">
              <span className="muted">User</span> <b>{username}</b>
            </div>
            <div className="sideRow">
              <span className="muted">System</span>{" "}
              <span className="mono">{systemId.slice(0, 10)}…</span>
            </div>

            <div className="sideTitle" style={{ marginTop: 10 }}>
              Online
            </div>

            <div style={{ marginTop: 6 }}>
              {onlineUsers.length ? (
                onlineUsers.map((u) => (
                  <div
                    key={(u.systemId || u.username || u.socketId) + "_" + (u.socketId || "")}
                    className="sideRow"
                    style={{ gap: 8 }}
                  >
                    <span
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: "50%",
                        display: "inline-block",
                        background: u.color || "#999",
                      }}
                    />
                    <b>{u.username}</b>
                  </div>
                ))
              ) : (
                <div className="muted">No one online</div>
              )}
            </div>
          </div>
        </aside>

        <section className="editorCard">
          {socket && (
            <Editor
              socket={socket}
              roomId={roomId}
              username={username}
              learningMode={learningMode}
              mySocketId={mySocketId}
              myColor={myColor}
              onlineUsers={onlineUsers}
            />
          )}
        </section>

        <aside className="chatCard">
          <div className="chatHead">
            <div className="chatTitle">Team Chat</div>
            <div className="pill">{chatEnabled ? "Live" : "Off"}</div>
          </div>

          {chatEnabled ? (
            <>
              <div className="chatBody">
                {messages.map((msg, i) => (
                  <div className="msg" key={i}>
                    <b>{msg.username}:</b> {msg.message}
                  </div>
                ))}
              </div>

              <div className="chatInput">
                <input
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Type message…"
                  onKeyDown={(e) => e.key === "Enter" && sendMessage()}
                />
                <button className="primaryBtn" onClick={sendMessage}>
                  Send
                </button>
              </div>
            </>
          ) : (
            <div className="chatOff">Chat is OFF. Turn it ON from top bar.</div>
          )}
        </aside>
      </div>
    </div>
  );
}
