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
