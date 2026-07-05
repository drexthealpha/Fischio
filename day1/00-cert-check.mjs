import tls from "node:tls";
const socket = tls.connect(
  { host: "api.devnet.solana.com", port: 443, servername: "api.devnet.solana.com", rejectUnauthorized: false },
  () => {
    const c = socket.getPeerCertificate(true);
    let cur = c, i = 0;
    while (cur && i < 5) {
      console.log(`[${i}] subject=${cur.subject?.CN} issuer=${cur.issuer?.CN} valid ${cur.valid_from} -> ${cur.valid_to}`);
      if (cur.issuerCertificate === cur) break;
      cur = cur.issuerCertificate; i++;
    }
    console.log("authorized:", socket.authorized, socket.authorizationError ?? "");
    socket.end();
  }
);
socket.on("error", (e) => console.log("socket err:", e.message));
