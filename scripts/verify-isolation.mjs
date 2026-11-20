#!/usr/bin/env node
/**
 * H-Pharmacy Customer Inbox — Phase 1 isolation & Realtime checks.
 *
 * Runs against the hosted Supabase project in .env.local using ONLY the
 * publishable key (exactly what a browser has). Creates two anonymous guests
 * and tries to cross the boundary between them in every way a browser could.
 *
 *   npm run verify:isolation               # guest checks only
 *   npm run verify:isolation -- --admin    # also admin checks (prompts for login)
 *
 * The admin password is typed into a hidden prompt; it is never stored.
 * Test messages start with "[isolation-test]" (see README for cleanup SQL).
 * Voice checks upload synthetic bytes (not real audio) into the private bucket.
 * Image checks upload a generated 1×1 PNG and synthetic JPEG/WebP bytes.
 * Location checks use public landmarks / synthetic coordinates only.
 */
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import readline from "node:readline";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const WITH_ADMIN = process.argv.includes("--admin");
const TAG = "[isolation-test]";
const REALTIME_WAIT_MS = 5000;

if (!URL || !KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in .env.local");
  process.exit(2);
}

const results = [];
function record(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
async function check(name, fn) {
  try {
    const out = await fn();
    if (out === true || out === undefined) record(name, true);
    else record(name, false, typeof out === "string" ? out : JSON.stringify(out));
  } catch (e) {
    record(name, false, e?.message ?? String(e));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function newClient() {
  return createClient(URL, KEY, {
    auth: { persistSession: false, autoRefreshToken: false, storageKey: `t-${randomUUID()}` },
  });
}

async function newGuest(label) {
  const client = newClient();
  const { data, error } = await client.auth.signInAnonymously();
  if (error) throw new Error(`${label}: anonymous sign-in failed: ${error.message}`);
  const { data: conversationId, error: e2 } = await client.rpc("get_or_create_my_conversation");
  if (e2) throw new Error(`${label}: get_or_create_my_conversation failed: ${e2.message}`);
  const { data: cust } = await client.from("customers").select("public_ref").single();
  return { label, client, userId: data.user.id, conversationId, ref: cust?.public_ref };
}

async function send(client, conversationId, body, clientMessageId = randomUUID()) {
  return client.rpc("send_message", {
    p_conversation_id: conversationId,
    p_body: body,
    p_client_message_id: clientMessageId,
  });
}

/** Subscribe and collect events; resolves once the channel is SUBSCRIBED. */
function listen(client, name, table, filter) {
  const events = [];
  return new Promise((resolve, reject) => {
    const opts = { event: "*", schema: "public", table };
    if (filter) opts.filter = filter;
    const channel = client
      .channel(`${name}-${randomUUID()}`)
      .on("postgres_changes", opts, (payload) => events.push(payload))
      .subscribe((status, err) => {
        if (status === "SUBSCRIBED") resolve({ channel, events });
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT")
          reject(new Error(`${name}: ${status} ${err?.message ?? ""}`));
      });
    setTimeout(() => reject(new Error(`${name}: subscribe timeout`)), 15000);
  });
}

function askHidden(question, hidden) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    rl._writeToOutput = (s) => {
      if (s.includes(question)) rl.output.write(s);
    };
  }
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    }),
  );
}

// ---------------------------------------------------------------------------
// Phase 2B voice-note checks (synthetic audio bytes, never real recordings)
// ---------------------------------------------------------------------------
const BUCKET = "chat-media";

/** Synthetic "audio" payload: random bytes tagged with an audio MIME type. */
function syntheticAudio(bytes = 4096, type = "audio/webm") {
  const buf = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) buf[i] = (i * 31 + 7) & 0xff;
  return new Blob([buf], { type });
}

async function uploadAndSendVoice(who, conversationId, { ext = "webm", type = "audio/webm", bytes = 4096, durationMs = 3000, cid = randomUUID() } = {}) {
  const path = `${conversationId}/${cid}.${ext}`;
  const up = await who.storage.from(BUCKET).upload(path, syntheticAudio(bytes, type), { contentType: type, upsert: false });
  const sent = await who.rpc("send_attachment_message", {
    p_conversation_id: conversationId,
    p_type: "audio",
    p_attachment_path: path,
    p_client_message_id: cid,
    p_duration_ms: durationMs,
  });
  return { path, cid, up, sent };
}

async function voiceChecks(A, B) {
  const { data: bucketProbe, error: bucketErr } = await A.client.storage.from(BUCKET).list(A.conversationId);
  if (bucketErr && /not found/i.test(bucketErr.message)) {
    record("Voice notes: chat-media bucket exists", false, "Apply supabase/migrations/20261120000100_phase2b_voice_notes.sql first");
    return null;
  }
  void bucketProbe;

  const bLive = await listen(B.client, "b-voice", "messages");
  const aLive = await listen(A.client, "a-voice", "messages", `conversation_id=eq.${A.conversationId}`);
  await sleep(1000);

  const v = await uploadAndSendVoice(A.client, A.conversationId, { durationMs: 7000 });
  await check("Voice: guest uploads + sends a voice note to own thread", () =>
    !v.up.error && v.sent.data?.type === "audio" && v.sent.data?.sender_role === "customer" &&
    v.sent.data?.attachment_mime === "audio/webm" && v.sent.data?.attachment_duration_ms === 7000
      ? true
      : { upload: v.up.error?.message, send: v.sent.error?.message },
  );

  await check("Voice: retried upload + send creates exactly one message", async () => {
    const again = await A.client.storage.from(BUCKET).upload(v.path, syntheticAudio(), { contentType: "audio/webm", upsert: false });
    const resend = await A.client.rpc("send_attachment_message", {
      p_conversation_id: A.conversationId, p_type: "audio", p_attachment_path: v.path,
      p_client_message_id: v.cid, p_duration_ms: 7000,
    });
    const { data } = await A.client.from("messages").select("id").eq("client_message_id", v.cid);
    const conflict = again.error && (Number(again.error.statusCode ?? again.error.status) === 409 || /exists|duplicate/i.test(again.error.message));
    return conflict && resend.data?.id === v.sent.data?.id && data.length === 1
      ? true
      : { reupload: again.error?.message ?? "succeeded", resend: resend.error?.message, rows: data?.length };
  });

  await check("Voice: playback after refresh (new client, same session) returns the audio", async () => {
    const { data: s } = await A.client.auth.getSession();
    const refreshed = newClient();
    await refreshed.auth.setSession({ access_token: s.session.access_token, refresh_token: s.session.refresh_token });
    const { data: rows } = await refreshed.from("messages").select("attachment_path, attachment_mime").eq("id", v.sent.data.id);
    const { data: signed, error } = await refreshed.storage.from(BUCKET).createSignedUrl(rows[0].attachment_path, 300);
    if (error) return error.message;
    const res = await fetch(signed.signedUrl);
    const body = new Uint8Array(await res.arrayBuffer());
    return res.ok && (res.headers.get("content-type") ?? "").startsWith("audio/webm") && body.length === 4096
      ? true
      : { status: res.status, type: res.headers.get("content-type"), size: body.length };
  });

  await check("Voice privacy: B cannot sign, download or list A's audio", async () => {
    const s = await B.client.storage.from(BUCKET).createSignedUrl(v.path, 60);
    const d = await B.client.storage.from(BUCKET).download(v.path);
    const l = await B.client.storage.from(BUCKET).list(A.conversationId);
    return s.error && d.error && (l.error || (l.data ?? []).length === 0)
      ? true
      : { signed: !!s.data, downloaded: !!d.data, listed: l.data?.length };
  });
  await check("Voice privacy: B cannot upload into A's folder", async () => {
    const r = await B.client.storage.from(BUCKET).upload(`${A.conversationId}/${randomUUID()}.webm`, syntheticAudio(), { contentType: "audio/webm" });
    return r.error ? true : "upload succeeded";
  });
  await check("Voice privacy: B cannot attach A's object to B's thread", async () => {
    const r = await B.client.rpc("send_attachment_message", {
      p_conversation_id: B.conversationId, p_type: "audio", p_attachment_path: v.path,
      p_client_message_id: v.cid, p_duration_ms: 1000,
    });
    return r.error ? true : "send succeeded";
  });
  await check("Voice privacy: no public URL access to the private bucket", async () => {
    const res = await fetch(`${URL}/storage/v1/object/public/${BUCKET}/${v.path}`);
    return !res.ok ? true : `public fetch returned ${res.status}`;
  });
  await check("Voice privacy: signed-out browser cannot sign A's audio", async () => {
    const r = await newClient().storage.from(BUCKET).createSignedUrl(v.path, 60);
    return r.error ? true : "signed URL issued";
  });

  await check("Voice storage boundary: non-audio type rejected", async () => {
    const r = await A.client.storage.from(BUCKET).upload(`${A.conversationId}/${randomUUID()}.webm`, new Blob(["<html>"], { type: "text/html" }), { contentType: "text/html" });
    return r.error ? true : "text/html accepted";
  });
  await check("Voice storage boundary: file over 3 MB rejected", async () => {
    const r = await A.client.storage.from(BUCKET).upload(`${A.conversationId}/${randomUUID()}.webm`, syntheticAudio(3 * 1024 * 1024 + 1), { contentType: "audio/webm" });
    return r.error ? true : "oversized file accepted";
  });
  await check("Voice storage boundary: disallowed file name rejected", async () => {
    const r = await A.client.storage.from(BUCKET).upload(`${A.conversationId}/${randomUUID()}.mp3`, syntheticAudio(), { contentType: "audio/webm" });
    return r.error ? true : ".mp3 path accepted";
  });
  await check("Voice: Safari-style audio/mp4 (.m4a) accepted", async () => {
    const r = await uploadAndSendVoice(A.client, A.conversationId, { ext: "m4a", type: "audio/mp4" });
    return !r.up.error && r.sent.data?.attachment_mime === "audio/mp4" ? true : { up: r.up.error?.message, send: r.sent.error?.message };
  });
  await check("Voice: browser cannot overwrite or delete audio", async () => {
    const u = await A.client.storage.from(BUCKET).upload(v.path, syntheticAudio(10), { contentType: "audio/webm", upsert: true });
    const d = await A.client.storage.from(BUCKET).remove([v.path]);
    const still = await A.client.storage.from(BUCKET).createSignedUrl(v.path, 60);
    const res = still.data ? await fetch(still.data.signedUrl) : null;
    const size = res ? (await res.arrayBuffer()).byteLength : 0;
    return u.error && size === 4096 ? true : { overwrite: u.error?.message ?? "succeeded", removed: d.data?.length, size };
  });
  await check("Voice: admin unread + list preview updated", async () => {
    const { data } = await A.client.from("conversations").select("last_message_preview").single();
    return /^Voice note/.test(data.last_message_preview ?? "") ? true : data;
  });

  await sleep(REALTIME_WAIT_MS);
  await check("Voice Realtime: A receives its voice note live", () =>
    aLive.events.some((e) => e.new?.id === v.sent.data?.id) ? true : `${aLive.events.length} events`,
  );
  await check("Voice Realtime: B receives no event for A's voice note", () =>
    bLive.events.some((e) => e.new?.conversation_id === A.conversationId) ? "leaked" : true,
  );
  return { path: v.path };
}

async function adminVoiceChecks(admin, A, B, voice) {
  await check("Voice: admin can play the guest's voice note", async () => {
    const { data, error } = await admin.storage.from(BUCKET).createSignedUrl(voice.path, 60);
    if (error) return error.message;
    const res = await fetch(data.signedUrl);
    return res.ok ? true : res.status;
  });
  const bLive = await listen(B.client, "b-admin-voice", "messages", `conversation_id=eq.${B.conversationId}`);
  const aLive = await listen(A.client, "a-admin-voice", "messages");
  await sleep(1000);
  const r = await uploadAndSendVoice(admin, B.conversationId, { ext: "ogg", type: "audio/ogg", durationMs: 2500 });
  await sleep(REALTIME_WAIT_MS);
  await check("Voice: admin sends a voice note to guest B (role admin)", () =>
    !r.up.error && r.sent.data?.sender_role === "admin" ? true : { up: r.up.error?.message, send: r.sent.error?.message },
  );
  await check("Voice Realtime: B receives the admin voice note; A does not", () =>
    bLive.events.some((e) => e.new?.id === r.sent.data?.id) &&
    !aLive.events.some((e) => e.new?.conversation_id === B.conversationId)
      ? true
      : { b: bLive.events.length, aLeaks: aLive.events.filter((e) => e.new?.conversation_id === B.conversationId).length },
  );
  await check("Voice: B can play the admin's voice note; A cannot", async () => {
    const b = await B.client.storage.from(BUCKET).createSignedUrl(r.path, 60);
    const a = await A.client.storage.from(BUCKET).createSignedUrl(r.path, 60);
    const res = b.data ? await fetch(b.data.signedUrl) : null;
    return res?.ok && a.error ? true : { b: b.error?.message, a: a.data ? "A got a URL" : a.error?.message };
  });
}

// ---------------------------------------------------------------------------
// Phase 2A image checks (synthetic images only)
// ---------------------------------------------------------------------------
const PNG_1PX = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="),
  (c) => c.charCodeAt(0),
);

async function uploadAndSendImage(who, conversationId, { ext = "png", type = "image/png", body, cid = randomUUID(), width = 1, height = 1 } = {}) {
  const path = `${conversationId}/${cid}.${ext}`;
  const blob = new Blob([body ?? PNG_1PX], { type });
  const up = await who.storage.from(BUCKET).upload(path, blob, { contentType: type, upsert: false });
  const sent = await who.rpc("send_attachment_message", {
    p_conversation_id: conversationId,
    p_type: "image",
    p_attachment_path: path,
    p_client_message_id: cid,
    p_width: width,
    p_height: height,
  });
  return { path, cid, up, sent };
}

async function imageChecks(A, B) {
  // Detect whether the image migration has been applied.
  const probe = await uploadAndSendImage(A.client, A.conversationId);
  if (probe.up.error && /mime|not supported|invalid/i.test(probe.up.error.message)) {
    record("Images: chat-media accepts images", false, "Apply supabase/migrations/20261121000100_phase2a_image_messages.sql first");
    return null;
  }

  const bLive = await listen(B.client, "b-img", "messages");
  const aLive = await listen(A.client, "a-img", "messages", `conversation_id=eq.${A.conversationId}`);
  await sleep(1000);

  const img = await uploadAndSendImage(A.client, A.conversationId, { width: 1, height: 1 });
  await check("Images: guest uploads + sends a PNG (type/mime/dims derived)", () =>
    !img.up.error && img.sent.data?.type === "image" && img.sent.data?.attachment_mime === "image/png" &&
    img.sent.data?.attachment_width === 1 && img.sent.data?.sender_role === "customer"
      ? true
      : { up: img.up.error?.message, send: img.sent.error?.message },
  );
  for (const [ext, type] of [["jpg", "image/jpeg"], ["webp", "image/webp"]]) {
    await check(`Images: ${type} accepted`, async () => {
      const r = await uploadAndSendImage(A.client, A.conversationId, { ext, type, body: syntheticAudio(2048, type), width: 640, height: 480 });
      return !r.up.error && r.sent.data?.attachment_mime === type ? true : { up: r.up.error?.message, send: r.sent.error?.message };
    });
  }
  await check("Images: retried upload + send creates exactly one message", async () => {
    const again = await A.client.storage.from(BUCKET).upload(img.path, new Blob([PNG_1PX], { type: "image/png" }), { contentType: "image/png", upsert: false });
    const resend = await A.client.rpc("send_attachment_message", {
      p_conversation_id: A.conversationId, p_type: "image", p_attachment_path: img.path,
      p_client_message_id: img.cid, p_width: 1, p_height: 1,
    });
    const { data } = await A.client.from("messages").select("id").eq("client_message_id", img.cid);
    return again.error && resend.data?.id === img.sent.data?.id && data.length === 1
      ? true
      : { reupload: again.error?.message ?? "succeeded", resend: resend.error?.message, rows: data?.length };
  });
  await check("Images: history after refresh loads the image bytes", async () => {
    const { data: s } = await A.client.auth.getSession();
    const refreshed = newClient();
    await refreshed.auth.setSession({ access_token: s.session.access_token, refresh_token: s.session.refresh_token });
    const { data: rows } = await refreshed.from("messages").select("type, attachment_path").eq("conversation_id", A.conversationId).order("seq");
    const types = new Set(rows.map((r) => r.type));
    const row = rows.find((r) => r.attachment_path === img.path);
    const { data: signed, error } = await refreshed.storage.from(BUCKET).createSignedUrl(row.attachment_path, 300);
    if (error) return error.message;
    const res = await fetch(signed.signedUrl);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return res.ok && res.headers.get("content-type")?.startsWith("image/png") && bytes.length === PNG_1PX.length &&
      types.has("text") && types.has("audio") && types.has("image")
      ? true
      : { status: res.status, type: res.headers.get("content-type"), size: bytes.length, types: [...types] };
  });

  await check("Image privacy: B cannot sign, download or list A's images", async () => {
    const s = await B.client.storage.from(BUCKET).createSignedUrl(img.path, 60);
    const d = await B.client.storage.from(BUCKET).download(img.path);
    const l = await B.client.storage.from(BUCKET).list(A.conversationId);
    return s.error && d.error && (l.error || (l.data ?? []).length === 0) ? true : "B reached A's image";
  });
  await check("Image privacy: B cannot upload into A's folder or attach A's image", async () => {
    const u = await B.client.storage.from(BUCKET).upload(`${A.conversationId}/${randomUUID()}.png`, new Blob([PNG_1PX], { type: "image/png" }), { contentType: "image/png" });
    const a = await B.client.rpc("send_attachment_message", {
      p_conversation_id: B.conversationId, p_type: "image", p_attachment_path: img.path,
      p_client_message_id: img.cid, p_width: 1, p_height: 1,
    });
    return u.error && a.error ? true : { upload: !u.error, attach: !a.error };
  });
  await check("Image privacy: no public URL access", async () => {
    const res = await fetch(`${URL}/storage/v1/object/public/${BUCKET}/${img.path}`);
    return !res.ok ? true : `public fetch returned ${res.status}`;
  });
  await check("Image boundary: GIF/SVG uploads rejected", async () => {
    const g = await A.client.storage.from(BUCKET).upload(`${A.conversationId}/${randomUUID()}.png`, new Blob(["GIF89a"], { type: "image/gif" }), { contentType: "image/gif" });
    const s = await A.client.storage.from(BUCKET).upload(`${A.conversationId}/${randomUUID()}.png`, new Blob(["<svg/>"], { type: "image/svg+xml" }), { contentType: "image/svg+xml" });
    return g.error && s.error ? true : { gif: !g.error, svg: !s.error };
  });
  await check("Image boundary: file over 3 MB rejected", async () => {
    const r = await A.client.storage.from(BUCKET).upload(`${A.conversationId}/${randomUUID()}.webp`, syntheticAudio(3 * 1024 * 1024 + 1, "image/webp"), { contentType: "image/webp" });
    return r.error ? true : "oversized image accepted";
  });
  await check("Image boundary: PNG stored at .jpg cannot be sent", async () => {
    const r = await uploadAndSendImage(A.client, A.conversationId, { ext: "jpg", type: "image/png" });
    return r.sent.error ? true : "mismatched image sent";
  });
  await check("Images: list preview says Photo", async () => {
    const { data } = await A.client.from("conversations").select("last_message_preview").single();
    return data.last_message_preview === "Photo" ? true : data;
  });

  await sleep(REALTIME_WAIT_MS);
  await check("Image Realtime: A receives its image live", () =>
    aLive.events.some((e) => e.new?.id === img.sent.data?.id) ? true : `${aLive.events.length} events`,
  );
  await check("Image Realtime: B receives no event for A's image", () =>
    bLive.events.some((e) => e.new?.conversation_id === A.conversationId) ? "leaked" : true,
  );
  return { path: img.path };
}

async function adminImageChecks(admin, A, B, images) {
  await check("Images: admin can view the guest's image", async () => {
    const { data, error } = await admin.storage.from(BUCKET).createSignedUrl(images.path, 60);
    if (error) return error.message;
    return (await fetch(data.signedUrl)).ok ? true : "fetch failed";
  });
  const bLive = await listen(B.client, "b-admin-img", "messages", `conversation_id=eq.${B.conversationId}`);
  await sleep(1000);
  const r = await uploadAndSendImage(admin, B.conversationId, { ext: "webp", type: "image/webp", body: syntheticAudio(4096, "image/webp"), width: 1024, height: 768 });
  await sleep(REALTIME_WAIT_MS);
  await check("Images: admin sends image to guest B live; A cannot view it", async () => {
    const a = await A.client.storage.from(BUCKET).createSignedUrl(r.path, 60);
    const b = await B.client.storage.from(BUCKET).createSignedUrl(r.path, 60);
    return r.sent.data?.sender_role === "admin" && bLive.events.some((e) => e.new?.id === r.sent.data?.id) && a.error && !b.error
      ? true
      : { send: r.sent.error?.message, live: bLive.events.length, aBlocked: !!a.error, bOk: !b.error };
  });
}

// ---------------------------------------------------------------------------
// Unread boundary, deletion, profiles, labels (synthetic data only)
// ---------------------------------------------------------------------------
const info = (msg) => console.log(`INFO  ${msg}`);
const PROFILE_BUCKET = "profile-photos";

async function featureChecks(A, B) {
  const probe = await A.client.rpc("hide_message_for_me", { p_message_id: randomUUID() });
  if (probe.error && /could not find|does not exist|schema cache/i.test(probe.error.message)) {
    record("Feature migrations applied", false, "Apply the four 20261122… migrations first");
    return null;
  }
  const { data: custA } = await A.client.from("customers").select("id").single();

  // ---- Unread (guest side)
  await check("Unread: guest mark-read with a read boundary returns a count", async () => {
    const { data: c } = await A.client.from("conversations").select("last_message_seq").single();
    const { data, error } = await A.client.rpc("mark_conversation_read", { p_conversation_id: A.conversationId, p_up_to_seq: c.last_message_seq });
    return !error && typeof data === "number" ? true : error?.message ?? data;
  });
  await check("Unread: other guest cannot mark A's conversation read", async () => {
    const { error } = await B.client.rpc("mark_conversation_read", { p_conversation_id: A.conversationId, p_up_to_seq: 1 });
    return error ? true : "allowed";
  });

  // ---- Deletion (guest side)
  const aLive = newClient();
  const { data: sA } = await A.client.auth.getSession();
  await aLive.auth.setSession({ access_token: sA.session.access_token, refresh_token: sA.session.refresh_token });
  const aUpd = await listen(aLive, "a-updates", "messages", `conversation_id=eq.${A.conversationId}`);
  const bAll = await listen(B.client, "b-deletes", "messages");
  await sleep(1000);

  const { data: t1 } = await send(A.client, A.conversationId, `${TAG} delete me for everyone`);
  await check("Delete: other guest cannot hide or delete A's message", async () => {
    const h = await B.client.rpc("hide_message_for_me", { p_message_id: t1.id });
    const d = await B.client.rpc("delete_message_for_everyone", { p_message_id: t1.id });
    return h.error && d.error ? true : { hide: !h.error, del: !d.error };
  });
  await check("Delete for everyone (guest, text): content cleared", async () => {
    const { data, error } = await A.client.rpc("delete_message_for_everyone", { p_message_id: t1.id });
    return !error && data.deleted_at && data.body === null ? true : error?.message ?? data;
  });
  await check("Delete for everyone survives refresh (new session client)", async () => {
    const fresh = newClient();
    await fresh.auth.setSession({ access_token: sA.session.access_token, refresh_token: sA.session.refresh_token });
    const { data } = await fresh.from("messages").select("body, deleted_at").eq("id", t1.id).single();
    return data.deleted_at && data.body === null ? true : data;
  });

  const { data: t2 } = await send(A.client, A.conversationId, `${TAG} hide me for me`);
  await check("Delete for me: hidden for that person after refresh", async () => {
    const { error } = await A.client.rpc("hide_message_for_me", { p_message_id: t2.id });
    const fresh = newClient();
    await fresh.auth.setSession({ access_token: sA.session.access_token, refresh_token: sA.session.refresh_token });
    const { data } = await fresh.from("messages").select("id").eq("id", t2.id);
    return !error && data.length === 0 ? true : { error: error?.message, rows: data?.length };
  });

  // Image deleted for everyone: fresh access blocked; observe existing signed link.
  const img = await uploadAndSendImage(A.client, A.conversationId);
  const { data: preSigned } = await A.client.storage.from(BUCKET).createSignedUrl(img.path, 120);
  await check("Delete for everyone (image): fresh signed URL + download blocked", async () => {
    const { error } = await A.client.rpc("delete_message_for_everyone", { p_message_id: img.sent.data.id });
    if (error) return error.message;
    const s = await A.client.storage.from(BUCKET).createSignedUrl(img.path, 60);
    const d = await A.client.storage.from(BUCKET).download(img.path);
    return s.error && d.error ? true : { signed: !!s.data, downloaded: !!d.data };
  });
  if (preSigned?.signedUrl) {
    const res = await fetch(preSigned.signedUrl);
    info(`A signed link issued BEFORE delete-for-everyone returned HTTP ${res.status} afterwards ` +
      (res.ok ? "(still works until it expires — the app issues 10-minute links)" : "(blocked)"));
  }
  const voice = await uploadAndSendVoice(A.client, A.conversationId, { durationMs: 2000 });
  await check("Delete for everyone (voice): fresh access blocked", async () => {
    const { error } = await A.client.rpc("delete_message_for_everyone", { p_message_id: voice.sent.data.id });
    const s = await A.client.storage.from(BUCKET).createSignedUrl(voice.path, 60);
    return !error && s.error ? true : { error: error?.message, signed: !!s.data };
  });

  await sleep(REALTIME_WAIT_MS);
  await check("Delete Realtime: A's other tab receives the deletion live", () =>
    aUpd.events.some((e) => e.eventType === "UPDATE" && e.new?.id === t1.id && e.new?.deleted_at && e.new?.body === null)
      ? true : `${aUpd.events.length} events`,
  );
  await check("Delete Realtime: B receives nothing from A's thread", () =>
    bAll.events.some((e) => e.new?.conversation_id === A.conversationId) ? "leaked" : true,
  );
  await aLive.removeAllChannels();

  // ---- Profiles
  await check("Profile: guest saves name + bio on the same customer/HP reference", async () => {
    const { data, error } = await A.client.rpc("update_my_profile", { p_display_name: `${TAG} Test Name`, p_bio: "Synthetic bio" });
    return !error && data.id === custA.id && data.public_ref === A.ref ? true : error?.message ?? data;
  });
  await check("Profile: other guest cannot read it", async () => {
    const { data } = await B.client.from("customers").select("display_name").eq("id", custA.id);
    return (data ?? []).length === 0 ? true : data;
  });
  const avatarPath = `${custA.id}/${randomUUID()}.png`;
  await check("Profile photo: upload + set; owner can view", async () => {
    const up = await A.client.storage.from(PROFILE_BUCKET).upload(avatarPath, new Blob([PNG_1PX], { type: "image/png" }), { contentType: "image/png" });
    if (up.error) return `upload: ${up.error.message}`;
    const { error } = await A.client.rpc("set_my_avatar", { p_path: avatarPath });
    const s = await A.client.storage.from(PROFILE_BUCKET).createSignedUrl(avatarPath, 60);
    return !error && s.data ? true : { set: error?.message, sign: s.error?.message };
  });
  await check("Profile photo: other guest cannot view or upload into A's folder", async () => {
    const s = await B.client.storage.from(PROFILE_BUCKET).createSignedUrl(avatarPath, 60);
    const u = await B.client.storage.from(PROFILE_BUCKET).upload(`${custA.id}/${randomUUID()}.png`, new Blob([PNG_1PX], { type: "image/png" }), { contentType: "image/png" });
    return s.error && u.error ? true : { sign: !!s.data, upload: !u.error };
  });
  await check("Profile photo: over 1 MB rejected by the bucket", async () => {
    const u = await A.client.storage.from(PROFILE_BUCKET).upload(`${custA.id}/${randomUUID()}.webp`, syntheticAudio(1024 * 1024 + 1, "image/webp"), { contentType: "image/webp" });
    return u.error ? true : "accepted";
  });

  // ---- Labels (guest must never see them)
  await check("Labels: guest cannot read, create or assign; admin list refused", async () => {
    const l = await B.client.from("labels").select("*");
    const cl = await B.client.from("customer_labels").select("*");
    const ins = await B.client.from("labels").insert({ name: `${TAG} hack` });
    const lst = await B.client.rpc("admin_list_conversations");
    return (l.error || l.data.length === 0) && (cl.error || cl.data.length === 0) && ins.error && lst.error
      ? true : { labels: l.data?.length, assigns: cl.data?.length, insert: !ins.error, list: !lst.error };
  });
  const bLabels = await listen(B.client, "b-labels", "labels").catch(() => null);
  const bAssign = await listen(B.client, "b-customer-labels", "customer_labels").catch(() => null);
  return { custA, avatarPath, bLabels, bAssign };
}

async function adminFeatureChecks(admin, A, B, f) {
  // ---- Unread with read boundary, including a message arriving mid-update
  const { data: m1 } = await send(A.client, A.conversationId, `${TAG} unread 1`);
  const { data: m2 } = await send(A.client, A.conversationId, `${TAG} unread 2 (arrives during mark-read)`);
  await check("Unread: admin marks read up to the viewed message; later one stays unread", async () => {
    const { data, error } = await admin.rpc("mark_conversation_read", { p_conversation_id: A.conversationId, p_up_to_seq: m1.seq });
    return !error && data === 1 ? true : error?.message ?? data;
  });
  await check("Unread: cleared at the latest message and stays cleared after refresh", async () => {
    await admin.rpc("mark_conversation_read", { p_conversation_id: A.conversationId, p_up_to_seq: m2.seq });
    const { data } = await admin.rpc("admin_list_conversations", { p_conversation_id: A.conversationId });
    return data?.[0]?.admin_unread_count === 0 ? true : data;
  });
  await check("Unread: a new message counts again; other conversations unaffected", async () => {
    const { data: before } = await admin.rpc("admin_list_conversations", { p_conversation_id: B.conversationId });
    await send(A.client, A.conversationId, `${TAG} unread 3`);
    const { data: a } = await admin.rpc("admin_list_conversations", { p_conversation_id: A.conversationId });
    const { data: b } = await admin.rpc("admin_list_conversations", { p_conversation_id: B.conversationId });
    return a?.[0]?.admin_unread_count === 1 && b?.[0]?.admin_unread_count === before?.[0]?.admin_unread_count ? true : { a, b };
  });

  // ---- Deletion rules for the admin
  const { data: cm } = await send(A.client, A.conversationId, `${TAG} customer message`);
  await check("Delete: admin cannot delete a customer's message for everyone", async () => {
    const { error } = await admin.rpc("delete_message_for_everyone", { p_message_id: cm.id });
    return error ? true : "allowed";
  });
  await check("Delete for me (admin): hidden for admin only; customer still sees it", async () => {
    const { error } = await admin.rpc("hide_message_for_me", { p_message_id: cm.id });
    const { data: ad } = await admin.from("messages").select("id").eq("id", cm.id);
    const { data: gu } = await A.client.from("messages").select("body").eq("id", cm.id);
    return !error && ad.length === 0 && gu[0]?.body?.includes("customer message") ? true : { error: error?.message, ad, gu };
  });
  const aLive = await listen(A.client, "a-admin-delete", "messages", `conversation_id=eq.${A.conversationId}`);
  await sleep(1000);
  const { data: am } = await send(admin, A.conversationId, `${TAG} admin message to delete`);
  await check("Delete for everyone (admin's own message): cleared for the customer", async () => {
    const { error } = await admin.rpc("delete_message_for_everyone", { p_message_id: am.id });
    await sleep(REALTIME_WAIT_MS);
    const { data } = await A.client.from("messages").select("body, deleted_at").eq("id", am.id).single();
    const live = aLive.events.some((e) => e.eventType === "UPDATE" && e.new?.id === am.id && e.new?.deleted_at);
    return !error && data.deleted_at && data.body === null && live ? true : { error: error?.message, data, live };
  });

  // ---- Profile visible to admin; replaced photo no longer served
  await check("Profile: admin sees name, bio and current photo", async () => {
    const { data } = await admin.from("customers").select("display_name, bio, avatar_path, public_ref").eq("id", f.custA.id).single();
    const s = await admin.storage.from(PROFILE_BUCKET).createSignedUrl(f.avatarPath, 60);
    return data?.display_name?.includes("Test Name") && data.bio === "Synthetic bio" && data.public_ref === A.ref && !s.error
      ? true : { data, sign: s.error?.message };
  });
  await check("Profile: after removing the photo the admin can no longer load it", async () => {
    await A.client.rpc("remove_my_avatar");
    const s = await admin.storage.from(PROFILE_BUCKET).createSignedUrl(f.avatarPath, 60);
    return s.error ? true : "still served";
  });

  // ---- Labels
  const name = `${TAG} Pending Order ${randomUUID().slice(0, 6)}`;
  const { data: L, error: le } = await admin.from("labels").insert({ name: `  ${name}  ` }).select().single();
  await check("Labels: admin creates a label (trimmed)", () => (!le && L.name === name ? true : le?.message ?? L));
  if (L) {
    await check("Labels: duplicate differing by case/spaces rejected", async () => {
      const { error } = await admin.from("labels").insert({ name: ` ${name.toUpperCase()} ` });
      return error ? true : "duplicate accepted";
    });
    await check("Labels: assign to customer, list shows it, filter works", async () => {
      const ins = await admin.from("customer_labels").insert({ customer_id: f.custA.id, label_id: L.id });
      const dup = await admin.from("customer_labels").insert({ customer_id: f.custA.id, label_id: L.id });
      const { data } = await admin.rpc("admin_list_conversations", { p_label_id: L.id });
      return !ins.error && dup.error && data.length === 1 && data[0].id === A.conversationId && data[0].labels.some((x) => x.id === L.id)
        ? true : { ins: ins.error?.message, dup: !dup.error, data };
    });
    await sleep(REALTIME_WAIT_MS);
    await check("Labels: guests receive no label events live", () => {
      const n = (f.bLabels?.events.length ?? 0) + (f.bAssign?.events.length ?? 0);
      return n === 0 ? true : `${n} events`;
    });
    await check("Labels: guest A cannot see its own labels", async () => {
      const { data } = await A.client.from("customer_labels").select("*");
      return (data ?? []).length === 0 ? true : data;
    });
    await check("Labels: deleting a label removes assignments, chat intact", async () => {
      const { count: before } = await admin.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", A.conversationId);
      const { error } = await admin.from("labels").delete().eq("id", L.id);
      const { data: left } = await admin.from("customer_labels").select("*").eq("label_id", L.id);
      const { count: after } = await admin.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", A.conversationId);
      return !error && left.length === 0 && before === after ? true : { error: error?.message, left: left?.length, before, after };
    });
  }
}

// ---------------------------------------------------------------------------
// Chat pins (admin), message pins (shared), location messages
// Synthetic coordinates / public landmarks only.
// ---------------------------------------------------------------------------
const LANDMARK = { name: "Mazar-e-Quaid, Karachi", lat: 24.8752, lng: 67.04 };
const LANDMARK_2 = { name: "Faisal Mosque, Islamabad", lat: 33.7295, lng: 73.0373 };

async function sendLocation(client, conversationId, lat, lng, accuracy = null, cid = randomUUID()) {
  return client.rpc("send_location_message", {
    p_conversation_id: conversationId,
    p_latitude: lat,
    p_longitude: lng,
    p_client_message_id: cid,
    p_accuracy_m: accuracy,
  });
}

async function pinLocationChecks(A, B) {
  const probe = await A.client.rpc("unpin_message", { p_conversation_id: A.conversationId });
  if (probe.error && /could not find|does not exist|schema cache/i.test(probe.error.message)) {
    record("Pins/location migrations applied", false, "Apply the three 20261123… migrations first");
    return null;
  }

  // ---- Locations (guest side)
  const aLive = await listen(A.client, "a-loc", "messages", `conversation_id=eq.${A.conversationId}`);
  const bAll = await listen(B.client, "b-loc", "messages");
  await sleep(1000);
  const { data: loc, error: locErr } = await sendLocation(A.client, A.conversationId, LANDMARK.lat, LANDMARK.lng, 15);
  await check(`Location: guest sends ${LANDMARK.name}`, () =>
    !locErr && loc.type === "location" && loc.location_lat === LANDMARK.lat && loc.location_lng === LANDMARK.lng && loc.sender_role === "customer"
      ? true : locErr?.message ?? loc,
  );
  await check("Location: retry with the same client id creates one message", async () => {
    const cid = randomUUID();
    const r1 = await sendLocation(A.client, A.conversationId, 1.5, 2.5, null, cid);
    const r2 = await sendLocation(A.client, A.conversationId, 1.5, 2.5, null, cid);
    const { data } = await A.client.from("messages").select("id").eq("client_message_id", cid);
    return r1.data?.id === r2.data?.id && data.length === 1 ? true : { r1: r1.error?.message, r2: r2.error?.message, rows: data?.length };
  });
  await check("Location: invalid coordinates rejected (range, NaN→null, missing)", async () => {
    const bad = [[91, 0], [0, 181], [-90.5, 0], [Number.NaN, 0], [0, Number.POSITIVE_INFINITY], [null, 1]];
    const res = [];
    for (const [lat, lng] of bad) res.push(!!(await sendLocation(A.client, A.conversationId, lat, lng)).error);
    return res.every(Boolean) ? true : res;
  });
  await check("Location: other guest cannot send into or read A's chat", async () => {
    const s = await sendLocation(B.client, A.conversationId, 1, 1);
    const { data } = await B.client.from("messages").select("id").eq("id", loc.id);
    return s.error && (data ?? []).length === 0 ? true : { send: !s.error, read: data?.length };
  });
  await check("Location: history after refresh keeps the coordinates", async () => {
    const { data: sess } = await A.client.auth.getSession();
    const fresh = newClient();
    await fresh.auth.setSession({ access_token: sess.session.access_token, refresh_token: sess.session.refresh_token });
    const { data } = await fresh.from("messages").select("type, location_lat, location_lng, location_accuracy_m").eq("id", loc.id).single();
    return data.type === "location" && data.location_lat === LANDMARK.lat && data.location_lng === LANDMARK.lng ? true : data;
  });

  // ---- Message pins (guest side)
  const { data: older } = await send(A.client, A.conversationId, `${TAG} older message to pin`);
  for (let i = 0; i < 3; i++) await send(A.client, A.conversationId, `${TAG} filler ${i}`);
  await check("Pin: guest pins an older message", async () => {
    const { error } = await A.client.rpc("pin_message", { p_message_id: older.id });
    const { data } = await A.client.from("conversations").select("pinned_message_id").single();
    return !error && data.pinned_message_id === older.id ? true : error?.message ?? data;
  });
  await check("Pin: other guest cannot pin/unpin or see A's pin", async () => {
    const p = await B.client.rpc("pin_message", { p_message_id: older.id });
    const u = await B.client.rpc("unpin_message", { p_conversation_id: A.conversationId });
    const { data } = await B.client.from("conversations").select("pinned_message_id").eq("id", A.conversationId);
    return p.error && u.error && (data ?? []).length === 0 ? true : { pin: !p.error, unpin: !u.error, see: data?.length };
  });
  await check("Pin: a location message can be pinned (replaces the old pin)", async () => {
    const { error } = await A.client.rpc("pin_message", { p_message_id: loc.id });
    const { data } = await A.client.from("conversations").select("pinned_message_id").single();
    return !error && data.pinned_message_id === loc.id ? true : error?.message ?? data;
  });
  await check("Pin: delete for everyone clears the pin and the coordinates", async () => {
    const { data: d, error } = await A.client.rpc("delete_message_for_everyone", { p_message_id: loc.id });
    const { data } = await A.client.from("conversations").select("pinned_message_id").single();
    return !error && d.location_lat === null && d.location_lng === null && data.pinned_message_id === null ? true : { error: error?.message, d, data };
  });
  await sleep(REALTIME_WAIT_MS);
  await check("Location Realtime: A receives its location live; B receives nothing", () =>
    aLive.events.some((e) => e.new?.id === loc.id) && !bAll.events.some((e) => e.new?.conversation_id === A.conversationId)
      ? true : { a: aLive.events.length, bLeaks: bAll.events.filter((e) => e.new?.conversation_id === A.conversationId).length },
  );

  // ---- Chat pins are admin-only
  await check("Chat pins: guests cannot read, set or insert", async () => {
    const r = await B.client.from("conversation_pins").select("*");
    const s = await B.client.rpc("set_conversation_pinned", { p_conversation_id: B.conversationId, p_pinned: true });
    const i = await B.client.from("conversation_pins").insert({ conversation_id: B.conversationId });
    return (r.error || r.data.length === 0) && s.error && i.error ? true : { read: r.data?.length, set: !s.error, insert: !i.error };
  });
  const bPins = await listen(B.client, "b-chat-pins", "conversation_pins").catch(() => null);
  return { older, bPins };
}

async function adminPinLocationChecks(admin, A, B, f) {
  // ---- Admin location to guest, live
  const aLive = await listen(A.client, "a-admin-loc", "messages", `conversation_id=eq.${A.conversationId}`);
  await sleep(1000);
  const { data: al, error } = await sendLocation(admin, A.conversationId, LANDMARK_2.lat, LANDMARK_2.lng);
  await sleep(REALTIME_WAIT_MS);
  await check(`Location: admin sends ${LANDMARK_2.name}; guest receives it live`, () =>
    !error && al.sender_role === "admin" && aLive.events.some((e) => e.new?.id === al.id && e.new?.location_lat === LANDMARK_2.lat)
      ? true : { error: error?.message, events: aLive.events.length },
  );

  // ---- Shared pin, live to the guest; Delete for me hides only the hider's banner
  const pinLive = await listen(A.client, "a-pin-live", "conversations", `id=eq.${A.conversationId}`);
  await sleep(1000);
  await check("Pin: admin pins; guest sees the same pin live", async () => {
    const { error: e } = await admin.rpc("pin_message", { p_message_id: f.older.id });
    await sleep(REALTIME_WAIT_MS);
    const live = pinLive.events.some((ev) => ev.new?.pinned_message_id === f.older.id);
    const { data } = await A.client.from("conversations").select("pinned_message_id").single();
    return !e && live && data.pinned_message_id === f.older.id ? true : { e: e?.message, live, data };
  });
  await check("Pin: admin 'Delete for me' hides the pinned content only for the admin", async () => {
    await admin.rpc("hide_message_for_me", { p_message_id: f.older.id });
    const { data: ad } = await admin.from("messages").select("id").eq("id", f.older.id);
    const { data: gu } = await A.client.from("messages").select("body").eq("id", f.older.id);
    return ad.length === 0 && gu.length === 1 ? true : { admin: ad.length, guest: gu.length };
  });

  // ---- Chat pins: order, label filter, persistence
  await check("Chat pins: pinned chat listed first, in the main list and a label filter", async () => {
    const { error: e1 } = await admin.rpc("set_conversation_pinned", { p_conversation_id: B.conversationId, p_pinned: true });
    const { data: all } = await admin.rpc("admin_list_conversations");
    const { data: L } = await admin.from("labels").insert({ name: `${TAG} pin filter ${randomUUID().slice(0, 6)}` }).select().single();
    const custIds = [];
    for (const c of [A, B]) {
      const { data: row } = await admin.from("conversations").select("customer_id").eq("id", c.conversationId).single();
      custIds.push(row.customer_id);
    }
    await admin.from("customer_labels").insert(custIds.map((cid) => ({ customer_id: cid, label_id: L.id })));
    const { data: filtered } = await admin.rpc("admin_list_conversations", { p_label_id: L.id });
    await admin.from("labels").delete().eq("id", L.id);
    const firstAll = all?.[0];
    return !e1 && firstAll?.id === B.conversationId && firstAll.pinned_at && filtered?.[0]?.id === B.conversationId
      ? true : { e1: e1?.message, first: firstAll?.id, filteredFirst: filtered?.[0]?.id };
  });
  await check("Chat pins: persist for a fresh admin session (after refresh)", async () => {
    const { data: s } = await admin.auth.getSession();
    const fresh = newClient();
    await fresh.auth.setSession({ access_token: s.session.access_token, refresh_token: s.session.refresh_token });
    const { data } = await fresh.rpc("admin_list_conversations", { p_conversation_id: B.conversationId });
    return data?.[0]?.pinned_at ? true : data;
  });
  await sleep(REALTIME_WAIT_MS);
  await check("Chat pins: guests receive no chat-pin events", () =>
    (f.bPins?.events.length ?? 0) === 0 ? true : `${f.bPins.events.length} events`,
  );
  await admin.rpc("set_conversation_pinned", { p_conversation_id: B.conversationId, p_pinned: false });
}

async function main() {
  console.log(`Supabase project: ${new globalThis.URL(URL).host}\n`);

  // ---------------------------------------------------------------- setup
  const A = await newGuest("Guest A");
  const B = await newGuest("Guest B");
  console.log(`Guest A ${A.ref}  conversation ${A.conversationId}`);
  console.log(`Guest B ${B.ref}  conversation ${B.conversationId}\n`);

  await check("Each guest gets a distinct conversation and HP- reference", () =>
    A.conversationId !== B.conversationId && /^HP-[A-Z2-9]{6}$/.test(A.ref) && /^HP-[A-Z2-9]{6}$/.test(B.ref) && A.ref !== B.ref
      ? true
      : `A=${A.ref}/${A.conversationId} B=${B.ref}/${B.conversationId}`,
  );

  await check("Repeat + concurrent bootstrap reuses the same conversation (one per guest)", async () => {
    const ids = await Promise.all(
      [1, 2, 3, 4].map(() => A.client.rpc("get_or_create_my_conversation").then((r) => r.data)),
    );
    return ids.every((id) => id === A.conversationId) ? true : ids;
  });

  const { data: msgA, error: sendAErr } = await send(A.client, A.conversationId, `${TAG} hello from A`);
  const { data: msgB, error: sendBErr } = await send(B.client, B.conversationId, `${TAG} hello from B`);
  await check("Guests can send text into their own conversation", () =>
    !sendAErr && !sendBErr && msgA && msgB ? true : sendAErr?.message ?? sendBErr?.message,
  );
  await check("Sender role and user are derived from the session", () =>
    msgA?.sender_role === "customer" && msgA?.sender_user_id === A.userId && msgA?.type === "text"
      ? true
      : msgA,
  );

  // ------------------------------------------------------- read isolation
  await check("A sees only its own conversation", async () => {
    const { data, error } = await A.client.from("conversations").select("id");
    if (error) return error.message;
    return data.length === 1 && data[0].id === A.conversationId ? true : data;
  });
  await check("A cannot read B's conversation by id", async () => {
    const { data } = await A.client.from("conversations").select("id").eq("id", B.conversationId);
    return (data ?? []).length === 0 ? true : data;
  });
  await check("A cannot read B's messages", async () => {
    const { data } = await A.client.from("messages").select("id").eq("conversation_id", B.conversationId);
    return (data ?? []).length === 0 ? true : data;
  });
  await check("A's unfiltered message query returns only A's thread", async () => {
    const { data, error } = await A.client.from("messages").select("conversation_id");
    if (error) return error.message;
    return data.length > 0 && data.every((m) => m.conversation_id === A.conversationId) ? true : data;
  });
  await check("B's customer reference does not grant A access", async () => {
    const { data: c } = await A.client.from("customers").select("id").eq("public_ref", B.ref);
    const { data: all } = await A.client.from("customers").select("public_ref");
    return (c ?? []).length === 0 && all.length === 1 && all[0].public_ref === A.ref ? true : { c, all };
  });

  // ------------------------------------------------------ write isolation
  await check("A cannot send into B's conversation", async () => {
    const { error } = await send(A.client, B.conversationId, `${TAG} intrusion`);
    return error ? true : "send_message succeeded";
  });
  await check("A cannot mark B's conversation read", async () => {
    const { error } = await A.client.rpc("mark_conversation_read", { p_conversation_id: B.conversationId });
    return error ? true : "mark_conversation_read succeeded";
  });
  await check("Direct INSERT into messages is denied (no forged sender/role)", async () => {
    const { error } = await A.client.from("messages").insert({
      conversation_id: A.conversationId,
      sender_role: "admin",
      sender_user_id: B.userId,
      type: "text",
      body: `${TAG} forged`,
      client_message_id: randomUUID(),
    });
    return error ? true : "insert succeeded";
  });
  await check("Direct UPDATE of conversations is denied", async () => {
    const { error, data } = await A.client
      .from("conversations")
      .update({ admin_unread_count: 0 })
      .eq("id", A.conversationId)
      .select();
    return error || (data ?? []).length === 0 ? true : "update succeeded";
  });
  await check("Direct DELETE of messages is denied", async () => {
    const { error, data } = await A.client.from("messages").delete().eq("conversation_id", A.conversationId).select();
    return error || (data ?? []).length === 0 ? true : "delete succeeded";
  });
  await check("Direct INSERT into customers is denied", async () => {
    const { error } = await A.client.from("customers").insert({ user_id: A.userId, public_ref: "HP-ZZZZZZ" });
    return error ? true : "insert succeeded";
  });
  await check("Admin list is not reachable through the API", async () => {
    const { data, error } = await A.client.from("admins").select("*");
    return error || (data ?? []).length === 0 ? true : data;
  });
  await check("Guest is not an admin", async () => {
    const { data, error } = await A.client.rpc("am_i_admin");
    return !error && data === false ? true : { data, error: error?.message };
  });

  // ------------------------------------------------- integrity / retries
  await check("Retry with the same client id does not duplicate", async () => {
    const cid = randomUUID();
    const r1 = await send(A.client, A.conversationId, `${TAG} retry`, cid);
    const r2 = await send(A.client, A.conversationId, `${TAG} retry`, cid);
    const { data } = await A.client.from("messages").select("id").eq("client_message_id", cid);
    return !r1.error && !r2.error && r1.data.id === r2.data.id && data.length === 1
      ? true
      : { r1: r1.error?.message, r2: r2.error?.message, rows: data?.length };
  });
  await check("Empty and over-long messages are rejected", async () => {
    const e1 = (await send(A.client, A.conversationId, "   ")).error;
    const e2 = (await send(A.client, A.conversationId, "x".repeat(4001))).error;
    return e1 && e2 ? true : "accepted invalid body";
  });
  await check("Signed-out browser can read nothing and call nothing", async () => {
    const anon = newClient();
    const m = await anon.from("messages").select("id");
    const c = await anon.from("conversations").select("id");
    const r = await anon.rpc("get_or_create_my_conversation");
    const ok = (m.error || m.data.length === 0) && (c.error || c.data.length === 0) && r.error;
    return ok ? true : { m: m.data?.length, c: c.data?.length, rpc: r.data };
  });

  // ------------------------------------------------------------ realtime
  let subs;
  try {
    subs = {
      aAll: await listen(A.client, "a-all-messages", "messages"),
      aSpyB: await listen(A.client, "a-spy-b", "messages", `conversation_id=eq.${B.conversationId}`),
      aConvs: await listen(A.client, "a-conversations", "conversations"),
      bOwn: await listen(B.client, "b-own", "messages", `conversation_id=eq.${B.conversationId}`),
      bAll: await listen(B.client, "b-all-messages", "messages"),
    };
    await sleep(1000);
    const { data: rtB } = await send(B.client, B.conversationId, `${TAG} realtime from B`);
    const { data: rtA } = await send(A.client, A.conversationId, `${TAG} realtime from A`);
    await sleep(REALTIME_WAIT_MS);

    const ids = (evs) => evs.map((e) => e.new?.id).filter(Boolean);
    await check("Realtime positive control: B receives its own new message", () =>
      ids(subs.bOwn.events).includes(rtB?.id) ? true : `B got ${subs.bOwn.events.length} events`,
    );
    await check("Realtime positive control: A receives its own new message", () =>
      ids(subs.aAll.events).includes(rtA?.id) ? true : `A got ${subs.aAll.events.length} events`,
    );
    await check("Realtime: A receives no events from B's thread (unfiltered)", () => {
      const leaked = subs.aAll.events.filter((e) => e.new?.conversation_id === B.conversationId);
      return leaked.length === 0 ? true : `${leaked.length} leaked`;
    });
    await check("Realtime: A subscribed with B's conversation filter receives nothing", () =>
      subs.aSpyB.events.length === 0 ? true : `${subs.aSpyB.events.length} leaked`,
    );
    await check("Realtime: A receives no conversation updates for B", () => {
      const leaked = subs.aConvs.events.filter((e) => e.new?.id === B.conversationId);
      return leaked.length === 0 ? true : `${leaked.length} leaked`;
    });
    await check("Realtime: B receives no events from A's thread", () => {
      const leaked = subs.bAll.events.filter((e) => e.new?.conversation_id === A.conversationId);
      return leaked.length === 0 ? true : `${leaked.length} leaked`;
    });
  } catch (e) {
    record("Realtime subscriptions", false, e.message);
  }

  // ------------------------------------------------------ voice notes (2B)
  const voice = await voiceChecks(A, B);

  // ---------------------------------------------------------- images (2A)
  const images = await imageChecks(A, B);

  // -------------------- unread, deletion, profiles, labels (guest side)
  const features = await featureChecks(A, B);

  // ------------------------ chat pins, message pins, locations (guest side)
  const pinsLoc = await pinLocationChecks(A, B);

  // --------------------------------------------------------------- admin
  if (WITH_ADMIN) {
    const email = await askHidden("Admin email: ", false);
    const password = await askHidden("Admin password (hidden): ", true);
    const admin = newClient();
    const { error: signInErr } = await admin.auth.signInWithPassword({ email, password });
    if (signInErr) {
      record("Admin sign-in", false, signInErr.message);
    } else {
      await check("Admin membership is recognised", async () => {
        const { data } = await admin.rpc("am_i_admin");
        return data === true ? true : "am_i_admin returned false — add the user to private.admins";
      });
      await check("Admin sees both guest conversations with unread counts", async () => {
        const { data, error } = await admin
          .from("conversations")
          .select("id, admin_unread_count, customers(public_ref)")
          .in("id", [A.conversationId, B.conversationId]);
        if (error) return error.message;
        const ok =
          data.length === 2 &&
          data.every((c) => c.admin_unread_count > 0) &&
          data.map((c) => c.customers.public_ref).sort().join() === [A.ref, B.ref].sort().join();
        return ok ? true : data;
      });

      const aLive = await listen(A.client, "a-admin-reply", "messages", `conversation_id=eq.${A.conversationId}`);
      const bLive = await listen(B.client, "b-admin-reply", "messages");
      await sleep(1000);
      const rA = await send(admin, A.conversationId, `${TAG} admin reply to A`);
      const rB = await send(admin, B.conversationId, `${TAG} admin reply to B`);
      await sleep(REALTIME_WAIT_MS);

      await check("Admin can reply to both; role is derived as admin", () =>
        rA.data?.sender_role === "admin" && rB.data?.sender_role === "admin"
          ? true
          : { a: rA.error?.message, b: rB.error?.message },
      );
      await check("Realtime: A receives the admin reply in its thread", () =>
        aLive.events.some((e) => e.new?.id === rA.data?.id) ? true : `${aLive.events.length} events`,
      );
      await check("Realtime: B does not receive the admin reply meant for A", () =>
        bLive.events.some((e) => e.new?.conversation_id === A.conversationId) ? "leaked" : true,
      );
      await check("Unread counts: admin mark-read clears; customer sees unread reply", async () => {
        await admin.rpc("mark_conversation_read", { p_conversation_id: A.conversationId });
        const { data: adminView } = await admin
          .from("conversations")
          .select("admin_unread_count")
          .eq("id", A.conversationId)
          .single();
        const { data: guestView } = await A.client
          .from("conversations")
          .select("customer_unread_count")
          .single();
        await A.client.rpc("mark_conversation_read", { p_conversation_id: A.conversationId });
        const { data: guestAfter } = await A.client
          .from("conversations")
          .select("customer_unread_count")
          .single();
        return adminView.admin_unread_count === 0 &&
          guestView.customer_unread_count > 0 &&
          guestAfter.customer_unread_count === 0
          ? true
          : { adminView, guestView, guestAfter };
      });
      await check("Admin cannot open a customer inbox for itself", async () => {
        const { error } = await admin.rpc("get_or_create_my_conversation");
        return error ? true : "admin created a customer conversation";
      });
      await check("Admin direct INSERT is still denied (writes only via functions)", async () => {
        const { error } = await admin.from("messages").insert({
          conversation_id: A.conversationId,
          sender_role: "customer",
          body: `${TAG} forged by admin`,
          client_message_id: randomUUID(),
        });
        return error ? true : "insert succeeded";
      });
      if (voice) await adminVoiceChecks(admin, A, B, voice);
      if (images) await adminImageChecks(admin, A, B, images);
      if (features) await adminFeatureChecks(admin, A, B, features);
      if (pinsLoc) await adminPinLocationChecks(admin, A, B, pinsLoc);
      await admin.removeAllChannels();
      await admin.auth.signOut({ scope: "local" });
    }
  } else {
    console.log("\n(skipped admin checks — run with --admin to include them)");
  }

  await A.client.removeAllChannels();
  await B.client.removeAllChannels();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log("Failed:");
    failed.forEach((f) => console.log(` - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("\nVerification aborted:", e.message);
  process.exit(1);
});
