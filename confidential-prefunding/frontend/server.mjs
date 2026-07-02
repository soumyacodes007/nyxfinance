import http from "node:http";
import fs from "node:fs";

const number = (name, fallback) => Number(process.env[name] ?? fallback);
const config = {
  apiPort: number("API_PORT", 3001),
  businessServerPort: number("BUSINESS_SERVER_PORT", 8091),
  frontendPort: number("FRONTEND_PORT", 3000)
};

const sendJson = (response, statusCode, payload) => {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload, null, 2));
};

const sendText = (response, statusCode, body, contentType = "text/plain") => {
  response.writeHead(statusCode, {
    "content-type": `${contentType}; charset=utf-8`
  });
  response.end(body);
};

function readPhase4Report() {
  try {
    return JSON.parse(
      fs.readFileSync(new URL("../oz-confidential/state/phase4-testnet-report.json", import.meta.url), "utf8")
    );
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function short(value) {
  const text = String(value || "");
  return text.length > 18 ? `${text.slice(0, 10)}...${text.slice(-8)}` : text;
}

function renderPhase4(report) {
  if (report.error) {
    return `<p class="warn">Phase 4 report unavailable: ${escapeHtml(report.error)}</p>`;
  }
  const proof = report.proof?.verified_public_view || {};
  const contracts = report.contracts || {};
  return `
    <div class="proof-grid">
      <article class="proof-card verified">
        <span class="eyebrow">Phase 4</span>
        <h2>Collateral Proof Verified</h2>
        <p>UltraHonk proof accepted on ${escapeHtml(report.network)}. Public state shows commitments and a nullifier only.</p>
        <strong>${proof.proof_verified ? "verified" : "not verified"}</strong>
      </article>
      <article class="proof-card">
        <span class="eyebrow">Hidden Values</span>
        <h2>Amounts Stay Private</h2>
        <p>Collateral amount hidden: ${proof.collateral_amount_hidden ? "yes" : "no"}</p>
        <p>Borrow amount hidden: ${proof.borrow_amount_hidden ? "yes" : "no"}</p>
      </article>
      <article class="proof-card mono">
        <span class="eyebrow">Commitments</span>
        <p>Collateral X ${escapeHtml(short(proof.collateral_commitment_x))}</p>
        <p>Collateral Y ${escapeHtml(short(proof.collateral_commitment_y))}</p>
        <p>Credit X ${escapeHtml(short(proof.credit_commitment_x))}</p>
        <p>Credit Y ${escapeHtml(short(proof.credit_commitment_y))}</p>
      </article>
      <article class="proof-card mono">
        <span class="eyebrow">Testnet Contracts</span>
        <p>Credit ${escapeHtml(short(contracts.prefunding_credit_line))}</p>
        <p>Verifier ${escapeHtml(short(contracts.collateral_sufficiency_verifier))}</p>
        <p>Nullifier ${escapeHtml(short(proof.position_nullifier))}</p>
      </article>
    </div>`;
}

function html() {
  const phase4 = renderPhase4(readPhase4Report());
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Confidential Prefunding Phase 1</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f4efe8;
        --panel: #fffaf4;
        --ink: #1f2933;
        --muted: #55606d;
        --accent: #b45309;
        --ok: #1f7a4d;
        --line: #e6dac8;
      }
      body {
        margin: 0;
        font-family: "Iowan Old Style", "Palatino Linotype", serif;
        background:
          radial-gradient(circle at top left, rgba(180, 83, 9, 0.18), transparent 30%),
          linear-gradient(180deg, #f8f3ec 0%, var(--bg) 100%);
        color: var(--ink);
      }
      main {
        max-width: 960px;
        margin: 0 auto;
        padding: 48px 20px 64px;
      }
      .panel {
        background: rgba(255, 250, 244, 0.92);
        border: 1px solid var(--line);
        border-radius: 20px;
        padding: 24px;
        box-shadow: 0 16px 40px rgba(31, 41, 51, 0.08);
      }
      h1 {
        margin: 0 0 8px;
        font-size: clamp(2rem, 4vw, 3.5rem);
      }
      p {
        color: var(--muted);
        line-height: 1.6;
      }
      ul {
        padding-left: 20px;
      }
      a {
        color: var(--accent);
      }
      pre {
        overflow: auto;
        background: #221b15;
        color: #f6ede1;
        padding: 16px;
        border-radius: 14px;
      }
      .proof-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 16px;
        margin: 28px 0;
      }
      .proof-card {
        border: 1px solid var(--line);
        border-radius: 18px;
        background: #fffdf8;
        padding: 18px;
      }
      .proof-card h2 {
        margin: 6px 0 10px;
      }
      .proof-card p {
        margin: 6px 0;
      }
      .proof-card.verified {
        border-color: rgba(31, 122, 77, 0.35);
        background: linear-gradient(135deg, rgba(31, 122, 77, 0.12), #fffdf8 58%);
      }
      .proof-card strong {
        color: var(--ok);
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .eyebrow {
        color: var(--accent);
        font-size: 0.75rem;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      .mono {
        font-family: "IBM Plex Mono", "Courier New", monospace;
        font-size: 0.9rem;
      }
      .warn {
        color: #9a3412;
      }
      @media (max-width: 720px) {
        .proof-grid {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="panel">
        <h1>Confidential Prefunding</h1>
        <p>Phase 1 boots the base stack: Anchor Platform, business callbacks, API cache, worker, and a status frontend.</p>
        <ul>
          <li>Anchor Platform: <a href="http://localhost:8080">http://localhost:8080</a></li>
          <li>API health: <a href="http://localhost:${config.apiPort}/health">http://localhost:${config.apiPort}/health</a></li>
          <li>Demo state: <a href="http://localhost:${config.apiPort}/api/demo/state">http://localhost:${config.apiPort}/api/demo/state</a></li>
          <li>Business server: <a href="http://localhost:${config.businessServerPort}/health">http://localhost:${config.businessServerPort}/health</a></li>
        </ul>
        ${phase4}
        <h2>Live Demo State</h2>
        <div class="proof-grid" id="phase5">
          <article class="proof-card">
            <span class="eyebrow">SEP Status</span>
            <h2 id="sep-status">Loading</h2>
            <p>Anchor Platform status is kept separate from prefunding product state.</p>
          </article>
          <article class="proof-card">
            <span class="eyebrow">Product Status</span>
            <h2 id="product-status">Loading</h2>
            <p>Prefunding state advances through quote, proof, draw, repayment, and close.</p>
          </article>
          <article class="proof-card mono">
            <span class="eyebrow">Backend Jobs</span>
            <p>Quote <span id="quote-id">none</span></p>
            <p>Proof <span id="proof-id">none</span></p>
          </article>
          <article class="proof-card mono">
            <span class="eyebrow">Watcher</span>
            <p>Cursor <span id="watcher-cursor">none</span></p>
            <p>Contracts <span id="watcher-contracts">0</span></p>
          </article>
          <article class="proof-card mono">
            <span class="eyebrow">Disclosure</span>
            <p>Latest grant <span id="disclosure-id">none</span></p>
            <p><a id="disclosure-link" href="/disclosure">Open disclosure verifier</a></p>
          </article>
        </div>
        <pre id="state">Loading...</pre>
      </section>
    </main>
    <script>
      const target = document.getElementById("state");
      fetch("http://localhost:${config.apiPort}/api/demo/state")
        .then((response) => response.json())
        .then((payload) => {
          target.textContent = JSON.stringify(payload, null, 2);
          const snapshot = payload.snapshot || {};
          document.getElementById("sep-status").textContent = snapshot.product?.latestSepStatus || "none";
          document.getElementById("product-status").textContent = snapshot.product?.latestProductStatus || "none";
          document.getElementById("quote-id").textContent = snapshot.product?.latestQuoteId || "none";
          document.getElementById("proof-id").textContent = snapshot.product?.latestProofJobId || "none";
          document.getElementById("watcher-cursor").textContent = snapshot.watcher?.cursor || "none";
          document.getElementById("watcher-contracts").textContent = String(snapshot.watcher?.trackedContracts?.length || 0);
          const grantId = snapshot.product?.latestDisclosureGrantId || "";
          document.getElementById("disclosure-id").textContent = grantId ? grantId.slice(0, 10) + "..." + grantId.slice(-8) : "none";
          if (grantId) document.getElementById("disclosure-link").href = "/disclosure?grantId=" + encodeURIComponent(grantId);
        })
        .catch((error) => {
          target.textContent = JSON.stringify({ error: error.message }, null, 2);
        });
    </script>
  </body>
</html>`;
}

function disclosureHtml(grantId = "") {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Scoped Disclosure Verifier</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f6f1e7;
        --panel: #fffdf8;
        --ink: #1f2933;
        --muted: #596673;
        --line: #e4d7c3;
        --accent: #7c2d12;
        --ok: #17634a;
        --bad: #a11d1d;
      }
      body {
        margin: 0;
        font-family: "Iowan Old Style", "Palatino Linotype", serif;
        background:
          radial-gradient(circle at 10% 0%, rgba(124, 45, 18, 0.18), transparent 32%),
          linear-gradient(180deg, #fbf6ed 0%, var(--bg) 100%);
        color: var(--ink);
      }
      main {
        max-width: 920px;
        margin: 0 auto;
        padding: 44px 20px 64px;
      }
      .panel, .card {
        background: rgba(255, 253, 248, 0.94);
        border: 1px solid var(--line);
        border-radius: 20px;
        box-shadow: 0 18px 44px rgba(31, 41, 51, 0.08);
      }
      .panel {
        padding: 24px;
      }
      h1 {
        margin: 0 0 8px;
        font-size: clamp(2rem, 4vw, 3.25rem);
      }
      p {
        color: var(--muted);
        line-height: 1.6;
      }
      label {
        display: block;
        color: var(--muted);
        margin: 14px 0 6px;
      }
      input {
        width: 100%;
        box-sizing: border-box;
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 12px 14px;
        background: #fffaf3;
        color: var(--ink);
        font: inherit;
      }
      button {
        margin-top: 16px;
        border: 0;
        border-radius: 999px;
        background: var(--accent);
        color: white;
        padding: 12px 18px;
        font: inherit;
        cursor: pointer;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 16px;
        margin-top: 22px;
      }
      .card {
        padding: 18px;
      }
      .eyebrow {
        color: var(--accent);
        font-size: 0.75rem;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      .mono, pre {
        font-family: "IBM Plex Mono", "Courier New", monospace;
        font-size: 0.9rem;
      }
      pre {
        overflow: auto;
        background: #211a13;
        color: #f8efe2;
        padding: 16px;
        border-radius: 14px;
      }
      .ok {
        color: var(--ok);
      }
      .bad {
        color: var(--bad);
      }
      @media (max-width: 720px) {
        .grid {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="panel">
        <a href="/">Back to demo state</a>
        <h1>Scoped Disclosure</h1>
        <p>The backend returns encrypted bundle data only. This page derives the key from the URL fragment, decrypts locally, and verifies the grant metadata before showing scoped fields.</p>
        <label for="grant-id">Grant ID</label>
        <input id="grant-id" value="${escapeHtml(grantId)}" placeholder="64 hex chars">
        <label for="viewer-secret">Viewer secret</label>
        <input id="viewer-secret" placeholder="Paste secret or use #key=... in the URL">
        <button id="verify">Decrypt and verify</button>
        <div class="grid">
          <article class="card">
            <span class="eyebrow">Verification</span>
            <h2 id="status">Waiting</h2>
            <p id="details">No plaintext is requested from the server.</p>
          </article>
          <article class="card mono">
            <span class="eyebrow">Grant</span>
            <p>Viewer hash <span id="viewer-hash">none</span></p>
            <p>Scope hash <span id="scope-hash">none</span></p>
            <p>Bundle hash <span id="bundle-hash">none</span></p>
          </article>
        </div>
        <h2>Scoped Data</h2>
        <pre id="scoped-data">Not decrypted</pre>
        <h2>Public Metadata</h2>
        <pre id="metadata">Not loaded</pre>
      </section>
    </main>
    <script>
      const apiBase = "http://localhost:${config.apiPort}";
      const initialGrantId = ${JSON.stringify(grantId)};
      const grantInput = document.getElementById("grant-id");
      const secretInput = document.getElementById("viewer-secret");
      const statusEl = document.getElementById("status");
      const detailsEl = document.getElementById("details");
      const scopedDataEl = document.getElementById("scoped-data");
      const metadataEl = document.getElementById("metadata");
      const fragment = new URLSearchParams(location.hash.slice(1));
      if (initialGrantId) grantInput.value = initialGrantId;
      if (fragment.get("key")) secretInput.value = fragment.get("key");

      function stableJson(value) {
        if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
        if (value && typeof value === "object") {
          return "{" + Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, entry]) => JSON.stringify(key) + ":" + stableJson(entry))
            .join(",") + "}";
        }
        return JSON.stringify(value);
      }

      function base64UrlBytes(value) {
        const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
        const binary = atob(padded);
        return Uint8Array.from(binary, (char) => char.charCodeAt(0));
      }

      function hex(bytes) {
        return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
      }

      async function sha256Hex(value) {
        const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
        return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
      }

      async function decryptBundle(encryptedBundle, viewerSecret) {
        const keyBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(viewerSecret)));
        const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
        const ciphertext = base64UrlBytes(encryptedBundle.ciphertext);
        const tag = base64UrlBytes(encryptedBundle.authTag);
        const combined = new Uint8Array(ciphertext.length + tag.length);
        combined.set(ciphertext);
        combined.set(tag, ciphertext.length);
        const plaintext = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: base64UrlBytes(encryptedBundle.nonce), tagLength: 128 },
          key,
          combined
        );
        return JSON.parse(new TextDecoder().decode(plaintext));
      }

      function short(value) {
        const text = String(value || "");
        return text.length > 18 ? text.slice(0, 10) + "..." + text.slice(-8) : text;
      }

      async function verifyDisclosure() {
        const grantId = grantInput.value.trim();
        const viewerSecret = secretInput.value;
        statusEl.textContent = "Checking";
        statusEl.className = "";
        scopedDataEl.textContent = "Decrypting locally...";
        const response = await fetch(apiBase + "/api/disclosure/" + encodeURIComponent(grantId));
        const payload = await response.json();
        metadataEl.textContent = JSON.stringify(payload, null, 2);
        if (!response.ok) throw new Error(payload.error || "Disclosure lookup failed");
        if (payload.grantStatus.revoked) throw new Error("Disclosure grant is revoked");
        if (payload.grantStatus.expired) throw new Error("Disclosure grant is expired");

        const expectedViewerHash = await sha256Hex(viewerSecret);
        if (expectedViewerHash !== payload.grant.viewerHash) throw new Error("Viewer secret does not match grant viewer hash");
        const computedBundleHash = await sha256Hex(
          payload.encryptedBundle.algorithm + ":" +
          payload.encryptedBundle.nonce + ":" +
          payload.encryptedBundle.authTag + ":" +
          payload.encryptedBundle.ciphertext
        );
        if (computedBundleHash !== payload.grant.bundleHash) throw new Error("Encrypted bundle hash mismatch");

        const plaintext = await decryptBundle(payload.encryptedBundle, viewerSecret);
        const computedScopeHash = await sha256Hex(stableJson(plaintext.scope));
        if (computedScopeHash !== payload.grant.scopeHash) throw new Error("Scope hash mismatch");
        if (plaintext.clientVerification?.expectedScopeHash !== payload.grant.scopeHash) {
          throw new Error("Client verification scope hash mismatch");
        }

        document.getElementById("viewer-hash").textContent = short(payload.grant.viewerHash);
        document.getElementById("scope-hash").textContent = short(payload.grant.scopeHash);
        document.getElementById("bundle-hash").textContent = short(payload.grant.bundleHash);
        scopedDataEl.textContent = JSON.stringify(plaintext.scopedData, null, 2);
        statusEl.textContent = "Verified";
        statusEl.className = "ok";
        detailsEl.textContent = "Viewer, scope, bundle hash, expiry, and revocation checks passed in the browser.";
      }

      document.getElementById("verify").addEventListener("click", () => {
        verifyDisclosure().catch((error) => {
          statusEl.textContent = "Failed";
          statusEl.className = "bad";
          detailsEl.textContent = error.message;
          scopedDataEl.textContent = "Not shown";
        });
      });
      if (grantInput.value && secretInput.value) document.getElementById("verify").click();
    </script>
  </body>
</html>`;
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "GET" && url.pathname === "/health") {
    return sendJson(response, 200, {
      status: "ok",
      service: "frontend"
    });
  }

  if (request.method === "GET" && url.pathname === "/") {
    return sendText(response, 200, html(), "text/html");
  }

  if (request.method === "GET" && url.pathname.startsWith("/disclosure")) {
    const pathGrantId = url.pathname.split("/").filter(Boolean)[1] || "";
    const grantId = url.searchParams.get("grantId") || pathGrantId;
    return sendText(response, 200, disclosureHtml(grantId || ""), "text/html");
  }

  return sendJson(response, 404, {
    error: "not_found",
    path: url.pathname
  });
});

server.listen(config.frontendPort, "0.0.0.0", () => {
  console.log(
    JSON.stringify(
      {
        service: "frontend",
        port: config.frontendPort
      },
      null,
      2
    )
  );
});
