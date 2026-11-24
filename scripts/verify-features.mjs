#!/usr/bin/env node
/**
 * H-Pharmacy Customer Inbox — hosted checks for: delete customer, archiving,
 * emoji, block/unblock and forward message.
 *
 *   npm run verify:features
 *
 * Runs against the Supabase project in .env.local with ONLY the publishable
 * key (what a browser has). It creates dedicated test guests whose names
 * start with "[isolation-test]", uses synthetic files only, and at the end
 * deletes those test customers (rows + Storage files) with the app's own
 * admin delete. Real customers are never read or modified: every admin call
 * targets the test conversations created here.
 *
 * The admin email and password are typed into hidden prompts and never stored.
 */
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import readline from "node:readline";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const TAG = "[isolation-test]";
const BUCKET = "chat-media";
const WAIT = 6000;

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
const newClient = () =>
  createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `t-${randomUUID()}` } });

function askHidden(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => {
    if (s.includes(question)) rl.output.write(s);
  };
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    }),
  );
}

async function newGuest(label) {
  const client = newClient();
  const { data, error } = await client.auth.signInAnonymously();
  if (error) throw new Error(`${label}: anonymous sign-in failed: ${error.message}`);
  const { data: conversationId, error: e2 } = await client.rpc("get_or_create_my_conversation");
  if (e2) throw new Error(`${label}: get_or_create_my_conversation failed: ${e2.message}`);
  await client.rpc("update_my_profile", { p_display_name: `${TAG} ${label}`, p_bio: "Synthetic test customer" });
  const { data: cust } = await client.from("customers").select("id, public_ref").single();
  return { label, client, userId: data.user.id, conversationId, customerId: cust.id, ref: cust.public_ref };
}

const sendText = (client, conversationId, body, cid = randomUUID()) =>
  client.rpc("send_message", { p_conversation_id: conversationId, p_body: body, p_client_message_id: cid });

// Real 1×1 PNG and synthetic "audio" bytes (not a recording).
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);
const AUDIO = Uint8Array.from({ length: 4096 }, (_, i) => (i * 31 + 7) & 0xff);

async function sendAttachment(who, type) {
  const cid = randomUUID();
  const ext = type === "image" ? "png" : "webm";
  const mime = type === "image" ? "image/png" : "audio/webm";
  const path = `${who.conversationId}/${cid}.${ext}`;
  const up = await who.client.storage
    .from(BUCKET)
    .upload(path, new Blob([type === "image" ? PNG : AUDIO], { type: mime }), { contentType: mime, upsert: false });
  if (up.error) throw new Error(`${who.label} upload: ${up.error.message}`);
  const { data, error } = await who.client.rpc("send_attachment_message", {
    p_conversation_id: who.conversationId,
    p_type: type,
    p_attachment_path: path,
    p_client_message_id: cid,
    ...(type === "image" ? { p_width: 1, p_height: 1 } : { p_duration_ms: 3000 }),
  });
  if (error) throw new Error(`${who.label} send ${type}: ${error.message}`);
  return data;
}

/** Fetch a file the way the app does: short signed URL, then download. */
async function fetchBytes(client, path) {
  const { data, error } = await client.storage.from(BUCKET).createSignedUrl(path, 60);
  if (error || !data?.signedUrl) return { error: error?.message ?? "no signed url" };
  const res = await fetch(data.signedUrl);
  if (!res.ok) return { error: `HTTP ${res.status}` };
  return { bytes: new Uint8Array(await res.arrayBuffer()) };
}
const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Subscribe and collect postgres_changes; resolves when SUBSCRIBED. */
function listen(client, table, event, filter) {
  const events = [];
  return new Promise((resolve, reject) => {
    const opts = { event, schema: "public", table };
    if (filter) opts.filter = filter;
    const channel = client
      .channel(`verify-${randomUUID()}`)
      .on("postgres_changes", opts, (p) => events.push(p))
      .subscribe((status, err) => {
        if (status === "SUBSCRIBED") resolve({ channel, events });
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") reject(new Error(`${status} ${err?.message ?? ""}`));
      });
    setTimeout(() => reject(new Error("subscribe timeout")), 15000);
  });
}
async function waitFor(fn, ms = WAIT) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await fn()) return true;
    await sleep(250);
  }
  return false;
}

/** Same steps as the admin UI: queue → Storage API remove → re-check. */
async function runCleanup(admin) {
  const first = await admin.rpc("admin_pending_storage_cleanup");
  if (first.error) throw new Error(first.error.message);
  const byBucket = new Map();
  for (const f of first.data ?? []) byBucket.set(f.bucket_id, [...(byBucket.get(f.bucket_id) ?? []), f.object_name]);
  const removeErrors = [];
  for (const [bucket, names] of byBucket) {
    const { error } = await admin.storage.from(bucket).remove(names);
    if (error) removeErrors.push(error.message);
  }
  const again = await admin.rpc("admin_pending_storage_cleanup");
  return { queued: (first.data ?? []).length, left: (again.data ?? []).length, removeErrors };
}

async function main() {
  console.log("Creating test guests A, B and C (names start with [isolation-test]) …");
  const A = await newGuest("A");
  const B = await newGuest("B");
  const C = await newGuest("C");
  console.log(`  A=${A.ref}  B=${B.ref}  C=${C.ref}`);

  console.log("\nAdmin sign-in (input is hidden; nothing is stored).");
  const email = await askHidden("Admin email (hidden): ");
  const password = await askHidden("Admin password (hidden): ");
  const admin = newClient();
  const { error: signInErr } = await admin.auth.signInWithPassword({ email, password });
  if (signInErr) {
    record("Admin sign-in", false, signInErr.message);
    return finish(null, [A, B, C]);
  }
  record("Admin sign-in", true);
  const listRow = async (who) => {
    const { data, error } = await admin.rpc("admin_list_conversations", { p_conversation_id: who.conversationId });
    if (error) throw new Error(error.message);
    return data?.[0] ?? null;
  };

  // ---------------------------------------------------------------- emoji
  let srcText;
  await check("Emoji: customer sends text + emoji and emoji-only messages", async () => {
    const a = await sendText(A.client, A.conversationId, `${TAG} Is Panadol Extra in stock? 🙏`);
    const b = await sendText(A.client, A.conversationId, "👍😀");
    srcText = a.data;
    return !a.error && !b.error && a.data.body.endsWith("🙏") && b.data.body === "👍😀" ? true : a.error?.message ?? b.error?.message;
  });
  await check("Emoji: admin replies with emoji; customer reads it back unchanged", async () => {
    const r = await sendText(admin, A.conversationId, `${TAG} Yes ✅ thanks 🙏`);
    if (r.error) return r.error.message;
    const { data } = await A.client.from("messages").select("body").eq("id", r.data.id).single();
    return data?.body === `${TAG} Yes ✅ thanks 🙏`;
  });

  // ---------------------------------------------------------------- archive
  await sendText(B.client, B.conversationId, `${TAG} hello from B`);
  await check("Archive: admin archive does not archive the customer's view", async () => {
    const r = await admin.rpc("set_conversation_archived", { p_conversation_id: B.conversationId, p_archived: true });
    if (r.error) return r.error.message;
    const row = await listRow(B);
    const { data } = await B.client.from("conversations").select("customer_archived_at").eq("id", B.conversationId).single();
    return row?.archived_at && data?.customer_archived_at === null ? true : { archived_at: row?.archived_at, customer: data };
  });
  await check("Archive: new customer message keeps the admin archive and raises unread", async () => {
    const before = (await listRow(B)).admin_unread_count;
    await sendText(B.client, B.conversationId, `${TAG} new while archived 😀`);
    const row = await listRow(B);
    return row.archived_at && row.admin_unread_count === before + 1 ? true : row;
  });
  await check("Archive: customer archive is independent and persists (fresh session read)", async () => {
    const r = await B.client.rpc("set_my_conversation_archived", { p_archived: true });
    if (r.error) return r.error.message;
    const { data } = await B.client.from("conversations").select("customer_archived_at").eq("id", B.conversationId).single();
    const row = await listRow(B);
    await B.client.rpc("set_my_conversation_archived", { p_archived: false });
    const after = await listRow(B);
    return data?.customer_archived_at && row.archived_at && after.archived_at ? true : { data, row, after };
  });
  await admin.rpc("set_conversation_archived", { p_conversation_id: B.conversationId, p_archived: false });

  // ---------------------------------------------------------------- block (live)
  const early = await (async () => {
    const cid = randomUUID();
    const path = `${B.conversationId}/${cid}.png`;
    const up = await B.client.storage.from(BUCKET).upload(path, new Blob([PNG], { type: "image/png" }), { contentType: "image/png" });
    return up.error ? null : { cid, path };
  })();
  const live = await listen(B.client, "conversations", "UPDATE", `id=eq.${B.conversationId}`);
  await check("Block: admin blocks B; B receives the blocked state live", async () => {
    const r = await admin.rpc("set_customer_blocked", { p_conversation_id: B.conversationId, p_blocked: true });
    if (r.error) return r.error.message;
    return (await waitFor(() => live.events.some((e) => e.new?.blocked_at))) ? true : `events: ${live.events.length}`;
  });
  await check("Block: customer text/emoji refused", async () => {
    const r = await sendText(B.client, B.conversationId, `${TAG} blocked? 😀`);
    return /blocked/i.test(r.error?.message ?? "") ? true : r.error?.message ?? "sent!";
  });
  await check("Block: admin send refused (both directions)", async () => {
    const r = await sendText(admin, B.conversationId, `${TAG} admin while blocked`);
    return /blocked/i.test(r.error?.message ?? "") ? true : r.error?.message ?? "sent!";
  });
  await check("Block: location refused", async () => {
    const r = await B.client.rpc("send_location_message", { p_conversation_id: B.conversationId, p_latitude: 24.86, p_longitude: 67.01, p_client_message_id: randomUUID() });
    return /blocked/i.test(r.error?.message ?? "") ? true : r.error?.message ?? "sent!";
  });
  await check("Block: new upload refused by Storage", async () => {
    const up = await B.client.storage.from(BUCKET).upload(`${B.conversationId}/${randomUUID()}.png`, new Blob([PNG], { type: "image/png" }), { contentType: "image/png" });
    return up.error ? true : "upload accepted";
  });
  await check("Block: attachment uploaded before the block cannot be finalized", async () => {
    if (!early) return "pre-block upload failed";
    const r = await B.client.rpc("send_attachment_message", { p_conversation_id: B.conversationId, p_type: "image", p_attachment_path: early.path, p_client_message_id: early.cid, p_width: 1, p_height: 1 });
    return /blocked/i.test(r.error?.message ?? "") ? true : r.error?.message ?? "sent!";
  });
  await check("Block: customer can still read; same guest reopening stays blocked", async () => {
    const { data: msgs } = await B.client.from("messages").select("id").eq("conversation_id", B.conversationId);
    const { data: again } = await B.client.rpc("get_or_create_my_conversation");
    const { data: row } = await B.client.from("conversations").select("blocked_at").eq("id", again).single();
    return msgs.length >= 2 && again === B.conversationId && row.blocked_at ? true : { n: msgs.length, same: again === B.conversationId };
  });
  await check("Block: admin cannot forward into a blocked chat", async () => {
    const r = await admin.rpc("admin_forward_message", { p_source_message_id: srcText?.id, p_target_conversation_id: B.conversationId, p_client_message_id: randomUUID() });
    return /blocked/i.test(r.error?.message ?? "") ? true : r.error?.message ?? "forwarded!";
  });
  await check("Unblock: B receives it live and both sides can send again", async () => {
    live.events.length = 0;
    const r = await admin.rpc("set_customer_blocked", { p_conversation_id: B.conversationId, p_blocked: false });
    if (r.error) return r.error.message;
    const gotLive = await waitFor(() => live.events.some((e) => e.new && e.new.blocked_at === null));
    const s1 = await sendText(B.client, B.conversationId, `${TAG} back 🎉`);
    const s2 = await sendText(admin, B.conversationId, `${TAG} welcome back`);
    return gotLive && !s1.error && !s2.error ? true : { gotLive, e1: s1.error?.message, e2: s2.error?.message };
  });
  await B.client.removeChannel(live.channel);
  if (early) await B.client.storage.from(BUCKET).remove([early.path]).catch(() => {});

  // ---------------------------------------------------------------- forward
  const srcImg = await sendAttachment(A, "image");
  const srcVoice = await sendAttachment(A, "audio");
  const { data: srcLoc } = await A.client.rpc("send_location_message", { p_conversation_id: A.conversationId, p_latitude: 24.86, p_longitude: 67.01, p_client_message_id: randomUUID(), p_accuracy_m: 20 });

  const forwardMedia = async (src) => {
    const cid = randomUUID();
    const ext = src.attachment_path.split(".").pop();
    const dest = `${B.conversationId}/${cid}.${ext}`;
    const copy = await admin.storage.from(BUCKET).copy(src.attachment_path, dest);
    if (copy.error) throw new Error(`copy: ${copy.error.message}`);
    const r = await admin.rpc("admin_forward_message", { p_source_message_id: src.id, p_target_conversation_id: B.conversationId, p_client_message_id: cid, p_attachment_path: dest });
    if (r.error) throw new Error(`forward: ${r.error.message}`);
    return { msg: r.data, dest, cid };
  };

  let fText, fImg, fVoice;
  await check("Forward text+emoji: new admin message in B, marked Forwarded", async () => {
    const cid = randomUUID();
    const r = await admin.rpc("admin_forward_message", { p_source_message_id: srcText.id, p_target_conversation_id: B.conversationId, p_client_message_id: cid });
    if (r.error) return r.error.message;
    fText = r.data;
    const again = await admin.rpc("admin_forward_message", { p_source_message_id: srcText.id, p_target_conversation_id: B.conversationId, p_client_message_id: cid });
    return fText.forwarded === true && fText.sender_role === "admin" && fText.body === srcText.body && again.data?.id === fText.id ? true : { fText, again: again.error?.message };
  });
  await check("Forward image: Storage copy under B's folder, B can open it, bytes intact", async () => {
    fImg = await forwardMedia(srcImg);
    const got = await fetchBytes(B.client, fImg.dest);
    return fImg.msg.forwarded && fImg.msg.attachment_path === fImg.dest && got.bytes && sameBytes(got.bytes, PNG) ? true : got.error ?? "bytes differ";
  });
  await check("Forward voice note: own copy, B can download (playback source), bytes intact", async () => {
    fVoice = await forwardMedia(srcVoice);
    const got = await fetchBytes(B.client, fVoice.dest);
    return fVoice.msg.attachment_duration_ms === 3000 && got.bytes && sameBytes(got.bytes, AUDIO) ? true : got.error ?? "bytes differ";
  });
  await check("Forward location: coordinates copied, marked Forwarded", async () => {
    const r = await admin.rpc("admin_forward_message", { p_source_message_id: srcLoc.id, p_target_conversation_id: B.conversationId, p_client_message_id: randomUUID() });
    return !r.error && r.data.type === "location" && r.data.location_lat === 24.86 && r.data.forwarded ? true : r.error?.message ?? r.data;
  });
  await check("Forward retry (media) reuses the copy and message — no duplicates", async () => {
    const copy = await admin.storage.from(BUCKET).copy(srcImg.attachment_path, fImg.dest);
    const r = await admin.rpc("admin_forward_message", { p_source_message_id: srcImg.id, p_target_conversation_id: B.conversationId, p_client_message_id: fImg.cid, p_attachment_path: fImg.dest });
    const { data } = await admin.from("messages").select("id").eq("conversation_id", B.conversationId).eq("client_message_id", fImg.cid);
    return copy.error && r.data?.id === fImg.msg.id && data.length === 1 ? true : { copyErr: copy.error?.message, id: r.data?.id, n: data?.length };
  });
  await check("Isolation: B sees no source ids/refs; cannot read A's messages or files", async () => {
    const { data: rows } = await B.client.from("messages").select("*").eq("conversation_id", B.conversationId).eq("forwarded", true);
    const json = JSON.stringify(rows);
    const leaks = [A.conversationId, A.customerId, A.ref, srcText.id, srcImg.id, srcImg.attachment_path].filter((s) => json.includes(s));
    const { data: aMsgs } = await B.client.from("messages").select("id").eq("conversation_id", A.conversationId);
    const srcFile = await fetchBytes(B.client, srcImg.attachment_path);
    return rows.length === 4 && leaks.length === 0 && aMsgs.length === 0 && srcFile.error ? true : { n: rows.length, leaks, aMsgs: aMsgs.length, srcFile };
  });
  await check("Deleting the originals (for everyone) keeps B's forwarded image and voice working", async () => {
    const d1 = await A.client.rpc("delete_message_for_everyone", { p_message_id: srcImg.id });
    const d2 = await A.client.rpc("delete_message_for_everyone", { p_message_id: srcVoice.id });
    if (d1.error || d2.error) return d1.error?.message ?? d2.error?.message;
    const srcGone = await fetchBytes(A.client, srcImg.attachment_path);
    const img = await fetchBytes(B.client, fImg.dest);
    const voice = await fetchBytes(B.client, fVoice.dest);
    return srcGone.error && img.bytes && voice.bytes ? true : { srcGone: !!srcGone.error, img: img.error, voice: voice.error };
  });
  await check("Deleted original can no longer be forwarded", async () => {
    const r = await admin.rpc("admin_forward_message", { p_source_message_id: srcImg.id, p_target_conversation_id: B.conversationId, p_client_message_id: randomUUID() });
    return /not available/i.test(r.error?.message ?? "") ? true : r.error?.message ?? "forwarded!";
  });
  await check("Unsent forwarded copy is released and removed by cleanup", async () => {
    const srcImg2 = await sendAttachment(A, "image");
    const cid = randomUUID();
    const dest = `${B.conversationId}/${cid}.png`;
    const copy = await admin.storage.from(BUCKET).copy(srcImg2.attachment_path, dest);
    if (copy.error) return `copy: ${copy.error.message}`;
    const rel = await admin.rpc("admin_release_unsent_attachment", { p_attachment_path: dest });
    if (rel.error || rel.data !== true) return `release returned ${rel.data} ${rel.error?.message ?? ""} (Storage may not record the admin as the copy's owner)`;
    const c = await runCleanup(admin);
    const still = await fetchBytes(admin, dest);
    return still.error && c.removeErrors.length === 0 ? true : { cleanup: c, stillThere: !still.error };
  });

  // ---------------------------------------------------------------- delete customer C
  await sendText(C.client, C.conversationId, `${TAG} please delete me`);
  const cImg = await sendAttachment(C, "image");
  const avatarPath = `${C.customerId}/${randomUUID()}.png`;
  await C.client.storage.from("profile-photos").upload(avatarPath, new Blob([PNG], { type: "image/png" }), { contentType: "image/png" });
  await C.client.rpc("set_my_avatar", { p_path: avatarPath });
  const cDel = await listen(C.client, "conversations", "DELETE");
  await check("Delete customer: refused for a guest; only admin can delete", async () => {
    const r = await B.client.rpc("admin_delete_customer", { p_customer_id: C.customerId });
    return /Admin access required/.test(r.error?.message ?? "") ? true : r.error?.message ?? "deleted!";
  });
  await check("Delete customer C: rows removed, files queued", async () => {
    const r = await admin.rpc("admin_delete_customer", { p_customer_id: C.customerId });
    return !r.error && r.data?.files_queued >= 2 ? true : r.error?.message ?? r.data;
  });
  await check("Delete customer C: open guest session receives the deletion live", async () =>
    (await waitFor(() => cDel.events.some((e) => e.old?.id === C.conversationId))) ? true : `events: ${cDel.events.length}`,
  );
  await check("Delete customer C: guest can no longer read the chat", async () => {
    const { data } = await C.client.from("conversations").select("id").eq("id", C.conversationId).maybeSingle();
    const { data: m } = await C.client.from("messages").select("id").eq("conversation_id", C.conversationId);
    return data === null && m.length === 0;
  });
  await check("Delete customer C: private files removed through the Storage API", async () => {
    const c = await runCleanup(admin);
    const img = await fetchBytes(admin, cImg.attachment_path);
    return c.left === 0 && c.removeErrors.length === 0 && img.error ? true : { cleanup: c, imgStill: !img.error };
  });
  await check("Delete customer C: A and B untouched", async () => {
    const a = await listRow(A);
    const b = await listRow(B);
    return a && b ? true : { a: !!a, b: !!b };
  });
  await C.client.removeChannel(cDel.channel);

  return finish(admin, [A, B]);
}

async function finish(admin, guests) {
  if (admin) {
    console.log("\nRemoving the remaining test customers and their files …");
    for (const g of guests) {
      const r = await admin.rpc("admin_delete_customer", { p_customer_id: g.customerId });
      if (r.error) console.log(`  could not delete ${g.ref}: ${r.error.message}`);
    }
    const c = await runCleanup(admin);
    record("Test data removed (test customers + files)", c.left === 0 && c.removeErrors.length === 0, c.left ? `${c.left} file(s) still queued` : "");
    await admin.auth.signOut();
  }
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("ERROR", e?.message ?? e);
  process.exit(1);
});
