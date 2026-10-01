import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.3.0/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged, setPersistence, browserLocalPersistence } from 'https://www.gstatic.com/firebasejs/12.3.0/firebase-auth.js';
import {
  getFirestore, collection, collectionGroup, doc, getDoc, getDocs, addDoc, deleteDoc,
  query, where, orderBy, limit, onSnapshot, serverTimestamp, Timestamp
} from 'https://www.gstatic.com/firebasejs/12.3.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyBZixAhulbs1gNjspHreUt6S10goiMzBFY',
  authDomain: 'nexus-event-52836.firebaseapp.com',
  projectId: 'nexus-event-52836',
  storageBucket: 'nexus-event-52836.firebasestorage.app',
  messagingSenderId: '1096442887871',
  appId: '1:1096442887871:web:c70b9b519e42db881c100a',
  measurementId: 'G-WXW4GTD86D'
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
await setPersistence(auth, browserLocalPersistence);

export {
  app, auth, db, signInAnonymously, onAuthStateChanged,
  collection, collectionGroup, doc, getDoc, getDocs, addDoc, deleteDoc,
  query, where, orderBy, limit, onSnapshot, serverTimestamp, Timestamp
};
