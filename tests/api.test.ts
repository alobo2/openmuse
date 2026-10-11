import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { EventType } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import { createApp } from "../apps/server/src/app.ts";
import { Auth } from "../apps/server/src/auth.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import type { AgentService } from "../apps/server/src/engine/service.ts";
import { deterministicFileId, Files } from "../apps/server/src/files.ts";
import type { ActionProposal, Artifact, Workspace } from "../packages/domain/src/index.ts";
import { createSamplePdf } from "../packages/integrations/src/pdf.ts";
import { browserFixture } from "./helpers/browser.ts";
import { modelFixture } from "./helpers/model.ts";

let db: Store,
  app: Awaited<ReturnType<typeof createApp>>["app"],
  agent: AgentService,
  config: Config,
  token: string,
  directory: string;
const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-api-"));
  db = await createStore();
  config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  };
  ({ app, agent } = await createApp(db, config));
  const response = await app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  token = (await response.json()).token;
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("API protects private data and rejects unrelated web origins", async () => {
  assert.equal((await app.request("/api/workspace")).status, 401);
  assert.equal(
    (
      await app.request("/api/workspace", {
        headers: { ...headers(), Origin: "https://unrelated.example" },
      })
    ).status,
    403,
  );
});
test("file operations recover a published PDF when metadata persistence fails", async (t) => {
  const owner = "file-recovery";
  const bytes = await createSamplePdf();
  const insert = db.insertIfAbsent.bind(db);
  let publishedId = "";
  t.mock.method(db, "insertIfAbsent", async (...args: Parameters<Store["insertIfAbsent"]>) => {
    if (args[0] === owner && args[1] === "files" && !publishedId) {
      publishedId = args[2].id;
      throw new Error("metadata unavailable");
    }
    return insert(...args);
  });
  await assert.rejects(
    agent.files.import(owner, "sample.pdf", bytes, "fixture", undefined, "import-once"),
    /metadata unavailable/,
  );
  assert.ok(publishedId);
  assert.equal((await agent.files.list(owner)).length, 0);
  const restarted = new Files(db, config, new Auth(db, config, "sample-signing-key"));
  const recovered = await restarted.import(
    owner,
    "sample.pdf",
    bytes,
    "fixture",
    undefined,
    "import-once",
  );
  assert.equal(recovered.id, publishedId);
  assert.deepEqual(new Uint8Array(await restarted.bytes(owner, recovered.id)), bytes);
  assert.equal((await restarted.list(owner)).length, 1);
});

test("file operation identity isolates owners, inputs and independent requests", async () => {
  const owner = "file-identities";
  const bytes = await createSamplePdf();
  const source = await agent.files.import(owner, "sample.pdf", bytes, "fixture");
  const fields = { participant_name: "Sample Student", permission_granted: true };
  const [first, concurrent] = await Promise.all([
    agent.files.fill(owner, source.id, fields, "task-fill"),
    agent.files.fill(owner, source.id, fields, "task-fill"),
  ]);
  assert.equal(first.id, concurrent.id);
  assert.equal(first.createdAt, concurrent.createdAt);
  assert.equal((await agent.files.list(owner)).filter((file) => file.parentId).length, 1);
  const reordered = await agent.files.fill(
    owner,
    source.id,
    {
      permission_granted: true,
      participant_name: "Sample Student",
    },
    "task-fill",
  );
  assert.equal(reordered.id, first.id);
  assert.notEqual((await agent.files.fill(owner, source.id, fields, "another-task")).id, first.id);
  assert.notEqual(
    (await agent.files.fill(owner, source.id, { participant_name: "Another Student" }, "task-fill"))
      .id,
    first.id,
  );
  const manual = await agent.files.fill(owner, source.id, fields);
  assert.notEqual((await agent.files.fill(owner, source.id, fields)).id, manual.id);
  const otherOwner = await agent.files.import(
    "other-file-owner",
    "sample.pdf",
    bytes,
    "fixture",
    undefined,
    "owner-scoped",
  );
  assert.notEqual(
    (await agent.files.import(owner, "sample.pdf", bytes, "fixture", undefined, "owner-scoped")).id,
    otherOwner.id,
  );
});

test("keyed file IDs are UUIDs that work through lookup, content reads and attachments", async () => {
  const owner = "local-user";
  const sample = await createSamplePdf();
  const source = await agent.files.import(owner, "form.pdf", sample, "test");
  const fields = { participant_name: "Sample Student", permission_granted: true };
  const filled = await agent.files.fill(owner, source.id, fields, "task-1:fill_pdf");
  const imported = await agent.files.import(
    owner,
    "a.pdf",
    sample,
    "test",
    undefined,
    "attachment:1",
  );
  assert.equal((await agent.files.fill(owner, source.id, fields, "task-1:fill_pdf")).id, filled.id);
  for (const id of [filled.id, imported.id]) {
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal((await agent.files.get(owner, id)).id, id);
    const content = await app.request(`/api/files/${id}/content`, { headers: headers() });
    assert.equal(content.status, 200);
    assert.equal(
      Buffer.from(await content.arrayBuffer())
        .subarray(0, 5)
        .toString(),
      "%PDF-",
    );
    const proposal = await app.request("/api/actions", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        kind: "email.send",
        data: {
          to: ["sample@example.com"],
          subject: "Attached",
          body: "See attached.",
          attachmentIds: [id],
        },
      }),
    });
    assert.equal(proposal.status, 201);
  }
  assert.equal(deterministicFileId(owner, "x"), deterministicFileId(owner, "x"));
  assert.notEqual(deterministicFileId(owner, "x"), deterministicFileId("other", "x"));
});

test("sample workspace serves a real PDF and filling creates a new version", async () => {
  const response = await app.request("/api/workspace", { headers: headers() });
  assert.equal(response.status, 200);
  const workspace: Workspace = await response.json();
  assert.equal(workspace.mode, "sample");
  assert.equal(workspace.mail.length, 4);
  const original = workspace.files[0];
  assert.equal(original.pageCount, 2);
  const signed = await app.request(original.url);
  assert.equal(signed.headers.get("content-type"), "application/pdf");
  const bytes = new Uint8Array(await signed.arrayBuffer());
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
  const fill = await app.request(`/api/files/${original.id}/fill`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      fields: { participant_name: "Sample Student", permission_granted: true },
    }),
  });
  assert.equal(fill.status, 201);
  const output: Artifact = await fill.json();
  assert.notEqual(output.id, original.id);
  assert.equal(output.parentId, original.id);
  assert.equal(output.fields?.find((f) => f.name === "participant_name")?.value, "Sample Student");
  const unchanged = await app.request(original.url);
  assert.deepEqual(new Uint8Array(await unchanged.arrayBuffer()), bytes);
  const forged = new URL(original.url);
  forged.searchParams.set("owner", "another-user");
  assert.equal((await app.request(forged.toString())).status, 403);
});
test("reviewed sample email persists a receipt, then revocation blocks another proposal", async () => {
  const propose = () =>
    app.request("/api/actions", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        kind: "email.send",
        data: {
          to: ["sample@example.com"],
          subject: "Permission slip",
          body: "Here is the sample form.",
        },
      }),
    });
  const proposal: ActionProposal = await (await propose()).json();
  assert.equal(proposal.status, "awaiting_review");
  const denied = await app.request(`/api/actions/${proposal.id}/decide`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ hash: proposal.hash, decision: "deny" }),
  });
  assert.equal((await denied.json()).status, "denied");
  const approved: ActionProposal = await (await propose()).json();
  const result = await app.request(`/api/actions/${approved.id}/decide`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ hash: approved.hash, decision: "approve" }),
  });
  const saved: ActionProposal = await result.json();
  assert.equal(saved.status, "succeeded");
  assert.match(saved.result ?? "", /local sent mail/);
  const pending: ActionProposal = await (await propose()).json();
  await app.request("/api/google/disconnect", { method: "POST", headers: headers(), body: "{}" });
  const revoked = await app.request(`/api/actions/${pending.id}/decide`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ hash: pending.hash, decision: "approve" }),
  });
  assert.equal(revoked.status, 409);
});
test("missing browser setup is explicit rather than a fictional browser session", async () => {
  const response = await app.request("/api/browsers", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ url: "https://example.com" }),
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /not configured/);
});
test("calendar ranges and complete sample mail threads survive navigation", async () => {
  await app.request("/api/google/connect", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ capability: "read" }),
  });
  const calendars = await app.request("/api/calendars", { headers: headers() });
  assert.equal((await calendars.json())[0].id, "primary");
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  const next = new Date(tomorrow.getTime() + 86400000);
  const range = new URLSearchParams({
    timeMin: tomorrow.toISOString(),
    timeMax: next.toISOString(),
    calendarId: "primary",
  });
  const events = await app.request(`/api/calendar/events?${range}`, { headers: headers() });
  assert.equal(events.status, 200);
  assert.deepEqual(await events.json(), []);
  const thread = await app.request("/api/mail/threads/trip-thread", { headers: headers() });
  assert.equal(thread.status, 200);
  assert.equal((await thread.json())[0].id, "mail-fieldtrip");
  const invalid = await app.request(
    "/api/calendar/events?timeMin=2026-09-20T00:00:00Z&timeMax=2026-09-19T00:00:00Z",
    { headers: headers() },
  );
  assert.equal(invalid.status, 422);
});
function sampleRun(threadId: string, runId: string, messageId: string, content: string) {
  return new ConversationAgent(config, agent, "local-user").run({
    threadId,
    runId,
    messages: [{ id: messageId, role: "user", content }],
    tools: [],
    context: [],
    state: {},
  });
}

test("chat create_goal logs store failures before returning a tool error", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const failure = "Goal store unavailable";
  await modelFixture(t, (index) =>
    index === 0
      ? {
          name: "create_goal",
          arguments: { title: "Train for a 5K", description: "By summer" },
        }
      : undefined,
  );
  const browser = await browserFixture(t, () => ({ data: { ok: true } }));
  const modelConfig = {
    ...browser.config,
    agentBackend: "model" as const,
    model: "openai/fixture",
  };
  const { agent: modelAgent } = await createApp(browser.db, modelConfig);
  t.after(() => modelAgent.stop());
  const original = modelAgent.createGoal.bind(modelAgent);
  modelAgent.createGoal = async () => {
    throw new Error(failure);
  };
  t.after(() => {
    modelAgent.createGoal = original;
  });
  const conversation = new ConversationAgent(modelConfig, modelAgent, "local-user");
  const events = await lastValueFrom(
    conversation
      .run({
        threadId: "create-goal-error",
        runId: "create-goal-error-run",
        messages: [{ id: "create-goal-error-msg", role: "user", content: "Add a goal" }],
        tools: [],
        context: [],
        state: {},
      })
      .pipe(toArray()),
  );
  const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT);
  assert.ok(result && result.type === EventType.TOOL_CALL_RESULT);
  assert.deepEqual(JSON.parse(result.content), { error: failure });
  assert.ok(
    logged.mock.calls.some(
      (call) =>
        typeof call.arguments[0] === "object" &&
        call.arguments[0] !== null &&
        (call.arguments[0] as { context?: { phase?: string } }).context?.phase ===
          "chat create goal",
    ),
    "chat create goal should log goal persistence failures",
  );
});

test("chat agent_status logs store failures before returning a tool error", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const failure = "Workspace snapshot unavailable";
  await modelFixture(t, (index) =>
    index === 0 ? { name: "agent_status", arguments: {} } : undefined,
  );
  const browser = await browserFixture(t, () => ({ data: { ok: true } }));
  const modelConfig = {
    ...browser.config,
    agentBackend: "model" as const,
    model: "openai/fixture",
  };
  const { agent: modelAgent } = await createApp(browser.db, modelConfig);
  t.after(() => modelAgent.stop());
  const original = modelAgent.snapshot.bind(modelAgent);
  modelAgent.snapshot = async () => {
    throw new Error(failure);
  };
  t.after(() => {
    modelAgent.snapshot = original;
  });
  const conversation = new ConversationAgent(modelConfig, modelAgent, "local-user");
  const events = await lastValueFrom(
    conversation
      .run({
        threadId: "agent-status-error",
        runId: "agent-status-error-run",
        messages: [{ id: "agent-status-error-msg", role: "user", content: "What is going on?" }],
        tools: [],
        context: [],
        state: {},
      })
      .pipe(toArray()),
  );
  const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT);
  assert.ok(result && result.type === EventType.TOOL_CALL_RESULT);
  assert.deepEqual(JSON.parse(result.content), { error: failure });
  assert.ok(
    logged.mock.calls.some(
      (call) =>
        typeof call.arguments[0] === "object" &&
        call.arguments[0] !== null &&
        (call.arguments[0] as { context?: { phase?: string } }).context?.phase ===
          "chat agent status",
    ),
    "chat agent status should log workspace snapshot failures",
  );
});

test("chat remember_fact logs store failures before returning a tool error", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const failure = "Memory store unavailable";
  await modelFixture(t, (index) =>
    index === 0
      ? { name: "remember_fact", arguments: { text: "I prefer morning meetings" } }
      : undefined,
  );
  const browser = await browserFixture(t, () => ({ data: { ok: true } }));
  const modelConfig = {
    ...browser.config,
    agentBackend: "model" as const,
    model: "openai/fixture",
  };
  const { agent: modelAgent } = await createApp(browser.db, modelConfig);
  t.after(() => modelAgent.stop());
  const original = modelAgent.db.insertIfAbsent.bind(modelAgent.db);
  modelAgent.db.insertIfAbsent = async (...args: Parameters<Store["insertIfAbsent"]>) => {
    if (args[1] === "memories") throw new Error(failure);
    return original(...args);
  };
  t.after(() => {
    modelAgent.db.insertIfAbsent = original;
  });
  const conversation = new ConversationAgent(modelConfig, modelAgent, "local-user");
  const events = await lastValueFrom(
    conversation
      .run({
        threadId: "remember-fact-error",
        runId: "remember-fact-error-run",
        messages: [
          { id: "remember-fact-error-msg", role: "user", content: "Remember that preference" },
        ],
        tools: [],
        context: [],
        state: {},
      })
      .pipe(toArray()),
  );
  const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT);
  assert.ok(result && result.type === EventType.TOOL_CALL_RESULT);
  assert.deepEqual(JSON.parse(result.content), { error: failure });
  assert.ok(
    logged.mock.calls.some(
      (call) =>
        typeof call.arguments[0] === "object" &&
        call.arguments[0] !== null &&
        (call.arguments[0] as { context?: { phase?: string } }).context?.phase ===
          "chat remember fact",
    ),
    "chat remember fact should log memory persistence failures",
  );
});

test("chat watch_page logs store failures before returning a tool error", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const failure = "Monitor store unavailable";
  await modelFixture(t, (index) =>
    index === 0
      ? {
          name: "watch_page",
          arguments: {
            title: "Example page",
            url: "https://example.com",
            condition: "change",
          },
        }
      : undefined,
  );
  const browser = await browserFixture(t, () => ({ data: { ok: true } }));
  const modelConfig = {
    ...browser.config,
    agentBackend: "model" as const,
    model: "openai/fixture",
  };
  const { agent: modelAgent } = await createApp(browser.db, modelConfig);
  t.after(() => modelAgent.stop());
  const original = modelAgent.createMonitor.bind(modelAgent);
  modelAgent.createMonitor = async () => {
    throw new Error(failure);
  };
  t.after(() => {
    modelAgent.createMonitor = original;
  });
  const conversation = new ConversationAgent(modelConfig, modelAgent, "local-user");
  const events = await lastValueFrom(
    conversation
      .run({
        threadId: "watch-page-error",
        runId: "watch-page-error-run",
        messages: [{ id: "watch-page-error-msg", role: "user", content: "Watch that page" }],
        tools: [],
        context: [],
        state: {},
      })
      .pipe(toArray()),
  );
  const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT);
  assert.ok(result && result.type === EventType.TOOL_CALL_RESULT);
  assert.deepEqual(JSON.parse(result.content), { error: failure });
  assert.ok(
    logged.mock.calls.some(
      (call) =>
        typeof call.arguments[0] === "object" &&
        call.arguments[0] !== null &&
        (call.arguments[0] as { context?: { phase?: string } }).context?.phase ===
          "chat watch page",
    ),
    "chat watch page should log monitor persistence failures",
  );
});

test("chat delegate_task logs store failures before returning a tool error", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const failure = "Task store unavailable";
  await modelFixture(t, (index) =>
    index === 0
      ? {
          name: "delegate_task",
          arguments: { prompt: "Organize my receipts", kind: "agent" },
        }
      : undefined,
  );
  const browser = await browserFixture(t, () => ({ data: { ok: true } }));
  const modelConfig = {
    ...browser.config,
    agentBackend: "model" as const,
    model: "openai/fixture",
  };
  const { agent: modelAgent } = await createApp(browser.db, modelConfig);
  t.after(() => modelAgent.stop());
  const original = modelAgent.createTask.bind(modelAgent);
  modelAgent.createTask = async () => {
    throw new Error(failure);
  };
  t.after(() => {
    modelAgent.createTask = original;
  });
  const conversation = new ConversationAgent(modelConfig, modelAgent, "local-user");
  const events = await lastValueFrom(
    conversation
      .run({
        threadId: "delegate-task-error",
        runId: "delegate-task-error-run",
        messages: [{ id: "delegate-task-error-msg", role: "user", content: "Delegate this" }],
        tools: [],
        context: [],
        state: {},
      })
      .pipe(toArray()),
  );
  const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT);
  assert.ok(result && result.type === EventType.TOOL_CALL_RESULT);
  assert.deepEqual(JSON.parse(result.content), { error: failure });
  assert.ok(
    logged.mock.calls.some(
      (call) =>
        typeof call.arguments[0] === "object" &&
        call.arguments[0] !== null &&
        (call.arguments[0] as { context?: { phase?: string } }).context?.phase ===
          "chat delegate task",
    ),
    "chat delegate task should log delegation failures",
  );
});

test("model chat failures are logged before the run error", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  await modelFixture(t, () => undefined, { errorStatus: () => 400 });
  const browser = await browserFixture(t, () => ({ data: { ok: true } }));
  const modelConfig = {
    ...browser.config,
    agentBackend: "model" as const,
    model: "openai/fixture",
  };
  const { agent: modelAgent } = await createApp(browser.db, modelConfig);
  t.after(() => modelAgent.stop());
  const conversation = new ConversationAgent(modelConfig, modelAgent, "local-user");
  let events: Array<{ type: string }> = [];
  try {
    events = await lastValueFrom(
      conversation
        .run({
          threadId: "model-error",
          runId: "model-error-run",
          messages: [{ id: "model-error-msg", role: "user", content: "Hello" }],
          tools: [],
          context: [],
          state: {},
        })
        .pipe(toArray()),
    );
  } catch (error) {
    assert.match(String(error), /Fixture provider failure/);
  }
  if (events.length)
    assert.equal(events.at(-1)?.type, EventType.RUN_ERROR, "completed runs should end in RUN_ERROR");
  assert.ok(
    logged.mock.calls.some(
      (call) =>
        typeof call.arguments[0] === "object" &&
        call.arguments[0] !== null &&
        (call.arguments[0] as { context?: { phase?: string } }).context?.phase === "model chat",
    ),
    "model chat should log the underlying provider failure",
  );
});

test("sample chat failures are logged before the run error", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const original = agent.workspace.snapshot;
  agent.workspace.snapshot = async () => {
    throw new Error("sample snapshot failed");
  };
  t.after(() => {
    agent.workspace.snapshot = original;
  });
  const events = await lastValueFrom(
    sampleRun("sample-error", "sample-error-run", "sample-error-msg", "Show my calendar").pipe(
      toArray(),
    ),
  );
  assert.equal(events.at(-1)?.type, EventType.RUN_ERROR);
  assert.ok(
    logged.mock.calls.some(
      (call) =>
        typeof call.arguments[0] === "object" &&
        call.arguments[0] !== null &&
        (call.arguments[0] as { context?: { phase?: string } }).context?.phase === "sample chat",
    ),
    "sample chat should log the underlying failure",
  );
});

test("sample agent streams actual AG-UI events without a model key", async () => {
  const info = await app.request("/api/copilotkit/info", { headers: headers() });
  assert.equal(info.status, 200);
  const stream = JSON.stringify(
    await lastValueFrom(
      sampleRun("sample-test", "sample-run", "message1", "Show my calendar").pipe(toArray()),
    ),
  );
  assert.match(stream, /RUN_STARTED/);
  assert.match(stream, /TEXT_MESSAGE_CONTENT/);
  assert.match(stream, /RUN_FINISHED/);
  assert.match(stream, /Your local calendar has/);
});

test("guided document delegation streams a rich tool result bound to its saved task", async () => {
  const events = await lastValueFrom(
    sampleRun(
      "document-thread",
      "document-run",
      "document-request",
      "Complete the permission slip",
    ).pipe(toArray()),
  );
  const start = events.find((event) => event.type === EventType.TOOL_CALL_START);
  const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT);
  assert.equal(start?.toolCallName, "delegate_task");
  assert.equal(result?.toolCallId, start?.toolCallId);
  assert.ok(result && typeof result.content === "string");
  const { id } = JSON.parse(result.content);
  const task = await db.get<{ input: { messageId: string }; kind: string }>(
    "local-user",
    "tasks",
    id,
  );
  assert.equal(task?.kind, "document");
  assert.equal(task?.input.messageId, "mail-fieldtrip");
});
