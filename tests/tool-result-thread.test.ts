import assert from "node:assert/strict";
import { test } from "node:test";
import { EventType } from "@ag-ui/core";
import { textOnlyToolResult } from "../apps/server/src/engine/tanstack-agent.ts";

const base = {
  type: EventType.TOOL_CALL_RESULT,
  toolCallId: "call-1",
  messageId: "msg-1",
} as const;

test("malformed multimodal tool JSON is not stored verbatim in the thread", () => {
  const raw = '[{"type":"image","image":"' + "A".repeat(200) + '"}';
  const sanitized = textOnlyToolResult({ ...base, content: raw });
  assert.equal(
    (sanitized as { content?: string }).content,
    "Tool result could not be saved for this thread.",
  );
  assert.ok(!(sanitized as { content?: string }).content?.includes("AAAA"));
});

test("valid multimodal tool results keep only text in the thread", () => {
  const content = JSON.stringify([
    { type: "text", content: "Visible summary" },
    {
      type: "image",
      source: { type: "data", value: "huge-binary", mimeType: "image/jpeg" },
    },
  ]);
  const sanitized = textOnlyToolResult({ ...base, content });
  assert.equal((sanitized as { content?: string }).content, "Visible summary");
});

test("non-array JSON that starts with [ is not left on the thread", () => {
  const sanitized = textOnlyToolResult({ ...base, content: "[1,2,3]" });
  assert.equal(
    (sanitized as { content?: string }).content,
    "Tool result could not be saved for this thread.",
  );
});

test("plain string tool results are unchanged", () => {
  const content = "Done.";
  assert.equal(
    (textOnlyToolResult({ ...base, content }) as { content?: string }).content,
    content,
  );
});
