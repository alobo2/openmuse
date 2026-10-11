import { Hono } from "hono";
import { z } from "zod";
import {
  type ComputerService,
  computerCommandSchema,
  computerPathSchema,
  computerWriteSchema,
} from "./computer.ts";
import { AppError } from "./errors.ts";
import type { Files } from "./files.ts";
import { backgroundFailure } from "./log.ts";

function logComputerApiFailure(phase: string, error: unknown) {
  if (error instanceof z.ZodError) return;
  if (error instanceof AppError) {
    if (error.status === 404 || error.status === 409 || error.status === 413 || error.status === 422)
      return;
  }
  backgroundFailure(phase, error);
}

async function withComputerApiLog<T>(phase: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    logComputerApiFailure(phase, error);
    throw error;
  }
}

export function computerRoutes(computer: ComputerService, files: Files) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/", async (c) => c.json(await computer.snapshot(c.get("owner"))));
  app.post("/start", async (c) =>
    c.json(await withComputerApiLog("computer start", () => computer.start(c.get("owner")))),
  );
  app.post("/stop", async (c) =>
    c.json(await withComputerApiLog("computer stop", () => computer.stop(c.get("owner")))),
  );
  // Live desktop stream (e2b-desktop provider). The URL carries a per-stream VNC
  // password, never the E2B API key; repeated calls return the same stream.
  app.get("/desktop", async (c) =>
    c.json(await withComputerApiLog("computer desktop", () => computer.desktopUrl(c.get("owner")))),
  );
  // The same actions as the agent's use_desktop tool; the response omits the image.
  app.post("/desktop/actions", async (c) => {
    const body = await c.req.json();
    const { receipt, width, height, warning } = await withComputerApiLog(
      "computer desktop action",
      () => computer.desktopAction(c.get("owner"), body),
    );
    return c.json({ receipt, width, height, warning });
  });
  // `?receipt=` names the action whose screenshot the client expects; a newer one is a 404.
  app.get("/desktop/screenshot", async (c) => {
    const { mimeType, bytes } = await withComputerApiLog("computer desktop screenshot", () =>
      computer.latestScreenshot(c.get("owner"), c.req.query("receipt")),
    );
    c.header("Content-Type", mimeType);
    c.header("Cache-Control", "no-store");
    return c.body(new Uint8Array(bytes));
  });
  app.post("/commands", async (c) => {
    const input = computerCommandSchema.parse(await c.req.json());
    return c.json(
      await withComputerApiLog("computer command", () =>
        computer.execute(c.get("owner"), input, { signal: c.req.raw.signal }),
      ),
    );
  });
  app.get("/files", async (c) =>
    c.json(
      await withComputerApiLog("computer files list", () =>
        computer.list(c.get("owner"), c.req.query("path")),
      ),
    ),
  );
  app.post("/files/read", async (c) => {
    const { path } = computerPathSchema.parse(await c.req.json());
    return c.json(
      await withComputerApiLog("computer files read", () => computer.read(c.get("owner"), path)),
    );
  });
  app.post("/files/write", async (c) => {
    const { path, text } = computerWriteSchema.parse(await c.req.json());
    return c.json(
      await withComputerApiLog("computer files write", () => computer.write(c.get("owner"), path, text)),
    );
  });
  app.post("/files/mkdir", async (c) => {
    const { path } = computerPathSchema.parse(await c.req.json());
    return c.json(
      await withComputerApiLog("computer files mkdir", () => computer.mkdir(c.get("owner"), path)),
    );
  });
  app.post("/files/import", async (c) => {
    const { path, fileId } = computerPathSchema
      .extend({ fileId: z.string().min(1) })
      .parse(await c.req.json());
    return c.json(
      await withComputerApiLog("computer files import", async () =>
        computer.writePdf(c.get("owner"), path, await files.bytes(c.get("owner"), fileId)),
      ),
    );
  });
  app.post("/files/export", async (c) => {
    const { path } = computerPathSchema.parse(await c.req.json());
    const { name, bytes } = await withComputerApiLog("computer files export", () =>
      computer.pdfBytes(c.get("owner"), path),
    );
    return c.json(await files.import(c.get("owner"), name, bytes, `Computer: ${path}`), 201);
  });
  return app;
}
