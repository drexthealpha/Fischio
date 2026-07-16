// Identity and session for the app. In a wallet app the wallet IS the account, so there is
// no password and no cookie login. Two layers live here:
//
//  1. An anonymous session id (a uuid in localStorage) that survives reloads, for analytics
//     and continuity before anyone connects. This is the "session" in the ordinary web sense.
//  2. Wallet identity, authenticated to the backend with Sign-In With Solana (SIWS): the user
//     signs a one-time nonce, the API verifies the signature and issues a bearer token. That
//     token is the authenticated session, stored per wallet so a reload stays signed in. No
//     secret ever leaves the user, which is the whole point of not using a password.
//
// A connected external wallet always wins; otherwise the embedded instant wallet is active.
import { createContext, useContext, useState, useCallback, useEffect } from "react";
import { useAnchorWallet, useWallet } from "@solana/wallet-adapter-react";
import { guestAnchorWallet, forgetGuestWallet } from "./guestWallet.js";

const Ctx = createContext(null);
const FLAG = "fischio.embedded.on";
const SID = "fischio.sid";
const tokenKey = (pk) => `fischio.session.${pk}`;

const params = new URLSearchParams(window.location.search);
const API = params.get("api") ?? "http://127.0.0.1:8790";

// A fetch that gives up after a few seconds, so a missing or slow session backend can never
// leave the header stuck on "signing in". Trading is on-chain and does not need this session.
const fetchT = (url, opts = {}, ms = 6000) => {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(t));
};

function sessionId() {
  try {
    let s = localStorage.getItem(SID);
    if (!s) { s = (crypto.randomUUID?.() ?? String(Math.random()).slice(2)); localStorage.setItem(SID, s); }
    return s;
  } catch { return "anon"; }
}

export function WalletBridgeProvider({ children }) {
  const adapter = useAnchorWallet();
  const { signMessage: adapterSignMessage } = useWallet();
  const [embeddedOn, setEmbeddedOn] = useState(() => {
    try { return localStorage.getItem(FLAG) === "1"; } catch { return false; }
  });
  const [signedIn, setSignedIn] = useState(false);
  const [signingIn, setSigningIn] = useState(false);

  const enableEmbedded = useCallback(() => {
    try { localStorage.setItem(FLAG, "1"); } catch { /* ignore */ }
    setEmbeddedOn(true);
  }, []);
  const disableEmbedded = useCallback(() => {
    forgetGuestWallet();
    try { localStorage.removeItem(FLAG); } catch { /* ignore */ }
    setEmbeddedOn(false);
    setSignedIn(false);
  }, []);

  const wallet = adapter ?? (embeddedOn ? guestAnchorWallet() : undefined);
  const isEmbedded = !adapter && embeddedOn;
  const pubkey = wallet?.publicKey?.toBase58();
  const signMessage = adapter ? adapterSignMessage : (isEmbedded ? guestAnchorWallet().signMessage : undefined);

  // Sign-In With Solana: prove control of the wallet to the backend, get a session token.
  const signIn = useCallback(async () => {
    if (!pubkey || !signMessage) return false;
    setSigningIn(true);
    try {
      const { nonce } = await (await fetchT(`${API}/auth/nonce`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pubkey }),
      })).json();
      const sig = await signMessage(new TextEncoder().encode(nonce));
      const b64 = btoa(String.fromCharCode(...sig));
      const j = await (await fetchT(`${API}/auth/verify`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pubkey, signature: b64 }),
      })).json();
      if (!j.token) throw new Error(j.error ?? "sign-in failed");
      localStorage.setItem(tokenKey(pubkey), j.token);
      setSignedIn(true);
      return true;
    } catch { return false; }
    finally { setSigningIn(false); }
  }, [pubkey, signMessage]);

  const token = pubkey ? (() => { try { return localStorage.getItem(tokenKey(pubkey)); } catch { return null; } })() : null;

  // On wallet change, check whether an existing token is still valid (stays signed in across
  // reloads); the embedded wallet can sign silently, so it signs in automatically.
  useEffect(() => {
    let alive = true;
    setSignedIn(false);
    if (!pubkey) return;
    const check = async () => {
      if (token) {
        const ok = (await fetchT(`${API}/me`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.ok).catch(() => false));
        if (alive && ok) { setSignedIn(true); return; }
      }
      if (alive && isEmbedded) await signIn(); // instant wallet signs in with no popup
    };
    check();
    return () => { alive = false; };
  }, [pubkey, isEmbedded]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Ctx.Provider value={{
      wallet, isEmbedded, embeddedOn, enableEmbedded, disableEmbedded,
      pubkey, sessionId: sessionId(), signedIn, signingIn, signIn, token,
    }}>
      {children}
    </Ctx.Provider>
  );
}

export const useWalletBridge = () => useContext(Ctx);
export const useActiveWallet = () => useContext(Ctx)?.wallet;
export const useSession = () => useContext(Ctx);
