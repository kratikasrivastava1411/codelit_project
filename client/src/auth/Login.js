// client/src/auth/Login.js
import React, { useState } from "react";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendEmailVerification,
} from "firebase/auth";
import { auth } from "./firebase";

export default function Login() {
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");

  // ✅ FIX 1: keep mode values consistent with checks below ("Login" | "signup")
  const [mode, setMode] = useState("Login"); // "Login" | "signup"

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setErr("");
    setLoading(true);

    try {
      if (mode === "Login") {
        // ✅ Login
        const cred = await signInWithEmailAndPassword(auth, email.trim(), pass);

        // ✅ FIX 2: if verification required, block unverified users
        if (cred?.user && !cred.user.emailVerified) {
          setErr("Please verify your email first. Check inbox/spam, then login again.");
          return;
        }
      } else {
        // ✅ Sign up
        const cred = await createUserWithEmailAndPassword(auth, email.trim(), pass);

        // ✅ send verification after signup
        await sendEmailVerification(cred.user);

        // ✅ helpful message
        setErr("Verification email sent. Please verify first, then login.");
      }
    } catch (e2) {
      // ✅ FIX 3: better debug info (shows firebase error code too)
      console.log("AUTH ERROR FULL:", e2);
      console.log("AUTH ERROR CODE:", e2?.code);
      console.log("AUTH ERROR MESSAGE:", e2?.message);

      setErr((e2?.code ? e2.code + " : " : "") + (e2?.message || String(e2)));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="landing">
      <div className="landingWrap">
        <div className="landingTop">
          <div className="brand">
            <div className="logoDot" />
            <div>
              <div className="brandTitle">CodeLit</div>
              <div className="brandSub">Login • verify email • collaborate</div>
            </div>
          </div>
          <div className="pill">Auth</div>
        </div>

        <div className="landingGrid">
          <div className="hero">
            <h1>Welcome back.</h1>
            <p>Email verification is required to enter workspaces.</p>
          </div>

          <div className="joinCard">
            <div className="cardHead">
              <div>
                <div className="cardTitle">{mode === "Login" ? "Login" : "Sign up"}</div>
                <div className="cardSub">Use your email + password</div>
              </div>
              <div className="smallPill">{mode === "Login" ? "Existing" : "New"}</div>
            </div>

            <form onSubmit={submit}>
              <div className="field">
                <label>Email</label>
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@gmail.com"
                />
              </div>

              <div className="field">
                <label>Password</label>
                <input
                  value={pass}
                  onChange={(e) => setPass(e.target.value)}
                  type="password"
                  placeholder="••••••••"
                />
              </div>

              {err ? (
                <div style={{ color: "#f87171", marginTop: 10, fontSize: 13 }}>
                  Firebase: {err}
                </div>
              ) : null}

              <button
                className="primaryBtn"
                type="submit"
                disabled={loading}
                style={{ width: "100%", marginTop: 12 }}
              >
                {loading ? "Please wait…" : mode === "Login" ? "Login →" : "Sign up →"}
              </button>
            </form>

            <button
              className="btn"
              style={{ width: "100%", marginTop: 10 }}
              onClick={() => setMode((m) => (m === "Login" ? "signup" : "Login"))}
              disabled={loading}
            >
              {mode === "Login" ? "New user? Sign up" : "Already have account? Login"}
            </button>

            {mode === "signup" ? (
              <div className="tinyNote">
                Signup ke baad verification mail aayega. Verify karne ke baad hi workspace open hoga.
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
