import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { Server as SocketIOServer } from "socket.io";
import QRCode from "qrcode";
import { nanoid } from "nanoid";
import path from "node:path";
import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const isVercel = Boolean(process.env.VERCEL);
const uploadsDir = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : isVercel
    ? "/tmp/smart-display-pro-uploads"
    : path.join(__dirname, "uploads");

fs.mkdirSync(uploadsDir, { recursive: true });

const app = Fastify({ logger: true, bodyLimit: 30 * 1024 * 1024 });

await app.register(cors, { origin: true });
await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024, files: 1 } });
await app.register(fastifyStatic, { root: publicDir, prefix: "/" });
await app.register(fastifyStatic, { root: uploadsDir, prefix: "/uploads/", decorateReply: false });

const sessions = globalThis.__smartDisplaySessions || new Map();
globalThis.__smartDisplaySessions = sessions;

const emptyContent = () => ({ title: "", subtitle: "", price: "", oldPrice: "", badge: "OFERTA IMPERDÍVEL", discount: "", accent: "lime" });

function getBaseUrl(request) {
  const proto = request.headers["x-forwarded-proto"] || request.protocol || "https";
  const host = request.headers["x-forwarded-host"] || request.headers.host;
  return `${proto}://${host}`;
}

function makeSession(sessionId) {
  return { id: sessionId, tvSocketId: null, controllerSocketId: null, connected: { tv: false, controller: false }, mode: "photo-motion", media: null, content: emptyContent(), createdAt: Date.now(), updatedAt: Date.now() };
}

function publicState(session) {
  return { id: session.id, connected: session.connected, mode: session.mode, media: session.media, content: session.content, updatedAt: session.updatedAt };
}

function isSessionMember(session, socketId) {
  return session?.tvSocketId === socketId || session?.controllerSocketId === socketId;
}

app.get("/", async (_request, reply) => reply.redirect("/tv.html"));
app.get("/health", async () => ({ ok: true, platform: isVercel ? "vercel" : "node", sessions: sessions.size, time: new Date().toISOString() }));

app.get("/api/session/:sessionId", async (request, reply) => {
  const session = sessions.get(request.params.sessionId);
  if (!session) return reply.code(404).send({ ok: false, error: "Sessão não encontrada." });
  return { ok: true, session: publicState(session) };
});

app.get("/api/session/:sessionId/qr", async (request, reply) => {
  const { sessionId } = request.params;
  const session = sessions.get(sessionId);
  if (!session) return reply.code(404).send({ ok: false, error: "Sessão não encontrada." });
  const pairingUrl = `${getBaseUrl(request)}/control.html?session=${encodeURIComponent(sessionId)}`;
  const qrDataUrl = await QRCode.toDataURL(pairingUrl, { width: 460, margin: 1, errorCorrectionLevel: "M", color: { dark: "#050505", light: "#ffffff" } });
  return { ok: true, sessionId, pairingUrl, qrDataUrl };
});

await app.ready();

const io = globalThis.__smartDisplayIo || new SocketIOServer(app.server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"]
});
globalThis.__smartDisplayIo = io;

app.post("/api/upload", async (request, reply) => {
  const sessionId = String(request.query?.session || "").trim();
  if (!sessionId) return reply.code(400).send({ ok: false, error: "session é obrigatório." });
  const session = sessions.get(sessionId);
  if (!session) return reply.code(404).send({ ok: false, error: "Sessão não encontrada." });
  const part = await request.file();
  if (!part) return reply.code(400).send({ ok: false, error: "Nenhum arquivo enviado." });
  const allowed = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/webm"]);
  if (!allowed.has(part.mimetype)) return reply.code(415).send({ ok: false, error: "Formato não suportado. Use JPG, PNG, WEBP, GIF, MP4 ou WEBM." });
  const extFromName = path.extname(part.filename || "").toLowerCase();
  const safeExt = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".mp4", ".webm"].includes(extFromName) ? extFromName : part.mimetype.startsWith("video/") ? ".mp4" : ".jpg";
  const fileName = `${Date.now()}-${nanoid(10)}${safeExt}`;
  const destination = path.join(uploadsDir, fileName);
  await pipeline(part.file, fs.createWriteStream(destination));
  const media = { url: `/uploads/${fileName}`, type: part.mimetype.startsWith("video/") ? "video" : "image", mimeType: part.mimetype, originalName: part.filename || fileName };
  session.media = media;
  session.updatedAt = Date.now();
  io.to(sessionId).emit("display:state", publicState(session));
  return { ok: true, media };
});

if (!io.__smartDisplayHandlersBound) {
  io.__smartDisplayHandlersBound = true;
  io.on("connection", (socket) => {
    socket.on("tv:create-session", async (_payload, ack = () => {}) => {
      let sessionId = nanoid(12);
      while (sessions.has(sessionId)) sessionId = nanoid(12);
      const session = makeSession(sessionId);
      session.tvSocketId = socket.id;
      session.connected.tv = true;
      sessions.set(sessionId, session);
      socket.join(sessionId);
      socket.data.sessionId = sessionId;
      socket.data.role = "tv";
      try {
        const proto = socket.handshake.headers["x-forwarded-proto"] || "https";
        const host = socket.handshake.headers["x-forwarded-host"] || socket.handshake.headers.host;
        const pairingUrl = `${proto}://${host}/control.html?session=${encodeURIComponent(sessionId)}`;
        const qrDataUrl = await QRCode.toDataURL(pairingUrl, { width: 460, margin: 1, errorCorrectionLevel: "M" });
        ack({ ok: true, sessionId, pairingUrl, qrDataUrl, state: publicState(session) });
      } catch (error) {
        app.log.error(error);
        ack({ ok: false, error: "Falha ao gerar QR Code." });
      }
    });

    socket.on("tv:resume-session", ({ sessionId } = {}, ack = () => {}) => {
      const id = String(sessionId || "").trim();
      const session = sessions.get(id);
      if (!session) return ack({ ok: false, error: "Sessão expirada." });
      session.tvSocketId = socket.id;
      session.connected.tv = true;
      session.updatedAt = Date.now();
      socket.join(id);
      socket.data.sessionId = id;
      socket.data.role = "tv";
      io.to(id).emit("presence:update", publicState(session).connected);
      ack({ ok: true, state: publicState(session) });
    });

    socket.on("controller:join", ({ sessionId } = {}, ack = () => {}) => {
      const id = String(sessionId || "").trim();
      const session = sessions.get(id);
      if (!session) return ack({ ok: false, error: "Sessão não encontrada ou expirada." });
      session.controllerSocketId = socket.id;
      session.connected.controller = true;
      session.updatedAt = Date.now();
      socket.join(id);
      socket.data.sessionId = id;
      socket.data.role = "controller";
      io.to(id).emit("presence:update", publicState(session).connected);
      io.to(id).emit("display:state", publicState(session));
      ack({ ok: true, state: publicState(session) });
    });

    socket.on("controller:update-display", (payload = {}, ack = () => {}) => {
      const sessionId = socket.data.sessionId;
      const session = sessions.get(sessionId);
      if (!session || socket.data.role !== "controller" || !isSessionMember(session, socket.id)) return ack({ ok: false, error: "Controle não autorizado nesta sessão." });
      const allowedModes = new Set(["photo-motion", "video-overlay", "video-pure"]);
      const content = { ...session.content, ...(payload.content || {}) };
      session.mode = allowedModes.has(payload.mode) ? payload.mode : session.mode;
      session.content = {
        title: String(content.title || "").slice(0, 90),
        subtitle: String(content.subtitle || "").slice(0, 120),
        price: String(content.price || "").slice(0, 20),
        oldPrice: String(content.oldPrice || "").slice(0, 20),
        badge: String(content.badge || "").slice(0, 50),
        discount: String(content.discount || "").slice(0, 20),
        accent: ["lime", "yellow", "red", "cyan"].includes(content.accent) ? content.accent : "lime"
      };
      session.updatedAt = Date.now();
      io.to(sessionId).emit("display:state", publicState(session));
      ack({ ok: true, state: publicState(session) });
    });

    socket.on("controller:clear-media", (_payload, ack = () => {}) => {
      const session = sessions.get(socket.data.sessionId);
      if (!session || socket.data.role !== "controller") return ack({ ok: false, error: "Controle não autorizado." });
      session.media = null;
      session.updatedAt = Date.now();
      io.to(socket.data.sessionId).emit("display:state", publicState(session));
      ack({ ok: true });
    });

    socket.on("controller:ping-tv", (_payload, ack = () => {}) => {
      const session = sessions.get(socket.data.sessionId);
      if (!session || socket.data.role !== "controller") return ack({ ok: false });
      io.to(socket.data.sessionId).emit("tv:flash");
      ack({ ok: true });
    });

    socket.on("disconnect", () => {
      const sessionId = socket.data.sessionId;
      const role = socket.data.role;
      if (!sessionId || !sessions.has(sessionId)) return;
      const session = sessions.get(sessionId);
      if (role === "tv" && session.tvSocketId === socket.id) { session.tvSocketId = null; session.connected.tv = false; }
      if (role === "controller" && session.controllerSocketId === socket.id) { session.controllerSocketId = null; session.connected.controller = false; }
      session.updatedAt = Date.now();
      io.to(sessionId).emit("presence:update", publicState(session).connected);
    });
  });
}

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";

try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`Smart Display Pro rodando em http://${HOST}:${PORT}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

export default app;
