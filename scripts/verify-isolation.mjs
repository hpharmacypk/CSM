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
