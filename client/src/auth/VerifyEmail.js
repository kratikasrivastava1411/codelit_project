// client/src/auth/VerifyEmail.js
import React, { useState } from "react";
import { sendEmailVerification, signOut } from "firebase/auth";
import { auth } from "./firebase";

export default function VerifyEmail({ user, onRefresh }) {
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const resend = async () => {
    setErr("");
    setMsg("");
    setLoading(true);
    try {
      if (!auth.currentUser) throw new Error("No user session.");
      await sendEmailVerification(auth.currentUser);
      setMsg("Verification email sent ✅ (Inbox/Spam check karo)");
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  const refresh = async () => {
    setErr("");
    setMsg("");
    setLoading(true);
    try {
      await onRefresh?.();
      setMsg("Refreshed ✅ (Agar verify kiya hai to ab next screen open hogi)");
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    await signOut(auth);
  };

  return (
    <div className="landing">
      <div className="landingWrap">
        <div className="landingTop">
          <div className="brand">
            <div className="logoDot" />
            <div>
              <div className="brandTitle">CodeLit</div>
              <div className="brandSub">Verify email to enter workspaces</div>
            </div>
          </div>
          <div className="pill">Verify</div>
        </div>

        <div className="landingGrid">
          <div className="hero">
            <h1>Verify your email.</h1>
            <p>
              Logged in as <b>{user?.email}</b>. Email verify karke hi editor open hoga.
            </p>
          </div>

          <div className="joinCard">
            <div className="cardTitle">Steps</div>
            <div className="tinyNote" style={{ marginTop: 8 }}>
              1) Inbox/Spam me verification mail open karo  
              <br />
              2) Verify button click karo  
              <br />
              3) Yaha aake “I verified” click karo
            </div>

            {msg ? <div style={{ color: "#a7f3d0", marginTop: 10, fontSize: 13 }}>{msg}</div> : null}
            {err ? <div style={{ color: "#f87171", marginTop: 10, fontSize: 13 }}>Firebase: {err}</div> : null}

            <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
              <button className="primaryBtn" onClick={resend} disabled={loading} style={{ flex: 1 }}>
                Resend email
              </button>
              <button className="btn" onClick={refresh} disabled={loading} style={{ flex: 1 }}>
                I verified ✅
              </button>
            </div>

            <button className="btn" onClick={logout} style={{ width: "100%", marginTop: 10 }} disabled={loading}>
              Logout
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
