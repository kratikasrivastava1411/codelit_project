import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// 🔥 tumhara firebase config
const firebaseConfig = {
  apiKey: "AIzaSyC3klZpXlq-uVRTRUaLCExpCVkQRNg49L0",
  authDomain: "codelit-12.firebaseapp.com",
  projectId: "codelit-12",
  storageBucket: "codelit-12.firebasestorage.app",
  messagingSenderId: "268978623379",
  appId: "1:268978623379:web:f4a80ab88c549cf05e4e66",
  measurementId: "G-D3DHKER4YY"
};

// init firebase
const app = initializeApp(firebaseConfig);

// 🔐 auth
export const auth = getAuth(app);

// 🧠 firestore database
export const db = getFirestore(app);
