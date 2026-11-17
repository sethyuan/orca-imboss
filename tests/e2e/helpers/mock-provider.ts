import { createServer, type Server } from "node:http";
import type { Page } from "@playwright/test";

/**
 * A minimal OpenAI-compatible model server, so a test can have a **real agent
 * run** without a real provider or any spending.
 *
 * The work-status board only shows a task group while someone is actually
 * working in it, and "working" is the live state of a Pi session — there is no
 * stored flag to fake. A run needs a model, so the cheapest honest way to get one
 * is a local server that streams an SSE completion slowly: the session really is
 * streaming for as long as the mock keeps talking, which is exactly the window
 * these tests measure.
 *
 * Everything runs on 127.0.0.1 with an ephemeral port and a throw-away API key;
 * nothing leaves the machine.
 */

export interface MockModel {
  readonly port: number;
  /** Requests seen so far (diagnostics only). */
  readonly requests: number;
  close(): Promise<void>;
}

export interface MockModelOptions {
  /** Chunks streamed per completion. `tokens × delayMs` is the run's length. */
  tokens?: number;
  delayMs?: number;
}

interface RunningServer {
  server: Server;
  port: number;
  requests: number;
}

function startServer(options: MockModelOptions): Promise<RunningServer> {
  const tokens = options.tokens ?? 90;
  const delayMs = options.delayMs ?? 200;
  let requests = 0;

  const server = createServer((request, response) => {
    request.on("data", () => undefined);
    request.on("end", () => {
      const url = request.url ?? "";
      if (request.method === "GET" && url.startsWith("/v1/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            object: "list",
            data: [{ id: "mock-model", object: "model" }],
          }),
        );
        return;
      }
      if (!url.includes("chat/completions")) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "not found" } }));
        return;
      }
      requests += 1;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const chunk = (delta: object, finish: string | null = null): string =>
        `data: ${JSON.stringify({
          id: "mock-1",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "mock-model",
          choices: [{ index: 0, delta, finish_reason: finish }],
          usage: null,
        })}\n\n`;

      response.write(chunk({ role: "assistant", content: "" }));
      let sent = 0;
      const timer = setInterval(() => {
        sent += 1;
        response.write(chunk({ content: `chunk${sent} ` }));
        if (sent >= tokens) {
          clearInterval(timer);
          response.write(chunk({}, "stop"));
          response.write("data: [DONE]\n\n");
          response.end();
        }
      }, delayMs);
      request.on("close", () => clearInterval(timer));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      resolve({ server, port, requests });
    });
  });
}

export async function startMockModel(
  options: MockModelOptions = {},
): Promise<MockModel> {
  const running = await startServer(options);
  return {
    port: running.port,
    get requests(): number {
      return running.requests;
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        running.server.closeAllConnections?.();
        running.server.close(() => resolve());
      });
    },
  };
}

/** Register the mock as a custom provider and make it the default model. */
export async function configureMockProvider(
  window: Page,
  port: number,
): Promise<void> {
  await window.evaluate(async (mockPort: number) => {
    const api = (
      window as unknown as {
        imb: {
          providers: {
            upsert: (input: {
              id: string;
              kind: string;
              baseUrl: string;
              apiKey: string;
              apiType: string;
              models: Array<{ id: string; input: string[] }>;
            }) => Promise<unknown>;
          };
          settings: {
            set: (key: string, value: string) => Promise<void>;
          };
        };
      }
    ).imb;
    await api.providers.upsert({
      id: "mock",
      kind: "custom",
      baseUrl: `http://127.0.0.1:${mockPort}/v1`,
      apiKey: "sk-mock",
      apiType: "openai-completions",
      models: [{ id: "mock-model", input: ["text"] }],
    });
    await api.settings.set("agent.defaultModel", "mock/mock-model");
  }, port);
}

/**
 * Start a real run for one employee inside one chat (a task group), and return
 * once the request has been accepted. The run streams for as long as the mock
 * keeps sending, so the caller decides when to settle it.
 */
export async function startEmployeeRun(
  window: Page,
  chatId: number,
  employeeId: number,
): Promise<void> {
  await window.evaluate(
    async (payload: string) => {
      const [id, chat] = JSON.parse(payload) as [number, number];
      const api = (
        window as unknown as {
          imb: {
            agentSession: {
              send: (
                employeeId: number,
                chatId: number,
                text: string,
              ) => Promise<unknown>;
            };
          };
        }
      ).imb;
      await api.agentSession.send(id, chat, "keep working, please");
    },
    JSON.stringify([employeeId, chatId]),
  );
}

/** Start a real run for the assistant in a root chat. */
export async function startAssistantRun(
  window: Page,
  rootChatId: number,
): Promise<void> {
  await window.evaluate(async (chatId: number) => {
    const api = (
      window as unknown as {
        imb: {
          chat: { send: (chatId: number, text: string) => Promise<unknown> };
        };
      }
    ).imb;
    await api.chat.send(chatId, "please look at the board");
  }, rootChatId);
}

/**
 * End one run (the agent-session view's interrupt). Returns once the session
 * stopped streaming, which is what makes its room disappear.
 */
export async function settleRun(
  window: Page,
  employeeId: number,
  chatId: number,
): Promise<void> {
  await window.evaluate(
    async (payload: string) => {
      const [id, chat] = JSON.parse(payload) as [number, number];
      const api = (
        window as unknown as {
          imb: {
            agentSession: {
              interruptTurn: (e: number, c: number) => Promise<unknown>;
            };
          };
        }
      ).imb;
      await api.agentSession.interruptTurn(id, chat);
    },
    JSON.stringify([employeeId, chatId]),
  );
}
