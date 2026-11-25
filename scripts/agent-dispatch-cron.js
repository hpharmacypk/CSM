#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports -- plain CommonJS so any Node.js cron runner can execute it */
/**
 * Order-agent bridge: scheduled dispatcher call (run every minute by a cron job).
 *
 *   node scripts/agent-dispatch-cron.js
 *
 * Sends one authenticated POST to the Inbox's /api/agent/dispatch endpoint, which
 * sends every due event to n8n and every due reply notification (Web Push), and
 * retries failed ones. Nothing is sent from here
 * directly; the server decides what is due.
 *
 * Settings (never hard-code secrets):
 *   AGENT_DISPATCH_SECRET  required. Read from the environment, or, if the cron
 *                          environment does not have it, from the app's own
 *                          gitignored env file (.env.production.local, .env.local,
 *                          .env.production or .env next to package.json).
 *   AGENT_DISPATCH_URL     optional. Full endpoint URL. Defaults to the deployed
 *                          Hostinger Inbox below. May also be passed as the first
 *                          command-line argument.
 *
 * Output: one line with the HTTP status and counts only. The secret and any
 * response details beyond counts are never printed.
 * Exit code: 0 = dispatched (or bridge off), 1 = HTTP/network failure, 2 = setup problem.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_URL = "https://rounded-ghostwhite-pigeon-89.hostingersite.com/api/agent/dispatch";
const TIMEOUT_MS = 50_000; // the endpoint stops claiming after ~20 s; stay under a 1-minute schedule
const APP_ROOT = path.resolve(__dirname, "..");
const ENV_FILES = [".env.production.local", ".env.local", ".env.production", ".env"];

/** Reads one KEY from a dotenv-style file without printing or exporting anything else. */
function readFromEnvFile(file, key) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || match[1] !== key) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

function setting(key) {
  const fromEnv = process.env[key];
  if (fromEnv && fromEnv.trim()) return { value: fromEnv.trim(), source: "environment" };
  for (const name of ENV_FILES) {
    const value = readFromEnvFile(path.join(APP_ROOT, name), key);
    if (value && value.trim()) return { value: value.trim(), source: name };
  }
  return { value: "", source: "missing" };
}

function targetUrl() {
  const raw = (process.argv[2] || setting("AGENT_DISPATCH_URL").value || DEFAULT_URL).trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
  return url;
}

/** Keeps only the count fields the endpoint returns; never echoes anything else. */
function summary(body) {
  if (!body || typeof body !== "object") return {};
  const out = {};
  for (const key of ["enabled", "claimed", "sent", "failed", "error"]) {
    if (body[key] !== undefined && typeof body[key] !== "object") out[key] = body[key];
  }
  const counts = (obj) =>
    Object.fromEntries(
      Object.entries(obj).filter(([k, v]) => /^[a-z_]{1,20}$/.test(k) && Number.isFinite(Number(v))),
    );
  const events = body.queue && typeof body.queue === "object" ? body.queue.events : null;
  if (events && typeof events === "object") out.queue = counts(events);
  // Reply notifications (Web Push), processed by the same endpoint.
  if (body.push && typeof body.push === "object") {
    const push = {};
    for (const key of ["enabled", "claimed", "sent", "failed", "removed", "error"]) {
      if (body.push[key] !== undefined && typeof body.push[key] !== "object") push[key] = body.push[key];
    }
    const jobs = body.push.queue && typeof body.push.queue === "object" ? body.push.queue.jobs : null;
    if (jobs && typeof jobs === "object") push.jobs = counts(jobs);
    out.push = push;
  }
  return out;
}

async function main() {
  const stamp = new Date().toISOString();
  const url = targetUrl();
  if (!url) {
    console.error(`${stamp} agent-dispatch: invalid URL (https only, or http://localhost for tests)`);
    return 2;
  }
  const secret = setting("AGENT_DISPATCH_SECRET");
  if (!secret.value) {
    console.error(`${stamp} agent-dispatch: AGENT_DISPATCH_SECRET is not set (environment or app env file)`);
    return 2;
  }

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${secret.value}`, "content-type": "application/json" },
      body: "{}",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error && error.name === "TimeoutError" ? "timeout" : (error && error.name) || "network error";
    console.error(`${stamp} agent-dispatch: ${url.host} request failed (${reason})`);
    return 1;
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const line = `${stamp} agent-dispatch: ${url.host} HTTP ${res.status} ${JSON.stringify(summary(body))} (secret from ${secret.source})`;
  if (res.ok) {
    console.log(line);
    return 0;
  }
  console.error(res.status === 401 ? `${line} - check AGENT_DISPATCH_SECRET matches the app` : line);
  return 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    console.error(`${new Date().toISOString()} agent-dispatch: unexpected error`);
    process.exitCode = 1;
  },
);
