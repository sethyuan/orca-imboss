#!/usr/bin/env node
/**
 * Smoke test for a running imboss remote backend.
 *
 * Talks to the backend the way the desktop shell does — same `.proto`, same
 * metadata, same JSON envelopes — but through a hand-built gRPC client, so it
 * verifies the *wire contract* rather than the app's own client code. Run it
 * after deploying, or after changing anything in `src/main/rpc` / `src/main/server`.
 *
 * Usage:
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
 *     scripts/tests/remote-backend-smoke.ts --target 127.0.0.1:47810 \
 *     --token-file ~/.imboss/token
 *
 *   --target <host:port>   backend address (default 127.0.0.1:47810)
 *   --token-file <path>    file holding the shared token (preferred)
 *   --token <token>        inline token (debugging only)
 *   --write                also run the mutation checks: creates a chat, appends
 *                          a message, deletes the chat again. Off by default so
 *                          pointing this at a real deployment is read-only.
 *
 * Exit code 0 = every check passed, 1 = at least one failed.
 */

import * as grpc from "@grpc/grpc-js";
import protobuf from "protobufjs";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

interface Endpoint {
  target: string;
  token: string;
  write: boolean;
}

interface CheckResult {
  label: string;
  ok: boolean;
  detail?: string;
}

const PROTO_PATH = new URL("../../src/main/rpc/imboss.proto", import.meta.url);
const TOKEN_HEADER = "authorization";
const CLIENT_ID_HEADER = "x-imboss-client";

const { values } = parseArgs({
  options: {
    target: { type: "string", default: "127.0.0.1:47810" },
    "token-file": { type: "string" },
    token: { type: "string" },
    write: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

const endpoint: Endpoint = {
  target: values.target as string,
  token: resolveToken(),
  write: values.write === true,
};

main().catch((error: unknown) => {
  console.error(
    `\nprobe failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});

function resolveToken(): string {
  if (typeof values["token-file"] === "string") {
    const token = readFileSync(values["token-file"], "utf8").trim();
    if (token.length === 0) throw new Error("--token-file is empty.");
    return token;
  }
  if (typeof values.token === "string" && values.token.length > 0) {
    console.warn("warning: --token is visible in the process list.\n");
    return values.token.trim();
  }
  throw new Error("pass --token-file <path> (or --token for debugging).");
}

async function main(): Promise<void> {
  const results: CheckResult[] = [];
  const check = (label: string, ok: boolean, detail?: string): void => {
    results.push({ label, ok, ...(detail !== undefined ? { detail } : {}) });
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`,
    );
  };

  const { stub, close } = createClient(endpoint);
  const events: { channel: string; payload: unknown }[] = [];
  const stream = stub.Subscribe(
    { channels: [] },
    metadata(endpoint, "smoke"),
    {},
  );
  const subscribed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error("the backend did not acknowledge the subscription")),
      10_000,
    );
    stream.on("data", (event: unknown) => {
      const { channel, payload } = decodeEvent(event);
      if (channel === "server:subscribed") {
        clearTimeout(timer);
        resolve();
        return;
      }
      if (channel !== null) events.push({ channel, payload });
    });
    stream.on("error", (error: grpc.ServiceError) => {
      clearTimeout(timer);
      reject(new Error(error.details ?? error.message));
    });
  });

  try {
    await subscribed;
    check("event stream acknowledged", true);

    const info = await callInfo(stub, endpoint);
    check(
      "Info reports a version and api version",
      info.appVersion.length > 0 && info.apiVersion >= 1,
      `v${info.appVersion} api v${info.apiVersion}`,
    );
    check(
      "Info reports the channel table",
      info.channels.length >= 90,
      `${info.channels.length} channels`,
    );
    for (const channel of [
      "chats:summaries",
      "messages:list",
      "settings:get",
    ]) {
      check(`channel table serves ${channel}`, info.channels.includes(channel));
    }

    // --- read path (always) -------------------------------------------------
    const summaries = await invoke(stub, endpoint, "chats:summaries", []);
    check("chats:summaries returns a list", Array.isArray(summaries));

    const existing = Array.isArray(summaries) ? summaries[0] : undefined;
    if (existing && typeof existing.id === "number") {
      const messages = await invoke(stub, endpoint, "messages:list", [
        existing.id,
      ]);
      check(
        `messages:list works for chat #${existing.id}`,
        Array.isArray(messages),
        `${Array.isArray(messages) ? messages.length : "?"} messages`,
      );
    } else {
      check("messages:list skipped (no chat to read)", true);
    }

    check(
      "settings:get returns a stored value or null",
      (await invoke(stub, endpoint, "settings:get", ["app.locale"])) !==
        undefined,
    );

    // --- error model -------------------------------------------------------
    const badArg = await expectError(() =>
      invoke(stub, endpoint, "messages:list", ["not-an-integer"]),
    );
    check(
      "handler rejection keeps its message",
      badArg?.details === "chat id must be an integer.",
      badArg?.details,
    );
    check(
      "handler rejection uses FAILED_PRECONDITION",
      badArg?.code === grpc.status.FAILED_PRECONDITION,
    );

    const unknown = await expectError(() =>
      invoke(stub, endpoint, "no:such-channel", []),
    );
    check(
      "unknown channel → UNIMPLEMENTED",
      unknown?.code === grpc.status.UNIMPLEMENTED,
      unknown?.details,
    );

    const badToken = await expectError(() =>
      callInfo(stub, { ...endpoint, token: "x".repeat(32) }),
    );
    check(
      "wrong token → UNAUTHENTICATED",
      badToken?.code === grpc.status.UNAUTHENTICATED,
      badToken?.details,
    );

    const second = await expectError(() =>
      invoke(
        stub,
        { ...endpoint, clientId: "smoke-second" },
        "chats:summaries",
        [],
      ),
    );
    check(
      "a second client is rejected with a readable message",
      second?.code === grpc.status.FAILED_PRECONDITION &&
        /single remote client/i.test(second.details ?? ""),
      second?.details,
    );

    // --- write path (opt-in) ----------------------------------------------
    if (endpoint.write) {
      const chat = await invoke(stub, endpoint, "chats:create", [
        "smoke test",
        [0],
      ]);
      const chatId = (chat as { id?: number } | null)?.id;
      check("chats:create", typeof chatId === "number", `chat #${chatId}`);
      if (typeof chatId === "number") {
        await invoke(stub, endpoint, "messages:append", [
          chatId,
          null,
          "hello from the smoke test",
        ]);
        const messages = await invoke(stub, endpoint, "messages:list", [
          chatId,
        ]);
        check(
          "messages:append + messages:list round-trip",
          Array.isArray(messages) && messages.length === 1,
        );

        await invoke(stub, endpoint, "chats:update", [
          chatId,
          "smoke test renamed",
        ]);
        await sleep(300);
        check(
          "event push: chats:changed",
          events.some((event) => event.channel === "chats:changed"),
        );

        // File transfer: upload → readable backend path → download → same bytes.
        const bytes = Buffer.from(
          Array.from({ length: 4096 }, (_, i) => i % 256),
        );
        const attachment = (await upload(
          stub,
          endpoint,
          "files:uploadAttachment",
          [chatId, "smoke.bin", "application/octet-stream"],
          bytes,
          "smoke.bin",
        )) as { path?: string; name?: string; size?: number };
        check(
          "upload returns a backend path",
          typeof attachment.path === "string",
          String(attachment.path),
        );
        if (typeof attachment.path === "string") {
          const downloaded = await download(stub, endpoint, attachment.path);
          check(
            "download returns the uploaded bytes",
            downloaded !== null && downloaded.equals(bytes),
            `${downloaded?.length ?? 0} bytes`,
          );
        }
        const listing = (await invoke(stub, endpoint, "files:listDir", [])) as {
          roots?: unknown[];
        };
        check(
          "files:listDir offers starting points",
          Array.isArray(listing.roots) && (listing.roots?.length ?? 0) > 0,
        );

        await invoke(stub, endpoint, "chats:delete", [chatId]);
        await sleep(300);
        check(
          "event push: messages:changed",
          events.some((event) => event.channel === "messages:changed"),
        );
        check(
          "event push: chats:deleted",
          events.some((event) => event.channel === "chats:deleted"),
        );
      }
    } else {
      console.log("SKIP  write checks (pass --write to run them)");
    }
  } finally {
    stream.cancel();
    close();
  }

  const failed = results.filter((result) => !result.ok);
  console.log(
    failed.length === 0
      ? `\nall ${results.length} checks passed`
      : `\n${failed.length} of ${results.length} checks FAILED`,
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
}

// --- transport ------------------------------------------------------------

interface ImbossStub extends grpc.Client {
  Info(
    request: Record<string, never>,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, reply?: unknown) => void,
  ): grpc.ClientUnaryCall;
  Invoke(
    request: { method: string; argsJson: Buffer; timeoutMs: number },
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, reply?: unknown) => void,
  ): grpc.ClientUnaryCall;
  Subscribe(
    request: { channels: string[]; resumeFromSeq?: number },
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
  ): grpc.ClientReadableStream<unknown>;
  Upload(
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, reply?: unknown) => void,
  ): grpc.ClientWritableStream<unknown>;
  Download(
    request: { path: string; version: string },
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
  ): grpc.ClientReadableStream<unknown>;
}

function createClient(endpoint: Endpoint): {
  stub: ImbossStub;
  close: () => void;
} {
  const root = protobuf.parse(readFileSync(PROTO_PATH, "utf8")).root;
  root.resolveAll();
  const service = root.lookupService("imboss.v1.Imboss");

  const definition: Record<string, unknown> = {};
  for (const [name, method] of Object.entries(service.methods)) {
    const request = method.resolvedRequestType;
    const response = method.resolvedResponseType;
    if (!request || !response) {
      throw new Error(`unresolved message type for ${name}`);
    }
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
          request.encode(request.fromObject(asObject(value))).finish(),
        ),
      requestDeserialize: (bytes: Buffer): unknown =>
        request.toObject(request.decode(bytes), options),
      responseSerialize: (value: unknown): Buffer =>
        Buffer.from(
          response.encode(response.fromObject(asObject(value))).finish(),
        ),
      responseDeserialize: (bytes: Buffer): unknown =>
        response.toObject(response.decode(bytes), options),
    };
  }

  const Stub = grpc.makeGenericClientConstructor(
    definition as unknown as grpc.ServiceDefinition,
    "Imboss",
  ) as unknown as new (
    target: string,
    credentials: grpc.ChannelCredentials,
  ) => ImbossStub;

  const stub = new Stub(endpoint.target, grpc.credentials.createInsecure());
  return { stub, close: () => stub.close() };
}

function asObject(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

function metadata(endpoint: Endpoint, clientId: string): grpc.Metadata {
  const md = new grpc.Metadata();
  md.set(TOKEN_HEADER, `Bearer ${endpoint.token}`);
  md.set(CLIENT_ID_HEADER, clientId);
  return md;
}

function decodeEvent(value: unknown): {
  channel: string | null;
  payload: unknown;
} {
  const event = asObject(value) as {
    channel?: unknown;
    payloadJson?: Uint8Array;
    hasPayload?: boolean;
  };
  const channel = typeof event.channel === "string" ? event.channel : "";
  if (channel.length === 0) return { channel: null, payload: undefined };
  if (event.hasPayload !== true || !event.payloadJson) {
    return { channel, payload: undefined };
  }
  try {
    return {
      channel,
      payload: JSON.parse(Buffer.from(event.payloadJson).toString("utf8")),
    };
  } catch {
    return { channel, payload: "<malformed json>" };
  }
}

async function callInfo(
  stub: ImbossStub,
  endpoint: Endpoint & { clientId?: string },
): Promise<{ appVersion: string; apiVersion: number; channels: string[] }> {
  const reply = await new Promise<Record<string, unknown>>(
    (resolve, reject) => {
      stub.Info(
        {},
        metadata(endpoint, endpoint.clientId ?? "smoke"),
        { deadline: Date.now() + 10_000 },
        (error, value) => (error ? reject(error) : resolve(asObject(value))),
      );
    },
  );
  return {
    appVersion: String(reply["appVersion"] ?? ""),
    apiVersion: Number(reply["apiVersion"] ?? 0),
    channels: Array.isArray(reply["channels"])
      ? (reply["channels"] as unknown[]).filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [],
  };
}

async function invoke(
  stub: ImbossStub,
  endpoint: Endpoint & { clientId?: string },
  method: string,
  args: unknown[],
): Promise<unknown> {
  const reply = await new Promise<Record<string, unknown>>(
    (resolve, reject) => {
      stub.Invoke(
        {
          method,
          argsJson: Buffer.from(JSON.stringify(args), "utf8"),
          timeoutMs: 30_000,
        },
        metadata(endpoint, endpoint.clientId ?? "smoke"),
        { deadline: Date.now() + 35_000 },
        (error, value) => (error ? reject(error) : resolve(asObject(value))),
      );
    },
  );
  if (reply["hasResult"] !== true) return undefined;
  const raw = reply["resultJson"];
  const text =
    raw instanceof Uint8Array ? Buffer.from(raw).toString("utf8") : "";
  return text.length === 0 ? undefined : (JSON.parse(text) as unknown);
}

/** One upload over the client-streaming `Upload` channel. */
function upload(
  stub: ImbossStub,
  endpoint: Endpoint,
  channel: string,
  args: unknown[],
  bytes: Uint8Array,
  fileName: string,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const call = stub.Upload(
      metadata(endpoint, "smoke"),
      {},
      (error, reply) => {
        if (error) {
          reject(error);
          return;
        }
        const value = (reply ?? {}) as {
          resultJson?: Uint8Array;
          hasResult?: boolean;
        };
        if (value.hasResult !== true) {
          resolve(undefined);
          return;
        }
        const text = value.resultJson
          ? Buffer.from(value.resultJson).toString("utf8")
          : "";
        resolve(text.length === 0 ? undefined : (JSON.parse(text) as unknown));
      },
    );
    call.write({
      meta: {
        channel,
        argsJson: Buffer.from(JSON.stringify(args), "utf8"),
        totalBytes: bytes.length,
        uploadId: `smoke-${Date.now()}`,
        fileName,
      },
    });
    call.write({ data: Buffer.from(bytes) });
    call.end();
  });
}

/** One download over the server-streaming `Download` channel. */
function download(
  stub: ImbossStub,
  endpoint: Endpoint,
  path: string,
): Promise<Buffer | null> {
  const call = stub.Download(
    { path, version: "" },
    metadata(endpoint, "smoke"),
    {},
  );
  const chunks: Buffer[] = [];
  return new Promise<Buffer | null>((resolve) => {
    call.on("data", (chunk: unknown) => {
      const data = (chunk as { data?: Uint8Array }).data;
      if (data) chunks.push(Buffer.from(data));
    });
    call.on("error", () => resolve(null));
    call.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function expectError(
  run: () => Promise<unknown>,
): Promise<grpc.ServiceError | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return error as grpc.ServiceError;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
