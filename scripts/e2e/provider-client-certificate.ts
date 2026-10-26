import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates, type TLSSocket } from "node:tls";
import { app, net, session } from "electron";
import { applyNetworkProxy, disposeSystemProxyRelay } from "../../apps/desktop/electron/main/network-proxy";
import { probeModelList, probeProviderEndpoint } from "../../apps/desktop/electron/main/model-discovery";

app.setPath("userData", process.argv[2]);
app.commandLine.appendSwitch("ozone-platform", "headless");
app.disableHardwareAcceleration();
let diagnosticPhase = "startup";
process.on("uncaughtException", (error) => {
  console.error("CERT_UNCAUGHT", diagnosticPhase, error);
  app.exit(1);
});
const fixture = process.argv[3];
const cert = readFileSync(join(fixture, "localhost-cert.pem"), "utf8");
const key = readFileSync(join(fixture, "localhost-key.pem"), "utf8");
const fingerprint = new X509Certificate(cert).fingerprint256;
const sockets = new Set<Socket>();
let requests = 0;
let mode: "models" | "redirect" | "stall" = "models";
let requestStarted: (() => void) | undefined;
const server = createHttpsServer({ key, cert, ca: cert, requestCert: true, rejectUnauthorized: false }, (req, res) => {
  requests++;
  assert.deepEqual((req.socket as TLSSocket).getPeerCertificate(), {});
  if (mode === "redirect") {
    res.writeHead(302, { location: "https://other.example/v1/models" });
    res.end();
    return;
  }
  if (mode === "stall") { requestStarted?.(); return; }
  res.writeHead(req.headers.authorization === "Bearer fixture" ? 200 : 401, { "content-type": "application/json" });
  res.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
});
const proxy = createHttpServer();
let tunnels = 0;
proxy.on("connect", (req, client, head) => {
  assert.equal(req.headers["proxy-authorization"], `Basic ${Buffer.from("fixture:password").toString("base64")}`);
  const target = new URL(`http://${req.url}`);
  assert.equal(target.hostname, "localhost");
  tunnels++;
  const upstream = connect({ host: "127.0.0.1", port: Number(target.port) });
  sockets.add(upstream);
  upstream.on("close", () => sockets.delete(upstream));
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
  client.on("close", () => upstream.destroy());
  upstream.on("connect", () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    client.pipe(upstream).pipe(client);
  });
});
for (const listener of [server, proxy]) listener.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});

// Sequential proxy cases must not reuse Chromium sockets from the prior route.
// Electron documents that setProxy alone does not discard pooled connections.
async function configureFixtureProxy(settings: unknown): Promise<void> {
  diagnosticPhase = "step-1"; console.error("CERT_STEP", diagnosticPhase, "before");
  await applyNetworkProxy(settings);
  console.error("CERT_STEP", diagnosticPhase, "after");
  diagnosticPhase = "step-2"; console.error("CERT_STEP", diagnosticPhase, "before");
  await session.defaultSession.closeAllConnections();
  console.error("CERT_STEP", diagnosticPhase, "after");
}

void app.whenReady().then(async () => {
  try {
    // Trust only this local fixture, only in this isolated Electron session.
    session.defaultSession.setCertificateVerifyProc((request, callback) => {
      const matches = request.hostname === "localhost" &&
        new X509Certificate(request.certificate.data).fingerprint256 === fingerprint;
      callback(matches ? 0 : -3);
    });
    setDefaultCACertificates([...getCACertificates("default"), cert]);
    server.listen(0, "127.0.0.1");
    proxy.listen(0, "127.0.0.1");
    diagnosticPhase = "step-3"; console.error("CERT_STEP", diagnosticPhase, "before");
    await Promise.all([once(server, "listening"), once(proxy, "listening")]);
    console.error("CERT_STEP", diagnosticPhase, "after");
    const address = server.address();
    const proxyAddress = proxy.address();
    assert.ok(address && typeof address !== "string" && proxyAddress && typeof proxyAddress !== "string");
    const baseUrl = `https://localhost:${address.port}/v1`;
    diagnosticPhase = "step-4"; console.error("CERT_STEP", diagnosticPhase, "before");
    await configureFixtureProxy({ mode: "direct" });
    console.error("CERT_STEP", diagnosticPhase, "after");
    let baselineTimer: ReturnType<typeof setTimeout> | undefined;
    const baselineTimeout = new Promise<{ kind: "timeout" }>((resolve) => {
      baselineTimer = setTimeout(() => resolve({ kind: "timeout" }), 8_000);
    });
    const baselineOutcome = await Promise.race([
      net.fetch(`${baseUrl}/models`).then(
        () => ({ kind: "response" as const }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ),
      baselineTimeout,
    ]);
    if (baselineTimer !== undefined) clearTimeout(baselineTimer);
    if (baselineOutcome.kind === "response") {
      assert.fail("client certificate was unexpectedly omitted and the request succeeded");
    }
    if (baselineOutcome.kind === "error") {
      assert.ok(
        baselineOutcome.error instanceof Error &&
          baselineOutcome.error.message.includes("ERR_SSL_CLIENT_AUTH_CERT_NEEDED"),
        `unexpected baseline error: ${String(baselineOutcome.error)}`,
      );
    }
    assert.equal(requests, 0, "the original Electron 43 failure precedes HTTP");
    console.log(`baseline: Electron 43 net.fetch ${baselineOutcome.kind === "timeout" ? "stalled" : "failed"} before HTTP`);
    const options = { baseUrl, apiKey: "fixture", signal: AbortSignal.timeout(8_000) };
    diagnosticPhase = "step-5"; console.error("CERT_STEP", diagnosticPhase, "before");
    assert.deepEqual((await probeModelList(options)).models, [{ modelId: "fixture-model", displayName: "fixture-model" }]);
    console.error("CERT_STEP", diagnosticPhase, "after");
    diagnosticPhase = "step-6"; console.error("CERT_STEP", diagnosticPhase, "before");
    assert.equal((await probeProviderEndpoint(options)).status, 200);
    console.error("CERT_STEP", diagnosticPhase, "after");
    diagnosticPhase = "step-7"; console.error("CERT_STEP", diagnosticPhase, "before");
    await assert.rejects(probeModelList({ ...options, apiKey: "wrong" }), { status: 401 });
    console.error("CERT_STEP", diagnosticPhase, "after");
    diagnosticPhase = "step-8"; console.error("CERT_STEP", diagnosticPhase, "before");
    await configureFixtureProxy({ mode: "custom", url: `http://fixture:password@127.0.0.1:${proxyAddress.port}`, bypass: "<-loopback>" });
    console.error("CERT_STEP", diagnosticPhase, "after");
    const before = tunnels;
    diagnosticPhase = "step-9"; console.error("CERT_STEP", diagnosticPhase, "before");
    assert.equal((await probeProviderEndpoint(options)).status, 200);
    console.error("CERT_STEP", diagnosticPhase, "after");
    assert.ok(tunnels > before, "the retry must use the configured authenticated proxy");
    diagnosticPhase = "step-10"; console.error("CERT_STEP", diagnosticPhase, "before");
    await configureFixtureProxy({ mode: "custom", url: `http://fixture:password@127.0.0.1:${proxyAddress.port}` });
    console.error("CERT_STEP", diagnosticPhase, "after");
    const beforeBypass = tunnels;
    diagnosticPhase = "step-11"; console.error("CERT_STEP", diagnosticPhase, "before");
    assert.equal((await probeProviderEndpoint(options)).status, 200);
    console.error("CERT_STEP", diagnosticPhase, "after");
    assert.equal(tunnels, beforeBypass, "localhost bypass must apply to both transports");
    diagnosticPhase = "step-12"; console.error("CERT_STEP", diagnosticPhase, "before");
    await configureFixtureProxy({ mode: "direct" });
    console.error("CERT_STEP", diagnosticPhase, "after");
    mode = "redirect";
    diagnosticPhase = "step-13"; console.error("CERT_STEP", diagnosticPhase, "before");
    await assert.rejects(probeModelList(options), /left the configured origin/);
    console.error("CERT_STEP", diagnosticPhase, "after");
    mode = "stall";
    const controller = new AbortController();
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    const pending = probeModelList({ ...options, signal: controller.signal });
    diagnosticPhase = "step-14"; console.error("CERT_STEP", diagnosticPhase, "before");
    await started;
    console.error("CERT_STEP", diagnosticPhase, "after");
    controller.abort();
    diagnosticPhase = "step-15"; console.error("CERT_STEP", diagnosticPhase, "before");
    await assert.rejects(pending, { name: "AbortError" });
    console.error("CERT_STEP", diagnosticPhase, "after");
    console.log("provider client certificate E2E passed");
    diagnosticPhase = "step-16"; console.error("CERT_STEP", diagnosticPhase, "before");
    await disposeSystemProxyRelay();
    console.error("CERT_STEP", diagnosticPhase, "after");
    for (const socket of sockets) socket.destroy();
    diagnosticPhase = "step-17"; console.error("CERT_STEP", diagnosticPhase, "before");
    await Promise.all([new Promise<void>((resolve) => server.close(() => resolve())), new Promise<void>((resolve) => proxy.close(() => resolve()))]);
    console.error("CERT_STEP", diagnosticPhase, "after");
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
