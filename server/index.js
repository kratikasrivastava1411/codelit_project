// server/index.js
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

// --- Room state ---
const roomCodeHistory = {}; // roomId -> [{code,user,time}]
const roomCurrentCode = {}; // roomId -> latest code

// ✅ Presence + cursor colors (Canva-style)
// 🔧 FIX: roomUsers now keyed by systemId (stable across reload), not socketId
const roomUsers = {}; // roomId -> { systemId: { socketId, username, joinedAt, color } }
// ✅ ROOM USER LIMIT (change number here anytime)
const ROOM_MAX_USERS = 50;

const CURSOR_COLORS = [
  "#ff4d4f",
  "#40a9ff",
  "#73d13d",
  "#ffa940",
  "#9254de",
  "#13c2c2",
  "#f759ab",
  "#52c41a",
  "#1890ff",
  "#faad14",
];

function pickColor(roomId) {
  const used = new Set(Object.values(roomUsers[roomId] || {}).map((u) => u.color));
  for (const c of CURSOR_COLORS) if (!used.has(c)) return c;
  return CURSOR_COLORS[Math.floor(Math.random() * CURSOR_COLORS.length)];
}

const app = express();

// Frontend runs on 3000/3001/3002/3003 in your setup
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://localhost:3001",
      "http://127.0.0.1:3001",
      "http://localhost:3002",
      "http://127.0.0.1:3002",
      "http://localhost:3003",
      "http://127.0.0.1:3003",
    ],
    credentials: true,
  })
);
app.use(express.json({ limit: "2mb" }));

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://localhost:3001",
      "http://127.0.0.1:3001",
      "http://localhost:3002",
      "http://127.0.0.1:3002",
      "http://localhost:3003",
      "http://127.0.0.1:3003",
    ],
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// ---------- HEALTH ----------
app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "collab-code-server" });
});

// -------------------- AI DEBUGGER (JS only, stable) --------------------
let ESLint;
let eslintInstance = null;

function friendlyHint(msg) {
  const m = (msg || "").toLowerCase();
  if (m.includes("unexpected token"))
    return "Syntax issue: bracket/quote missing. () {} [] and quotes check karo.";
  if (m.includes("unterminated"))
    return "String/template close nahi hua. Quotes/backticks check karo.";
  if (m.includes("no-undef"))
    return "Variable declare/import nahi hai. Pehle declare karo.";
  if (m.includes("no-unused-vars"))
    return "Variable bana diya but use nahi kiya. Remove ya use karo.";
  if (m.includes("return") && m.includes("outside"))
    return "Return function ke bahar hai. Extra/missing } check karo.";
  return "Line ke paas syntax/logic check karo. Pehle syntax fix karo.";
}

async function getESLint() {
  if (eslintInstance) return eslintInstance;

  ESLint = require("eslint").ESLint;

  eslintInstance = new ESLint({
    useEslintrc: false,
    overrideConfig: {
      env: { browser: true, es2021: true, node: true },
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
      extends: ["eslint:recommended"],
      rules: {
        "no-unused-vars": "warn",
        "no-undef": "error",
        "no-redeclare": "error",
        "no-unreachable": "warn",
      },
    },
  });

  return eslintInstance;
}

app.post("/api/ai-debug", async (req, res) => {
  try {
    const { code } = req.body;
    if (typeof code !== "string") {
      return res.status(400).json({ ok: false, error: "code must be a string" });
    }

    const eslint = await getESLint();
    const lintResults = await eslint.lintText(code);

    const lintMsgs = (lintResults?.[0]?.messages || []).map((m) => ({
      ruleId: m.ruleId,
      severity: m.severity === 2 ? "error" : "warn",
      message: m.message,
      line: m.line,
      column: m.column,
      hint: friendlyHint(m.message || m.ruleId),
    }));

    const suggestions = [];
    if (lintMsgs.some((x) => x.ruleId === "no-undef"))
      suggestions.push("Variable use se pehle declare/import karo.");
    if (lintMsgs.some((x) => x.ruleId === "no-unused-vars"))
      suggestions.push("Unused vars hatao ya use karo.");

    res.json({ ok: true, lint: lintMsgs, suggestions });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// -------------------- RUNNER HELPERS (Docker, C/C++) --------------------
function runCmd(cmd, args, input = "", timeoutMs = 8000) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { shell: false });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      try {
        p.kill("SIGKILL");
      } catch {}
    }, timeoutMs);

    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => (stderr += d.toString()));

    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, killed });
    });

    p.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(e), killed: false });
    });

    if (input) p.stdin.write(input);
    p.stdin.end();
  });
}

// ✅ IMPORTANT: Windows path -> Docker mount path
function toDockerMountPath(p) {
  if (process.platform !== "win32") return p;
  const drive = p[0].toLowerCase();
  const rest = p.slice(2).replace(/\\/g, "/");
  return `/${drive}${rest}`;
}

function dockerArgsFor(language, workDirOnHost) {
  const mountPath = toDockerMountPath(workDirOnHost);

  const base = [
    "run",
    "--rm",
    "--network",
    "none",
    "--cpus",
    "1",
    "--memory",
    "1g",
    "--pids-limit",
    "128",
    "-v",
    `${mountPath}:/work`,
    "-w",
    "/work",
  ];

  if (language === "c") {
    return {
      image: "gcc:13",
      cmd: ["bash", "-lc", "gcc main.c -O2 -std=c11 -o main && ./main"],
      base,
      file: "main.c",
    };
  }
  if (language === "cpp") {
    return {
      image: "gcc:13",
      cmd: ["bash", "-lc", "g++ main.cpp -O2 -std=c++17 -o main && ./main"],
      base,
      file: "main.cpp",
    };
  }

  return null;
}

app.post("/api/run", async (req, res) => {
  try {
    const { language, code, stdin } = req.body;

    if (!language || typeof code !== "string") {
      return res.status(400).json({ ok: false, error: "language + code required" });
    }
    if (code.length > 200000) {
      return res.status(413).json({ ok: false, error: "Code too large." });
    }

    // Allow only C/C++
    if (!["c", "cpp"].includes(language)) {
      return res
        .status(400)
        .json({ ok: false, error: "Only C and C++ supported right now." });
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-run-"));

    const finalRunner = dockerArgsFor(language, tmpDir);
    if (!finalRunner) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
      return res.status(400).json({ ok: false, error: "Runner config not found." });
    }

    const filePath = path.join(tmpDir, finalRunner.file);
    fs.writeFileSync(filePath, code, "utf8");

    const args = [...finalRunner.base, finalRunner.image, ...finalRunner.cmd];
    const result = await runCmd("docker", args, stdin || "", 20000);

    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}

    if (result.code === -1) {
      return res.json({
        ok: false,
        error:
          "Docker command failed. Docker Desktop running? PATH ok? Error: " +
          (result.stderr || ""),
      });
    }

    return res.json({
      ok: true,
      stdout: result.stdout,
      stderr: result.killed
        ? (result.stderr || "") + "\n[Timeout] Execution stopped."
        : result.stderr,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// -------------------- SOCKETS (collab + cursor + chat) --------------------

// ✅ ADDED: cursor motion tracking (direction/speed)
const lastCursorPos = {}; // socketId -> { line, col, ts }

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // ✅ JOIN ROOM
  // 🔧 FIX: accept systemId and de-dup by systemId
  socket.on("join-room", ({ roomId, username, systemId }, cb) => {
    try {
      if (!roomId) throw new Error("roomId required");
      if (!systemId) throw new Error("systemId required");

      if (!roomUsers[roomId]) roomUsers[roomId] = {};

      // ✅ USER LIMIT CHECK (based on unique systemId users)
      const currentCount = Object.keys(roomUsers[roomId] || {}).length;
      if (currentCount >= ROOM_MAX_USERS && !roomUsers[roomId][systemId]) {
        cb &&
          cb({
            ok: false,
            error: `Room is full. Max ${ROOM_MAX_USERS} users allowed.`,
          });
        return;
      }

      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.username = username || "User";
      socket.data.systemId = systemId;

      // ✅ Keep same color across reloads for same systemId in same room
      const prev = roomUsers[roomId][systemId];

      roomUsers[roomId][systemId] = {
        socketId: socket.id,
        username: socket.data.username,
        joinedAt: Date.now(),
        color: prev?.color || pickColor(roomId),
      };

      io.to(roomId).emit("presence-update", {
        roomId,
        users: Object.entries(roomUsers[roomId]).map(([sid, u]) => ({
          systemId: sid,
          socketId: u.socketId,
          username: u.username,
          color: u.color,
        })),
      });

      socket.to(roomId).emit("chat-message", {
        username: "System",
        message: `${socket.data.username} joined the room`,
      });

      if (roomCurrentCode[roomId]) {
        socket.emit("code-update", roomCurrentCode[roomId]);
      }

      cb &&
        cb({
          ok: true,
          joined: roomId,
          user: { ...roomUsers[roomId][systemId], systemId },
        });
    } catch (e) {
      cb && cb({ ok: false, error: String(e) });
    }
  });

  // ✅ CHAT
  socket.on("send-message", ({ roomId, username, message }, cb) => {
    try {
      if (!roomId) throw new Error("roomId missing");
      if (!message || !message.trim()) {
        cb && cb({ ok: false, error: "Empty message" });
        return;
      }

      io.to(roomId).emit("chat-message", { username, message });
      cb && cb({ ok: true });
    } catch (e) {
      cb && cb({ ok: false, error: String(e) });
    }
  });

  // ✅ CODE COLLAB
  socket.on("code-change", ({ roomId, code, username }) => {
    if (!roomId || typeof code !== "string") return;

    if (!roomCodeHistory[roomId]) roomCodeHistory[roomId] = [];
    roomCodeHistory[roomId].push({ code, user: username, time: Date.now() });
    roomCurrentCode[roomId] = code;

    socket.to(roomId).emit("code-update", code);
  });

  // ✅ GLOBAL UNDO
  socket.on("global-undo", ({ roomId }) => {
    if (roomCodeHistory[roomId] && roomCodeHistory[roomId].length > 1) {
      roomCodeHistory[roomId].pop();
      const last = roomCodeHistory[roomId][roomCodeHistory[roomId].length - 1];
      roomCurrentCode[roomId] = last.code;
      io.to(roomId).emit("code-update", last.code);
    }
  });

  // ✅ LIVE CURSOR (FORWARD selection + color) + ✅ NEW motion + optional scroll passthrough
  socket.on("cursor-change", ({ roomId, position, selection, language, scroll }, cb) => {
    try {
      if (!roomId || !position) return;

      // 🔧 FIX: user lookup by systemId (not socket.id)
      const sysId = socket.data.systemId;
      const user = sysId ? roomUsers[roomId]?.[sysId] : null;
      if (!user) return;

      // ✅ sanitize selection (optional)
      const sel =
        selection &&
        selection.startLineNumber &&
        selection.startColumn &&
        selection.endLineNumber &&
        selection.endColumn
          ? selection
          : null;

      // ✅ compute direction + speed
      const now = Date.now();
      const prev = lastCursorPos[socket.id];

      let motion = null;
      if (prev) {
        const dLine = (position.lineNumber ?? 0) - (prev.line ?? 0);
        const dCol = (position.column ?? 0) - (prev.col ?? 0);
        const dt = Math.max(1, now - (prev.ts ?? now));

        let dir = "still";
        if (Math.abs(dLine) > Math.abs(dCol)) {
          if (dLine > 0) dir = "down";
          else if (dLine < 0) dir = "up";
        } else {
          if (dCol > 0) dir = "right";
          else if (dCol < 0) dir = "left";
        }

        const dist = Math.sqrt(dLine * dLine + dCol * dCol);
        const speed = Math.round((dist * 1000) / dt);

        motion = { dir, dLine, dCol, speed };
      }

      lastCursorPos[socket.id] = {
        line: position.lineNumber,
        col: position.column,
        ts: now,
      };

      socket.to(roomId).emit("cursor-update", {
        socketId: socket.id,
        systemId: sysId || null,
        username: user.username,
        color: user.color,
        position,
        selection: sel,
        language: language || null,

        // ✅ added
        motion,
        scroll: scroll || null,
      });

      cb && cb({ ok: true });
    } catch (e) {
      cb && cb({ ok: false, error: String(e) });
    }
  });

  socket.on("cursor-leave", ({ roomId }) => {
    if (!roomId) return;
    socket.to(roomId).emit("cursor-remove", { socketId: socket.id });
  });

  // ✅ ✅ ✅ ADD-ON: CANVA-STYLE POINTER EVENTS (mouse x,y)
  socket.on("pointer-move", ({ roomId, x, y }, cb) => {
    try {
      if (!roomId) return;

      // 🔧 FIX: user lookup by systemId
      const sysId = socket.data.systemId;
      const user = sysId ? roomUsers[roomId]?.[sysId] : null;
      if (!user) return;

      socket.to(roomId).emit("pointer-update", {
        socketId: socket.id,
        systemId: sysId || null,
        username: user.username,
        color: user.color,
        x,
        y,
      });

      cb && cb({ ok: true });
    } catch (e) {
      cb && cb({ ok: false, error: String(e) });
    }
  });

  socket.on("pointer-leave", ({ roomId }) => {
    if (!roomId) return;
    socket.to(roomId).emit("pointer-remove", { socketId: socket.id });
  });
  // ✅ ✅ ✅ END POINTER ADD-ON

  socket.on("disconnect", () => {
    // ✅ cleanup cursor motion tracking
    delete lastCursorPos[socket.id];

    for (const r of socket.rooms) {
      if (r === socket.id) continue;

      if (roomUsers[r]) {
        // 🔧 FIX: remove by matching socketId inside systemId entries
        for (const sid of Object.keys(roomUsers[r])) {
          if (roomUsers[r][sid]?.socketId === socket.id) {
            delete roomUsers[r][sid];
            break;
          }
        }

        io.to(r).emit("presence-update", {
          roomId: r,
          users: Object.entries(roomUsers[r]).map(([sid, u]) => ({
            systemId: sid,
            socketId: u.socketId,
            username: u.username,
            color: u.color,
          })),
        });

        socket.to(r).emit("cursor-remove", { socketId: socket.id });

        // ✅ ADD-ON: remove pointer on disconnect
        socket.to(r).emit("pointer-remove", { socketId: socket.id });

        if (Object.keys(roomUsers[r]).length === 0) delete roomUsers[r];
      }
    }

    console.log("User disconnected:", socket.id);
  });
});
// ===== SERVE REACT BUILD (PRODUCTION) =====
app.use(express.static(path.join(__dirname, "public")));

app.get("/*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
const PORT = process.env.PORT || 10000;

server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});