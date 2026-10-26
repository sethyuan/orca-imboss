/**
 * Headless equivalence harness for the remote backend.
 *
 * Two questions it answers, both without a GUI and without a model:
 *
 * 1. **handlers** — does the gRPC transport return exactly what the in-process
 *    handler returns? The same `registerRemoteHandlers` table is served twice:
 *    once called directly (the reference, i.e. what Electron IPC would return)
 *    and once through a real gRPC server + the real `RemoteClient`. Every read
 *    channel's result is deep-compared. This is where a JSON-envelope fidelity
 *    bug (a `Date`, an `undefined` field, a `Map`) shows up as a diff instead of
 *    as a mystery in the UI.
 * 2. **events** — does the event pump do what it claims? Coalescing, monotonic
 *    `seq`, replay after a reconnect, `dropped` on backpressure, and
 *    `server:resync` when the gap cannot be filled.
 *
 * Run it through `scripts/tests/run-equivalence.ts` (it must be bundled: the
 * app sources use extensionless ESM imports and the `@shared` alias).
 *
 * Exit code 0 = every check passed.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as grpc from "@grpc/grpc-js";
import protobuf from "protobufjs";
import { materializeBuiltinSkills } from "../../src/main/agent/builtin-skills";
import { initDatabase } from "../../src/main/db";
import { appendMessage } from "../../src/main/db/messages";
import { sweepTransferTempRoot } from "../../src/main/file-browser";
import { registerRemoteHandlers } from "../../src/main/ipc";
import { initLocale } from "../../src/main/locale";
import { createMapBinder } from "../../src/main/rpc/binders";
import {
  sendToRenderer,
  setEventBroadcaster,
} from "../../src/main/rpc/broadcast";
import { RemoteClient } from "../../src/main/rpc/grpc-client";
import type {
  CallContext,
  Handler,
  Subscriber,
} from "../../src/main/rpc/types";
import { startRpcServer } from "../../src/main/server/rpc-server";
import { subscribers } from "../../src/main/server/subscribers";
import { APP_VERSION } from "../../src/main/version";
import protoSource from "../../src/main/rpc/imboss.proto?raw";
import { isPreviewableImagePath } from "../../src/shared/image-attachments";

const TOKEN = "equivalence-harness-token-0123456789";

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail?: string): void {
  checks += 1;
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? ` — ${detail}` : ""}`,
  );
}

/** A subscriber that records nothing (the reference path never pushes). */
const nullSubscriber: Subscriber = {
  id: "harness-null",
  alive: true,
  send: () => {
    /* reference path: pushes are irrelevant */
  },
  onClose: () => () => {
    /* nothing registered */
  },
};

function referenceContext(): CallContext {
  return { subscriber: nullSubscriber };
}

async function main(): Promise<void> {
  const suite = readSuite();
  const dataRoot = mkdtempSync(join(tmpdir(), "imboss-equivalence-"));
  process.env["IMBOSS_DATA_ROOT"] = dataRoot;

  try {
    const handlers = new Map<string, Handler>();
    registerRemoteHandlers(createMapBinder(handlers));
    initDatabase();
    initLocale();
    materializeBuiltinSkills();

    // Event pushes from business code must reach the registry (this is what
    // `server/bootstrap.ts` installs).
    setEventBroadcaster((channel, payload) => {
      subscribers.broadcast(channel, payload, payload !== undefined);
    });

    await seed(handlers);

    const server = await startRpcServer({
      config: { listen: "127.0.0.1:0", token: TOKEN, dataRoot, tls: null },
      handlers,
      channels: [...handlers.keys()].sort(),
    });

    try {
      if (suite === "all" || suite === "handlers") {
        await runHandlersSuite(handlers, server.address);
      }
      if (suite === "all" || suite === "events") {
        await runEventsSuite(server.address);
      }
      if (suite === "all" || suite === "transfer") {
        await runTransferSuite(handlers, server.address, dataRoot);
      }
    } finally {
      await server.close();
    }
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }

  console.log(
    failures === 0
      ? `\nall ${checks} checks passed`
      : `\n${failures} of ${checks} checks FAILED`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

function readSuite(): "all" | "handlers" | "events" | "transfer" {
  const value = process.argv[process.argv.indexOf("--suite") + 1];
  if (process.argv.includes("--suite")) {
    if (
      value === "handlers" ||
      value === "events" ||
      value === "transfer" ||
      value === "all"
    ) {
      return value;
    }
    throw new Error(`unknown --suite value: ${value}`);
  }
  return "all";
}

/** A small, deterministic dataset so the read channels have something to show. */
async function seed(handlers: Map<string, Handler>): Promise<void> {
  const call = async (
    channel: string,
    ...args: unknown[]
  ): Promise<unknown> => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`missing handler ${channel}`);
    return await handler(referenceContext(), ...args);
  };

  await call("employees:create", {
    name: "Harness Employee",
    role: "tester",
    systemPrompt: "You are a test employee.",
    skills: [],
    mcp: [],
  });
  const chat = (await call("chats:create", "Harness chat", [0])) as {
    id: number;
  };
  await call("messages:append", chat.id, null, "hello from the harness");
  await call("messages:append", chat.id, 0, "reply from the harness");
  await call("chats:setTags", chat.id, ["harness", "equivalence"]);
  await call("chats:setPinned", chat.id, true);
  await call("settings:set", "harness.key", "harness value");
}

/**
 * Read channels compared across both transports. Deliberately excludes:
 * - anything hitting the network (`providers:listModels`, `models:list`),
 * - anything time- or fs-mtime-dependent (`updater:*`, avatars),
 * - channels that are local-only by design.
 */
const READ_CASES: { channel: string; args: unknown[] }[] = [
  { channel: "chats:list", args: [] },
  { channel: "chats:summaries", args: [] },
  { channel: "chats:summariesPage", args: [{ limit: 50 }] },
  { channel: "tags:list", args: [] },
  { channel: "projects:list", args: [] },
  { channel: "employees:list", args: [] },
  { channel: "employees:listPage", args: [{ limit: 50 }] },
  { channel: "providers:list", args: [] },
  { channel: "providers:listPage", args: [{ limit: 50 }] },
  { channel: "skills:list", args: [] },
  { channel: "skills:listPage", args: [{ limit: 50 }] },
  { channel: "mcp:list", args: [] },
  { channel: "miniapps:list", args: [] },
  { channel: "cron:listAll", args: [] },
  { channel: "cron:listByEmployee", args: [0] },
  { channel: "settings:get", args: ["harness.key"] },
  { channel: "settings:get", args: ["harness.missing"] },
  { channel: "theme:get", args: [] },
  { channel: "workdir:get", args: [] },
  { channel: "network:getProxy", args: [] },
  { channel: "sessions:entries", args: [0, 1] },
  { channel: "sessions:get", args: [0, 1] },
  { channel: "messages:search", args: ["harness"] },
  { channel: "messages:list", args: [1] },
  { channel: "chats:summary", args: [1] },
  { channel: "chats:rootId", args: [1] },
  { channel: "spend:report", args: ["all"] },
];

async function runHandlersSuite(
  handlers: Map<string, Handler>,
  address: string,
): Promise<void> {
  console.log("\n--- handlers: in-process vs gRPC ---");
  const client = new RemoteClient({
    target: address,
    token: TOKEN,
    clientId: randomUUID(),
    appVersion: APP_VERSION,
  });

  try {
    const info = await client.info();
    check(
      "the backend serves every registered channel",
      info.channels.length === handlers.size,
      `${info.channels.length} vs ${handlers.size}`,
    );

    for (const testCase of READ_CASES) {
      const handler = handlers.get(testCase.channel);
      if (!handler) {
        check(`${testCase.channel} registered`, false);
        continue;
      }
      let reference: unknown;
      let remote: unknown;
      try {
        reference = await handler(referenceContext(), ...testCase.args);
      } catch (error) {
        check(`${testCase.channel} responds in-process`, false, message(error));
        continue;
      }
      try {
        remote = await client.invoke(testCase.channel, testCase.args);
      } catch (error) {
        check(`${testCase.channel} responds over gRPC`, false, message(error));
        continue;
      }
      const diff = firstDifference(reference, remote);
      check(
        `${testCase.channel}(${describeArgs(testCase.args)}) matches`,
        diff === null,
        diff ?? summarize(reference),
      );
    }
  } finally {
    client.close();
  }
}

async function runEventsSuite(address: string): Promise<void> {
  console.log("\n--- events: coalescing, sequence, replay, resync ---");

  const clientId = randomUUID();
  const first = await connectEvents(address, clientId, 0);

  // 1. Coalescing + contiguous sequence for streamed deltas.
  const deltaCount = 240;
  for (let index = 0; index < deltaCount; index += 1) {
    pushDelta(0);
  }
  await sleep(200);
  const deltaEvents = first.events.filter(
    (event) => event.channel === "agentSession:event",
  );
  const coalescedText = deltaEvents
    .map(
      (event) =>
        (event.payload as { event?: { delta?: string } })?.event?.delta ?? "",
    )
    .join("");
  check(
    "streamed deltas are coalesced",
    deltaEvents.length > 0 && deltaEvents.length < deltaCount / 2,
    `${deltaCount} pushes → ${deltaEvents.length} events`,
  );
  check(
    "coalescing loses no text",
    coalescedText.length === deltaCount,
    `${coalescedText.length} chars`,
  );
  check(
    "sequence numbers are contiguous",
    isContiguous(first.events),
    first.events.map((event) => event.seq).join(","),
  );

  // 2. Reconnect resumes: events pushed while detached are replayed.
  const lastSeq = first.events.at(-1)?.seq ?? 0;
  await first.close();
  await waitForDetach();
  pushBroadcast("chats:changed", { chatId: 1 });
  pushBroadcast("chats:changed", { chatId: 2 });
  pushBroadcast("chats:deleted", { chatIds: [2] });

  const second = await connectEvents(address, clientId, lastSeq);
  await sleep(200);
  check(
    "reconnect replays what was missed",
    second.events.filter((event) => event.channel === "chats:changed")
      .length === 2 &&
      second.events.some((event) => event.channel === "chats:deleted"),
    `${second.events.length} replayed`,
  );
  check(
    "replayed events continue the sequence",
    isContiguous([...first.events, ...second.events]),
  );
  check("replay reports no resync", second.resyncReason === null);
  await second.close();

  // 3. Backpressure: a burst of non-mergeable events must report `dropped`.
  const third = await connectEvents(address, clientId, second.lastSeq);
  for (let index = 0; index < 1200; index += 1) {
    // Distinct coalesce keys (contentIndex) → 1200 distinct events in one tick.
    pushDelta(index);
  }
  await sleep(300);
  const dropped = third.events.reduce(
    (total, event) => total + event.dropped,
    0,
  );
  check(
    "backpressure drops deltas and reports it",
    dropped > 0,
    `${dropped} dropped of 1200 pushed`,
  );
  check("dropped events clear the queue", third.events.length > 0);
  const lastAfterBurst = third.lastSeq;
  await third.close();
  await waitForDetach();
  // One more event so the resync must report a position the client does not
  // have (its own resume point is far behind).
  pushBroadcast("chats:changed", { chatId: 3 });
  await sleep(120);

  // 4. History lost: while detached, more events arrive than the ring buffer
  //    holds, so the oldest resume point can no longer be filled.
  for (let index = 0; index < 1300; index += 1) pushDelta(index);
  const fourth = await connectEvents(address, clientId, 1);
  await sleep(200);
  check(
    "an unfillable gap asks the client to resync",
    fourth.resyncReason === "history-lost",
    fourth.resyncReason ?? "no resync received",
  );
  check(
    "the resync carries the current position",
    fourth.lastSeq > lastAfterBurst,
    `lastSeq=${fourth.lastSeq}`,
  );
  await fourth.close();
  await waitForDetach();

  // 5. A resume point ahead of the backend's history means the backend restarted
  //    (its sequence started over) — also a resync, not a silent hole.
  const fifth = await connectEvents(address, clientId, 999_999);
  await sleep(200);
  check(
    "a resume point from a previous backend instance also resyncs",
    fifth.resyncReason === "server-restarted",
    fifth.resyncReason ?? "no resync received",
  );
  await fifth.close();
}

/**
 * File transfer: the closed loop P2 is judged by.
 *
 * Upload a "picked local file" → the attachment carries a backend path whose
 * bytes are exactly what was sent → download it back → same bytes. Then the
 * guards: what may not be downloaded, what may not be uploaded.
 */
async function runTransferSuite(
  handlers: Map<string, Handler>,
  address: string,
  dataRoot: string,
): Promise<void> {
  console.log("\n--- transfer: upload, download, guards ---");
  const client = new RemoteClient({
    target: address,
    token: TOKEN,
    clientId: randomUUID(),
    appVersion: APP_VERSION,
  });

  try {
    // A deliberately binary payload (every byte value, incl. NUL) so a text-ish
    // encode/decode slip cannot pass.
    const payload = Buffer.alloc(64 * 1024);
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = index % 256;
    }

    const attached = (await client.upload(
      "files:uploadAttachment",
      [1, "report.pdf", "application/pdf"],
      payload,
      "report.pdf",
    )) as { name?: string; size?: number; type?: string; path?: string };

    check(
      "upload returns the user's own name",
      attached.name === "report.pdf",
      String(attached.name),
    );
    check(
      "upload returns the byte size",
      attached.size === payload.length,
      `${attached.size} vs ${payload.length}`,
    );
    check(
      "upload returns a backend path inside the data folder",
      typeof attached.path === "string" &&
        attached.path.startsWith(dataRoot) &&
        attached.path.includes("upload-"),
      String(attached.path),
    );

    if (typeof attached.path === "string") {
      const roundTrip = await readDownload(client, attached.path);
      check(
        "download returns the exact bytes",
        roundTrip.equals(payload),
        `${roundTrip.length} bytes`,
      );
    }

    // Regression guard for a real bug found here: a failed server-streaming call
    // used to hang the client forever (grpc-js never sends the trailing status
    // after `destroy()`). A raw gRPC client — no app code involved — must see the
    // status promptly.
    const rawMissing = await rawMissingDownloadStatus(
      address,
      join(tmpdir(), "nope-not-here.png"),
    );
    check(
      "a failed download reports its status instead of hanging",
      rawMissing === grpc.status.NOT_FOUND,
      String(rawMissing),
    );

    // `imb-file:` only ever asks for previewable images; a PDF is not one, so the
    // protocol gate refuses it before the backend is bothered.
    check(
      "the imb-file path gate rejects non-images",
      !isPreviewableImagePath("/tmp/report.pdf"),
    );

    // Download guard: a file outside the data folder that is not an image.
    const outside = join(tmpdir(), `imboss-outside-${randomUUID()}.txt`);
    writeFileSync(outside, "should not be readable");
    const denied = await tryDownload(client, outside);
    check(
      "downloading an unrelated file is refused",
      "error" in denied &&
        errorCode(denied.error) === grpc.status.PERMISSION_DENIED,
      "error" in denied ? describeError(denied.error) : "no error",
    );
    rmSync(outside, { force: true });

    const missing = await tryDownload(client, join(dataRoot, "nope.png"));
    check(
      "downloading a missing file reports NOT_FOUND",
      "error" in missing && errorCode(missing.error) === grpc.status.NOT_FOUND,
      "error" in missing ? describeError(missing.error) : "no error",
    );

    // A lying metadata size must be stopped before the data arrives.
    const oversized = await expectGrpcError(() =>
      claimOversizedUpload(address),
    );
    check(
      "an oversized upload is refused up front",
      oversized?.code === grpc.status.RESOURCE_EXHAUSTED,
      oversized ? describeStatus(oversized) : "no error",
    );

    // Path browser.
    const listing = (await client.invoke("files:listDir", [dataRoot])) as {
      path?: string;
      entries?: { name: string; path: string }[];
      roots?: unknown[];
    };
    check(
      "files:listDir lists the data folder",
      listing.path === dataRoot && Array.isArray(listing.entries),
      `${listing.entries?.length ?? 0} entries`,
    );
    const roots = (await client.invoke("files:listDir", [])) as {
      roots?: { name: string; path: string }[];
    };
    check(
      "files:listDir with no path offers starting points",
      Array.isArray(roots.roots) && (roots.roots?.length ?? 0) > 0,
      (roots.roots ?? []).map((root) => root.name).join(", "),
    );

    const created = (await client.invoke("files:createDirectory", [
      dataRoot,
      "harness-folder",
    ])) as string;
    check(
      "files:createDirectory makes the folder",
      typeof created === "string" && existsSync(created),
      created,
    );

    // Export staging: a temp path the backend may write to, then downloadable.
    const tempPath = (await client.invoke("files:tempPath", [
      "export-test.zip",
    ])) as string;
    check(
      "files:tempPath stays inside the data folder",
      typeof tempPath === "string" && tempPath.startsWith(dataRoot),
      tempPath,
    );
    writeFileSync(tempPath, "exported bytes");
    const exported = await readDownload(client, tempPath);
    check(
      "an export written to the temp path downloads intact",
      exported.toString("utf8") === "exported bytes",
    );

    // Stage upload (import flow): local bytes → backend path.
    const staged = (await client.upload(
      "files:stageUpload",
      ["package.zip"],
      Buffer.from("staged bytes"),
      "package.zip",
    )) as { path?: string };
    check(
      "files:stageUpload returns a backend path",
      typeof staged.path === "string" && existsSync(staged.path),
      String(staged.path),
    );

    // Streamed upload (P3): a local file goes to the backend's temp folder
    // without ever being buffered, and the channel receives its path.
    const localFile = join(tmpdir(), `imboss-local-${randomUUID()}.zip`);
    writeFileSync(localFile, Buffer.alloc(1024 * 1024, 7));
    const streamed = (await client.uploadFile(
      "files:stageUpload",
      ["large-import.zip"],
      localFile,
    )) as { path?: string; size?: number };
    check(
      "a streamed upload lands in the backend temp folder",
      typeof streamed.path === "string" &&
        streamed.path.startsWith(join(dataRoot, "tmp")) &&
        streamed.size === 1024 * 1024,
      String(streamed.path),
    );
    if (typeof streamed.path === "string") {
      const roundTrip = await readDownload(client, streamed.path);
      check(
        "the streamed file round-trips byte for byte",
        roundTrip.length === 1024 * 1024 &&
          roundTrip.every((byte) => byte === 7),
        `${roundTrip.length} bytes`,
      );
      check(
        "no .partial file is left after a completed upload",
        !existsSync(`${streamed.path}.partial`),
      );
    }
    rmSync(localFile, { force: true });

    // Attachment record lookup (P3): "reveal" in remote mode means "download it
    // here", so the path must be resolvable for a stored message.
    const attachmentPath = (attached.path ?? "") as string;
    const stored = appendMessage(1, null, "attachment test", {
      attachments: [
        {
          name: "report.pdf",
          size: payload.length,
          type: "application/pdf",
          path: attachmentPath,
        },
      ],
    });
    const record = (await client.invoke("messages:attachmentFile", [
      stored.id,
      0,
    ])) as { name?: string; path?: string | null; kind?: string };
    check(
      "messages:attachmentFile resolves the stored path",
      record.path === attachmentPath && record.kind === "file",
      `${record.name} → ${String(record.path)}`,
    );
    const missingRecord = await expectGrpcError(() =>
      client.invoke("messages:attachmentFile", [stored.id, 5]),
    );
    check(
      "an out-of-range attachment index is rejected",
      missingRecord !== null &&
        /attachment does not exist/i.test(missingRecord.message),
      missingRecord?.message ?? "no error",
    );

    // Temp sweep (P3): stale export folders and abandoned .partial uploads go.
    const staleExport = (await client.invoke("files:tempPath", [
      "stale.zip",
    ])) as string;
    writeFileSync(staleExport, "stale");
    const staleDir = dirname(staleExport);
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(staleExport, old, old);
    utimesSync(staleDir, old, old);
    const partialDir = join(dataRoot, "tmp", "uploads");
    mkdirSync(partialDir, { recursive: true });
    const partialFile = join(partialDir, "abandoned.partial");
    writeFileSync(partialFile, "half");
    utimesSync(
      partialFile,
      new Date(Date.now() - 2 * 60 * 60 * 1000),
      new Date(Date.now() - 2 * 60 * 60 * 1000),
    );
    const swept = sweepTransferTempRoot();
    check(
      "the startup sweep removes stale exports and .partial files",
      swept.removedDirs >= 1 &&
        swept.removedPartials >= 1 &&
        !existsSync(staleDir) &&
        !existsSync(partialFile),
      `${swept.removedDirs} dir(s), ${swept.removedPartials} partial(s)`,
    );

    // Workdir: set from a browsed path (and restored afterwards).
    const before = (await client.invoke("workdir:get", [])) as {
      effective?: string;
    };
    const newWorkdir = join(dataRoot, "harness-workdir");
    const after = (await client.invoke("workdir:set", [newWorkdir])) as {
      effective?: string;
    };
    check(
      "workdir:set applies a browsed path",
      after.effective === newWorkdir && existsSync(newWorkdir),
      String(after.effective),
    );
    if (typeof before.effective === "string") {
      await client.invoke("workdir:set", [before.effective]);
    }
    void handlers;
  } finally {
    client.close();
  }
}

/** Raw download of a missing file: resolves with the status the client saw. */
async function rawMissingDownloadStatus(
  address: string,
  path: string,
): Promise<number> {
  const stub = makeStub(address) as unknown as {
    Download(
      request: { path: string; version: string },
      metadata: grpc.Metadata,
      options: grpc.CallOptions,
    ): grpc.ClientReadableStream<unknown>;
    close(): void;
  };
  const metadata = new grpc.Metadata();
  metadata.set("authorization", `Bearer ${TOKEN}`);
  metadata.set("x-imboss-client", randomUUID());
  const call = stub.Download({ path, version: "" }, metadata, {});
  return await new Promise<number>((resolve) => {
    call.on("data", () => {
      /* none expected */
    });
    call.on("error", (error: grpc.ServiceError) => {
      stub.close();
      resolve(error.code);
    });
    call.on("status", (status) => {
      if (status.code !== grpc.status.OK) {
        stub.close();
        resolve(status.code);
      }
    });
    call.on("end", () => {
      stub.close();
      resolve(-1);
    });
    // A hang is the failure mode this guards against.
    setTimeout(() => resolve(-2), 8000);
  });
}

/**
 * Download one file through the client's production path
 * (`downloadToFile`) and report either its bytes or the failure.
 */
async function tryDownload(
  client: RemoteClient,
  path: string,
): Promise<{ bytes: Buffer } | { error: Error }> {
  const target = join(tmpdir(), `imboss-download-${randomUUID()}.bin`);
  try {
    await client.downloadToFile(path, target);
    return { bytes: readFileSync(target) };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  } finally {
    rmSync(target, { force: true });
  }
}

async function readDownload(
  client: RemoteClient,
  path: string,
): Promise<Buffer> {
  const result = await tryDownload(client, path);
  if ("error" in result) throw result.error;
  return result.bytes;
}

/** Push one streamed delta through the real business broadcast path. */
function pushDelta(contentIndex: number): void {
  sendToRenderer("agentSession:event", {
    employeeId: 0,
    chatId: 1,
    event: {
      type: "message_update",
      subType: "text_delta",
      delta: "x",
      contentIndex,
    },
  });
}

function pushBroadcast(channel: string, payload: unknown): void {
  sendToRenderer(channel, payload);
}

interface EventSession {
  events: CollectedEvent[];
  lastSeq: number;
  resyncReason: string | null;
  close: () => Promise<void>;
}

/** Raw client, so the harness controls `resumeFromSeq` and the socket. */
async function connectEvents(
  address: string,
  clientId: string,
  resumeFromSeq: number,
): Promise<EventSession> {
  const stub = makeStub(address);
  const metadata = new grpc.Metadata();
  metadata.set("authorization", `Bearer ${TOKEN}`);
  metadata.set("x-imboss-client", clientId);

  const events: CollectedEvent[] = [];
  let resyncReason: string | null = null;
  let lastSeq = 0;
  let subscribed = false;

  const stream = stub.Subscribe({ channels: [], resumeFromSeq }, metadata, {});

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("subscribe timeout")),
      5000,
    );
    stream.on("data", (value: unknown) => {
      const event = value as {
        channel?: string;
        payloadJson?: Uint8Array;
        hasPayload?: boolean;
        seq?: number;
        dropped?: number;
      };
      const channel = typeof event.channel === "string" ? event.channel : "";
      const payload =
        event.hasPayload === true && event.payloadJson
          ? (JSON.parse(
              Buffer.from(event.payloadJson).toString("utf8"),
            ) as unknown)
          : undefined;
      if (channel === "server:subscribed") {
        const reported = (payload as { lastSeq?: number } | undefined)?.lastSeq;
        if (typeof reported === "number") lastSeq = reported;
        subscribed = true;
        clearTimeout(timer);
        resolve();
        return;
      }
      if (channel === "server:resync") {
        const reported = payload as
          { lastSeq?: number; reason?: string } | undefined;
        if (typeof reported?.lastSeq === "number") lastSeq = reported.lastSeq;
        resyncReason = reported?.reason ?? "unknown";
        subscribed = true;
        clearTimeout(timer);
        resolve();
        return;
      }
      const seq = typeof event.seq === "number" ? event.seq : 0;
      if (seq > 0 && seq <= lastSeq) return; // stale
      if (seq > 0) lastSeq = seq;
      events.push({
        channel,
        payload,
        seq,
        dropped: typeof event.dropped === "number" ? event.dropped : 0,
      });
    });
    stream.on("error", (error: grpc.ServiceError) => {
      clearTimeout(timer);
      reject(new Error(error.details ?? error.message));
    });
  });

  if (!subscribed) throw new Error("subscription was not acknowledged");

  return {
    events,
    get lastSeq() {
      return lastSeq;
    },
    get resyncReason() {
      return resyncReason;
    },
    close: () =>
      new Promise<void>((resolve) => {
        stream.cancel();
        stub.close();
        setTimeout(resolve, 20);
      }),
  };
}

function describeStatus(error: grpc.ServiceError): string {
  return `${grpc.status[error.code] ?? error.code}: ${error.details ?? ""}`.trim();
}

/** One event as the events suite collects it. */
interface CollectedEvent {
  channel: string;
  payload: unknown;
  seq: number;
  dropped: number;
}

/** Minimal raw stub (protobufjs reflection + grpc-js), used by the suites that
 *  must not depend on the app's own client. */
function makeStub(address: string): {
  Subscribe(
    request: { channels: string[]; resumeFromSeq?: number },
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
  ): grpc.ClientReadableStream<unknown>;
  Download(
    request: { path: string; version: string },
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
  ): grpc.ClientReadableStream<unknown>;
  close(): void;
} {
  const root = protobuf.parse(protoSource).root;
  root.resolveAll();
  const service = root.lookupService("imboss.v1.Imboss");
  const definition: Record<string, unknown> = {};
  for (const [name, method] of Object.entries(service.methods)) {
    const request = method.resolvedRequestType;
    const response = method.resolvedResponseType;
    if (!request || !response) throw new Error(`unresolved type for ${name}`);
    const options = {
      defaults: true,
      arrays: true,
      longs: Number,
      bytes: Buffer,
    } as const;
    definition[name] = {
      path: `/${service.fullName.replace(/^\./, "")}/${name}`,
      requestStream: Boolean(method.requestStream),
      responseStream: Boolean(method.responseStream),
      requestSerialize: (value: unknown): Buffer =>
        Buffer.from(
          request
            .encode(
              request.fromObject((value ?? {}) as Record<string, unknown>),
            )
            .finish(),
        ),
      requestDeserialize: (bytes: Buffer): unknown =>
        request.toObject(request.decode(bytes), options),
      responseSerialize: (value: unknown): Buffer =>
        Buffer.from(
          response
            .encode(
              response.fromObject((value ?? {}) as Record<string, unknown>),
            )
            .finish(),
        ),
      responseDeserialize: (bytes: Buffer): unknown =>
        response.toObject(response.decode(bytes), options),
    };
  }
  const Stub = grpc.makeGenericClientConstructor(
    definition as unknown as grpc.ServiceDefinition,
    "Imboss",
  );
  return new Stub(address, grpc.credentials.createInsecure()) as never;
}

/** Craft an upload that claims to be far larger than the cap. */
function claimOversizedUpload(address: string): Promise<void> {
  const root = protobuf.parse(protoSource).root;
  root.resolveAll();
  const service = root.lookupService("imboss.v1.Imboss");
  const UploadChunk = root.lookupType("imboss.v1.UploadChunk");
  const UploadReply = root.lookupType("imboss.v1.UploadReply");
  const definition = {
    Upload: {
      path: `/${service.fullName.replace(/^\./, "")}/Upload`,
      requestStream: true,
      responseStream: false,
      requestSerialize: (value: unknown): Buffer =>
        Buffer.from(
          UploadChunk.encode(UploadChunk.fromObject(value as never)).finish(),
        ),
      requestDeserialize: (bytes: Buffer): unknown => UploadChunk.decode(bytes),
      responseSerialize: (value: unknown): Buffer =>
        Buffer.from(
          UploadReply.encode(UploadReply.fromObject(value as never)).finish(),
        ),
      responseDeserialize: (bytes: Buffer): unknown =>
        UploadReply.decode(bytes),
    },
  } as unknown as grpc.ServiceDefinition;
  const Stub = grpc.makeGenericClientConstructor(definition, "Imboss");
  const stub = new Stub(address, grpc.credentials.createInsecure());
  const metadata = new grpc.Metadata();
  metadata.set("authorization", `Bearer ${TOKEN}`);
  metadata.set("x-imboss-client", randomUUID());

  return new Promise<void>((resolve, reject) => {
    const call = stub.Upload(
      metadata,
      {},
      (error: grpc.ServiceError | null) => {
        stub.close();
        if (error) reject(error);
        else resolve();
      },
    );
    call.write({
      meta: {
        channel: "files:uploadAttachment",
        argsJson: Buffer.from(
          JSON.stringify([1, "big.pdf", "application/pdf"]),
        ),
        totalBytes: 1024 * 1024 * 1024,
        uploadId: "oversized",
        fileName: "big.pdf",
      },
    });
    call.end();
  });
}

async function expectGrpcError(
  run: () => Promise<unknown>,
): Promise<grpc.ServiceError | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return error as grpc.ServiceError;
  }
}

function describeError(error: Error): string {
  const code = errorCode(error);
  return code === undefined
    ? error.message
    : `${grpc.status[code] ?? code}: ${error.message}`;
}

/** `Error` may carry the gRPC status (the client copies it onto the wrapper). */
function errorCode(error: Error): number | undefined {
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

function isContiguous(events: CollectedEvent[]): boolean {
  const seqs = events.map((event) => event.seq).filter((seq) => seq > 0);
  return seqs.every((seq, index) => index === 0 || seq === seqs[index - 1] + 1);
}

/**
 * Fields that legitimately differ between two reads of the same data.
 *
 * Only `generatedAt` (the spend report's "computed at" stamp) is time-varying in
 * the compared set; everything else must match exactly, which is the point of
 * this suite.
 */
const VOLATILE_KEYS = new Set(["generatedAt"]);

/** First path where two values differ, or `null` when deeply equal. */
function firstDifference(a: unknown, b: unknown, path = ""): string | null {
  if (a === b) return null;
  if (typeof a !== typeof b) {
    return `${path}: type ${typeof a} vs ${typeof b}`;
  }
  if (a === null || b === null) {
    return `${JSON.stringify(a)} vs ${JSON.stringify(b)} at ${path || "<root>"}`;
  }
  if (typeof a !== "object") {
    return `${JSON.stringify(a)} vs ${JSON.stringify(b)} at ${path || "<root>"}`;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      return `array vs object at ${path || "<root>"}`;
    }
    if (a.length !== b.length) {
      return `length ${a.length} vs ${b.length} at ${path || "<root>"}`;
    }
    for (let index = 0; index < a.length; index += 1) {
      const diff = firstDifference(a[index], b[index], `${path}[${index}]`);
      if (diff !== null) return diff;
    }
    return null;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (VOLATILE_KEYS.has(key)) continue;
    const hasLeft = Object.hasOwn(left, key);
    const hasRight = Object.hasOwn(right, key);
    if (hasLeft !== hasRight) {
      return `key "${key}" present on ${hasLeft ? "reference" : "remote"} only at ${path || "<root>"}`;
    }
    const diff = firstDifference(
      left[key],
      right[key],
      path === "" ? key : `${path}.${key}`,
    );
    if (diff !== null) return diff;
  }
  return null;
}

function summarize(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text.slice(0, 80);
}

function describeArgs(args: unknown[]): string {
  return args.map((arg) => JSON.stringify(arg) ?? "undefined").join(", ");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until the backend noticed a stream is gone. Events pushed before that
 * would race with the closing writer.
 */
async function waitForDetach(): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (subscribers.attachedCount === 0) return;
    await sleep(20);
  }
  throw new Error("the backend did not release the previous stream");
}

void main().catch((error: unknown) => {
  console.error(
    `\nharness failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exitCode = 1;
});
