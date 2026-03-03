import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { AcpClient } from "../acpClient";
import { InactivityGuard } from "../acp/inactivityGuard";
import {
  buildInactivityRecoveryPrompt,
  connectWithRecovery,
} from "../acp/client/acpRunRecovery";

class FakeTransport {
  connected = false;
  onClose: ((error?: Error) => void) | null = null;

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async send(): Promise<void> {}

  async receive(): Promise<string> {
    return new Promise<string>(() => {}); // blocks forever in tests
  }
}

class FakeProtocol {
  requests: Array<{ method: string; params: unknown }> = [];
  serverHandlers = new Map<string, Function>();
  notificationHandlers = new Map<string, Function>();
  started = false;
  disposed = false;

  async sendRequest(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });

    switch (method) {
      case "initialize":
        return { protocolVersion: 1, isAuthenticated: false };
      case "authenticate":
        return { methodId: "iflow" };
      case "session/new":
        return { sessionId: "test-session-123" };
      case "session/load":
        return {};
      case "session/set_mode":
        return { success: true, currentModeId: (params as any)?.modeId };
      case "session/set_model":
        return { success: true, currentModelId: (params as any)?.modelId };
      case "session/set_think":
        return {
          success: true,
          currentThinkEnabled: Boolean((params as any)?.thinkEnabled),
        };
      case "session/prompt":
        this.simulateUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello!" },
        });
        return { stopReason: "end_turn" };
      case "session/cancel":
        return {};
      default:
        return {};
    }
  }

  async sendResult(_id: number, _result: unknown): Promise<void> {}
  async sendError(
    _id: number,
    _code: number,
    _message: string,
  ): Promise<void> {}

  onServerMethod(method: string, handler: Function): void {
    this.serverHandlers.set(method, handler);
  }

  onNotification(method: string, handler: Function): void {
    this.notificationHandlers.set(method, handler);
  }

  startReceiveLoop(): void {
    this.started = true;
  }

  stopReceiveLoop(): void {}

  dispose(): void {
    this.disposed = true;
  }

  simulateUpdate(update: Record<string, unknown>): void {
    const handler = this.notificationHandlers.get("session/update");
    if (handler) {
      handler({ sessionId: "test-session-123", update });
    }
  }

  async simulateServerMethod(
    method: string,
    id: number,
    params: unknown,
  ): Promise<unknown> {
    const handler = this.serverHandlers.get(method);
    if (!handler) {
      throw new Error(`No handler for ${method}`);
    }
    return await handler(id, params);
  }
}

suite("AcpClient", () => {
  let client: AcpClient;
  let fakeTransport: FakeTransport;
  let fakeProtocol: FakeProtocol;

  setup(() => {
    fakeTransport = new FakeTransport();
    fakeProtocol = new FakeProtocol();

    client = new AcpClient({
      createTransport: () => fakeTransport as any,
      createProtocol: () => fakeProtocol as any,
    });

    // Skip settings file I/O in tests
    (client as any).updateIFlowCliModel = () => {};
    (client as any).updateIFlowCliApiConfig = () => {};

    // Avoid spawning real processes in unit tests.
    (client as any).processManager = {
      hasProcess: true,
      currentPort: null,
      stopManagedProcess: () => {},
      clearAutoDetectCache: () => {},
      resolveStartMode: async () => null,
      startManagedProcess: async () => 8090,
    };
  });

  teardown(async () => {
    try {
      await client.dispose();
    } catch {
      // no-op
    }
  });

  test("run sends ACP-compliant initialize/prompt payloads and streams chunks", async () => {
    let ended = false;
    let error: string | null = null;
    const chunks: any[] = [];

    const sessionId = await client.run(
      {
        prompt: "hello",
        attachedFiles: [],
        mode: "smart",
        think: false,
        model: "GLM-4.7" as any,
        cwd: "/tmp/workspace",
        fileAllowedDirs: ["/tmp/workspace"],
      },
      (chunk) => chunks.push(chunk),
      () => {
        ended = true;
      },
      (err) => {
        error = err;
      },
    );

    assert.strictEqual(error, null);
    assert.strictEqual(ended, true);
    assert.strictEqual(sessionId, "test-session-123");
    assert.ok(chunks.some((c) => c.chunkType === "text"));

    const initialize = fakeProtocol.requests.find(
      (r) => r.method === "initialize",
    );
    assert.ok(initialize);
    assert.deepStrictEqual(initialize?.params, {
      protocolVersion: 1,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
      },
    });

    const newSession = fakeProtocol.requests.find(
      (r) => r.method === "session/new",
    );
    assert.ok(newSession);
    assert.deepStrictEqual((newSession?.params as any)?.settings, {
      permission_mode: "smart",
      append_system_prompt: "",
      add_dirs: ["/tmp/workspace"],
    });

    const prompt = fakeProtocol.requests.find(
      (r) => r.method === "session/prompt",
    );
    assert.ok(prompt);
    assert.strictEqual((prompt?.params as any)?.sessionId, "test-session-123");
    assert.ok(Array.isArray((prompt?.params as any)?.prompt));
    assert.strictEqual((prompt?.params as any)?.prompt[0]?.type, "text");

    assert.ok(
      fakeProtocol.requests.some((r) => r.method === "session/set_mode"),
    );
    assert.ok(
      fakeProtocol.requests.some((r) => r.method === "session/set_model"),
    );
    assert.ok(
      fakeProtocol.requests.some((r) => r.method === "session/set_think"),
    );
  });

  test("run emits usage chunk when session/prompt result includes usage metadata", async () => {
    const chunks: any[] = [];

    const originalSendRequest = fakeProtocol.sendRequest.bind(fakeProtocol);
    fakeProtocol.sendRequest = async (method: string, params?: unknown) => {
      if (method === "session/prompt") {
        fakeProtocol.simulateUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello!" },
        });
        return {
          stopReason: "end_turn",
          usageMetadata: {
            promptTokenCount: 321,
            candidatesTokenCount: 12,
            totalTokenCount: 333,
          },
        };
      }
      return originalSendRequest(method, params);
    };

    await client.run(
      {
        prompt: "hello",
        attachedFiles: [],
        mode: "default",
        think: false,
        model: "GLM-4.7" as any,
      },
      (chunk) => chunks.push(chunk),
      () => {},
      () => {},
    );

    const usage = chunks.find((c) => c.chunkType === "usage");
    assert.ok(usage);
    assert.strictEqual(usage?.promptTokens, 321);
    assert.strictEqual(usage?.completionTokens, 12);
    assert.strictEqual(usage?.totalTokens, 333);
  });

  test("run emits usage chunk when usage is on session/update envelope", async () => {
    const chunks: any[] = [];

    const originalSendRequest = fakeProtocol.sendRequest.bind(fakeProtocol);
    fakeProtocol.sendRequest = async (method: string, params?: unknown) => {
      if (method === "session/prompt") {
        const handler = fakeProtocol.notificationHandlers.get("session/update");
        if (handler) {
          handler({
            sessionId: "test-session-123",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Hello!" },
            },
            usageMetadata: {
              promptTokenCount: 777,
              candidatesTokenCount: 21,
              totalTokenCount: 798,
            },
          });
        }
        return { stopReason: "end_turn" };
      }
      return originalSendRequest(method, params);
    };

    await client.run(
      {
        prompt: "hello",
        attachedFiles: [],
        mode: "default",
        think: false,
        model: "GLM-4.7" as any,
      },
      (chunk) => chunks.push(chunk),
      () => {},
      () => {},
    );

    const usage = chunks.find((c) => c.chunkType === "usage");
    assert.ok(usage);
    assert.strictEqual(usage?.promptTokens, 777);
    assert.strictEqual(usage?.completionTokens, 21);
    assert.strictEqual(usage?.totalTokens, 798);
  });

  test("run falls back to session/prompt result text when no session/update is emitted", async () => {
    const chunks: any[] = [];

    const originalSendRequest = fakeProtocol.sendRequest.bind(fakeProtocol);
    fakeProtocol.sendRequest = async (method: string, params?: unknown) => {
      if (method === "session/prompt") {
        return {
          stopReason: "end_turn",
          content: { type: "text", text: "Result-only fallback text." },
        };
      }
      return originalSendRequest(method, params);
    };

    await client.run(
      {
        prompt: "hello",
        attachedFiles: [],
        mode: "default",
        think: false,
        model: "GLM-4.7" as any,
      },
      (chunk) => chunks.push(chunk),
      () => {},
      () => {},
    );

    const textChunks = chunks.filter((c) => c.chunkType === "text");
    assert.strictEqual(textChunks.length, 1);
    assert.strictEqual(textChunks[0]?.content, "Result-only fallback text.");
  });

  test("run does not duplicate prompt-result text when session/update chunks exist", async () => {
    const chunks: any[] = [];

    const originalSendRequest = fakeProtocol.sendRequest.bind(fakeProtocol);
    fakeProtocol.sendRequest = async (method: string, params?: unknown) => {
      if (method === "session/prompt") {
        fakeProtocol.simulateUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Update text wins." },
        });
        return {
          stopReason: "end_turn",
          content: { type: "text", text: "Result fallback should be ignored." },
        };
      }
      return originalSendRequest(method, params);
    };

    await client.run(
      {
        prompt: "hello",
        attachedFiles: [],
        mode: "default",
        think: false,
        model: "GLM-4.7" as any,
      },
      (chunk) => chunks.push(chunk),
      () => {},
      () => {},
    );

    const textChunks = chunks.filter((c) => c.chunkType === "text");
    assert.strictEqual(textChunks.length, 1);
    assert.strictEqual(textChunks[0]?.content, "Update text wins.");
  });

  test("run recreates session and retries when prompt returns session not found", async () => {
    let ended = false;
    let error: string | null = null;
    const chunks: any[] = [];
    let promptCalls = 0;

    const originalSendRequest = fakeProtocol.sendRequest.bind(fakeProtocol);
    fakeProtocol.sendRequest = async (method: string, params?: unknown) => {
      if (method === "session/prompt") {
        promptCalls += 1;
        if (promptCalls === 1) {
          fakeProtocol.requests.push({ method, params });
          throw new Error(
            '[JSON-RPC -32600] Invalid request (data: {"details":"Session not found: stale-1"})',
          );
        }
      }
      return originalSendRequest(method, params);
    };

    const sessionId = await client.run(
      {
        prompt: "hello",
        attachedFiles: [],
        mode: "default",
        think: false,
        model: "GLM-4.7" as any,
      },
      (chunk) => chunks.push(chunk),
      () => {
        ended = true;
      },
      (err) => {
        error = err;
      },
    );

    assert.strictEqual(error, null);
    assert.strictEqual(ended, true);
    assert.strictEqual(sessionId, "test-session-123");
    assert.strictEqual(promptCalls, 2);
    assert.ok(
      fakeProtocol.requests.filter((r) => r.method === "session/new").length >=
        2,
    );
    assert.ok(chunks.some((c) => c.chunkType === "text"));
  });

  test("run falls back to new session when stored sessionId no longer exists", async () => {
    let ended = false;
    let error: string | null = null;
    const chunks: any[] = [];
    let loadCalls = 0;

    const originalSendRequest = fakeProtocol.sendRequest.bind(fakeProtocol);
    fakeProtocol.sendRequest = async (method: string, params?: unknown) => {
      if (method === "session/load") {
        loadCalls += 1;
        if (loadCalls === 1) {
          fakeProtocol.requests.push({ method, params });
          throw new Error(
            '[JSON-RPC -32600] Invalid request (data: {"details":"Session not found: persisted-1"})',
          );
        }
      }
      return originalSendRequest(method, params);
    };

    const sessionId = await client.run(
      {
        prompt: "resume session",
        attachedFiles: [],
        mode: "default",
        think: false,
        model: "GLM-4.7" as any,
        sessionId: "persisted-1",
      },
      (chunk) => chunks.push(chunk),
      () => {
        ended = true;
      },
      (err) => {
        error = err;
      },
    );

    assert.strictEqual(error, null);
    assert.strictEqual(ended, true);
    assert.strictEqual(sessionId, "test-session-123");
    assert.strictEqual(loadCalls, 1);
    assert.ok(fakeProtocol.requests.some((r) => r.method === "session/new"));
    assert.ok(chunks.some((c) => c.chunkType === "text"));
  });

  test("run sends thinkConfig when thinking is enabled", async () => {
    await client.run(
      {
        prompt: "hello",
        attachedFiles: [],
        mode: "default",
        think: true,
        model: "GLM-4.7" as any,
      },
      () => {},
      () => {},
      () => {},
    );

    const thinkRequest = fakeProtocol.requests.find(
      (r) => r.method === "session/set_think",
    );
    assert.ok(thinkRequest);
    assert.strictEqual((thinkRequest?.params as any)?.thinkEnabled, true);
    assert.strictEqual((thinkRequest?.params as any)?.thinkConfig, "think");
  });

  test("run succeeds without explicit fileAllowedDirs by falling back to cwd", async () => {
    let ended = false;
    let error: string | null = null;

    await client.run(
      {
        prompt: "fallback dirs",
        attachedFiles: [],
        mode: "default",
        think: false,
        model: "GLM-4.7" as any,
        cwd: "/tmp/workspace",
      },
      () => {},
      () => {
        ended = true;
      },
      (err) => {
        error = err;
      },
    );

    assert.strictEqual(error, null);
    assert.strictEqual(ended, true);
  });

  test("run recovers when task subagent remains in_progress without follow-up updates", async function () {
    this.timeout(5000);

    const chunks: any[] = [];
    let ended = false;
    let error: string | null = null;
    let promptCallCount = 0;
    const promptPayloads: unknown[] = [];

    (client as any).runExecutor.deps.getConfig = <T>(
      key: string,
      defaultValue: T,
    ): T => {
      if (key === "subagentInactivityTimeoutMs") {
        return 30 as T;
      }
      return defaultValue;
    };
    (client as any).runExecutor.deps.createInactivityGuard = (
      timeoutMs: number,
      onTimeout: () => void,
      log: (message: string) => void,
    ) => new InactivityGuard(timeoutMs, () => onTimeout(), log, 5);

    const originalSendRequest = fakeProtocol.sendRequest.bind(fakeProtocol);
    fakeProtocol.sendRequest = async (method: string, params?: unknown) => {
      if (method === "session/prompt") {
        promptCallCount += 1;
        promptPayloads.push(params);

        if (promptCallCount === 1) {
          fakeProtocol.simulateUpdate({
            sessionUpdate: "tool_call",
            status: "pending",
            toolName: "task",
            toolCallId: "call-task-1",
            title: "task",
          });
          fakeProtocol.simulateUpdate({
            sessionUpdate: "tool_call_update",
            status: "in_progress",
            toolName: "task",
            toolCallId: "call-task-1",
            title: "Launch agent(frontend-tester): Validate game",
            args: {
              subagent_type: "frontend-tester",
              description: "Validate game",
            },
          });
          return new Promise<unknown>(() => {});
        }

        fakeProtocol.simulateUpdate({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Recovered after stuck sub-agent cancellation.",
          },
        });
        return { stopReason: "end_turn" };
      }

      return originalSendRequest(method, params);
    };

    const sessionId = await client.run(
      {
        prompt: "validate red-alert game",
        attachedFiles: [],
        mode: "default",
        think: false,
        model: "GLM-4.7" as any,
      },
      (chunk) => chunks.push(chunk),
      () => {
        ended = true;
      },
      (err) => {
        error = err;
      },
    );

    assert.strictEqual(error, null);
    assert.strictEqual(ended, true);
    assert.strictEqual(sessionId, "test-session-123");
    assert.ok(
      promptCallCount >= 2,
      `expected at least 2 session/prompt calls, got ${promptCallCount}`,
    );
    assert.ok(fakeProtocol.requests.some((r) => r.method === "session/cancel"));
    assert.ok(promptPayloads.length >= 2);
    const recoveryPromptText = ((promptPayloads[1] as any)?.prompt?.[0]?.text ??
      "") as string;
    assert.ok(recoveryPromptText.includes("<system-reminder>"));
    assert.ok(recoveryPromptText.includes("automatically cancelled"));
    assert.ok(
      chunks.some(
        (chunk) =>
          chunk.chunkType === "warning" &&
          typeof chunk.message === "string" &&
          chunk.message.includes("appears stuck"),
      ),
    );
    assert.ok(
      chunks.some(
        (chunk) =>
          chunk.chunkType === "text" &&
          typeof chunk.content === "string" &&
          chunk.content.includes(
            "Recovered after stuck sub-agent cancellation.",
          ),
      ),
    );
  });

  test("connectWithRecovery only falls back to recoverMissingSession for missing session errors with sessionId", async () => {
    const baseOptions = {
      prompt: "hello",
      attachedFiles: [],
      mode: "default",
      think: false,
      model: "GLM-4.7" as any,
      sessionId: "persisted-1",
    };
    const recoveredProtocol = {
      sendRequest: async () => ({}),
    } as any;
    let recoverCalls = 0;

    const recoveredOptions = await connectWithRecovery(baseOptions as any, {
      ensureConnected: async () => {
        throw new Error("Session not found: persisted-1");
      },
      isMissingSessionError: (error: unknown) =>
        String((error as Error).message).includes("Session not found"),
      recoverMissingSession: async () => {
        recoverCalls += 1;
        return {
          protocol: recoveredProtocol,
          sessionId: "fresh-session-2",
        };
      },
      log: () => {},
    });

    assert.strictEqual(recoveredOptions.sessionId, "fresh-session-2");
    assert.strictEqual(recoverCalls, 1);

    await assert.rejects(
      connectWithRecovery(
        { ...baseOptions, sessionId: undefined } as any,
        {
          ensureConnected: async () => {
            throw new Error("Session not found: persisted-1");
          },
          isMissingSessionError: (error: unknown) =>
            String((error as Error).message).includes("Session not found"),
          recoverMissingSession: async () => {
            throw new Error("should not recover without sessionId");
          },
          log: () => {},
        },
      ),
    );
  });

  test("connectWithRecovery does not recover for non-missing-session errors", async () => {
    const baseOptions = {
      prompt: "hello",
      attachedFiles: [],
      mode: "default",
      think: false,
      model: "GLM-4.7" as any,
      sessionId: "persisted-1",
    };
    let recoverCalls = 0;

    await assert.rejects(
      connectWithRecovery(baseOptions as any, {
        ensureConnected: async () => {
          throw new Error("connection reset by peer");
        },
        isMissingSessionError: () => false,
        recoverMissingSession: async () => {
          recoverCalls += 1;
          return {
            protocol: {
              sendRequest: async () => ({}),
            } as any,
            sessionId: "fresh-session-2",
          };
        },
        log: () => {},
      }),
    );

    assert.strictEqual(recoverCalls, 0);
  });

  test("buildInactivityRecoveryPrompt keeps stable warning and reminder tokens", () => {
    const built = buildInactivityRecoveryPrompt(
      {
        name: "task",
        title: "Launch agent(frontend-tester): Validate game",
      },
      30,
    );

    assert.strictEqual(built.timeoutMinutes, 0);
    assert.ok(built.warningMessage.includes("appears stuck"));
    assert.ok(built.reminderPrompt.includes("<system-reminder>"));
    assert.ok(
      built.reminderPrompt.includes("automatically cancelled"),
      "expected recovery prompt to keep stable cancellation phrase",
    );
    assert.ok(
      built.reminderPrompt.includes('sub-agent "Launch agent(frontend-tester): Validate game"'),
    );
  });

  test("run executor facade stays under 500-line SIZE-01 limit", () => {
    const executorPath = path.resolve(
      __dirname,
      "../../src/acp/client/acpRunExecutor.ts",
    );
    const source = fs.readFileSync(executorPath, "utf8");
    const lineCount = (source.match(/\n/g) ?? []).length;
    assert.ok(
      lineCount < 500,
      `Expected src/acp/client/acpRunExecutor.ts to stay under 500 lines, got ${lineCount}`,
    );
  });

  test("permission server method emits tool_confirmation and uses server optionId", async () => {
    const chunks: any[] = [];

    const originalSendRequest = fakeProtocol.sendRequest.bind(fakeProtocol);
    fakeProtocol.sendRequest = async (method: string, params?: unknown) => {
      if (method === "session/prompt") {
        const waitPermission = fakeProtocol.simulateServerMethod(
          "session/request_permission",
          77,
          {
            options: [
              {
                optionId: "proceed_once",
                kind: "allow_once",
                name: "Allow once",
              },
              {
                optionId: "proceed_always",
                kind: "allow_always",
                name: "Always allow",
              },
            ],
            toolCall: {
              title: "Write file",
              toolName: "write_file",
              kind: "edit",
            },
          },
        );

        setTimeout(() => {
          void client.approveToolCall(77, "allow");
        }, 0);

        await waitPermission;
      }

      return originalSendRequest(method, params);
    };

    await client.run(
      {
        prompt: "hello",
        attachedFiles: [],
        mode: "default",
        think: false,
        model: "GLM-4.7" as any,
      },
      (chunk) => chunks.push(chunk),
      () => {},
      () => {},
    );

    const confirmation = chunks.find(
      (c) => c.chunkType === "tool_confirmation",
    );
    assert.ok(confirmation);
    assert.strictEqual(confirmation.requestId, 77);
    assert.strictEqual(confirmation.toolName, "write_file");
    assert.strictEqual(confirmation.confirmationType, "edit");
  });

  test("legacy _iflow/plan/exit server method emits plan_approval and resolves approval", async () => {
    const chunks: any[] = [];
    let resolvedPlanValue: unknown = null;

    const originalSendRequest = fakeProtocol.sendRequest.bind(fakeProtocol);
    fakeProtocol.sendRequest = async (method: string, params?: unknown) => {
      if (method === "session/prompt") {
        const waitPlan = fakeProtocol.simulateServerMethod(
          "_iflow/plan/exit",
          88,
          {
            plan: "1. Design\n2. Build\n3. Verify",
          },
        );

        setTimeout(() => {
          void client.approvePlan(88, true);
        }, 0);

        resolvedPlanValue = await waitPlan;
      }

      return originalSendRequest(method, params);
    };

    await client.run(
      {
        prompt: "make a plan",
        attachedFiles: [],
        mode: "plan",
        think: false,
        model: "GLM-4.7" as any,
      },
      (chunk) => chunks.push(chunk),
      () => {},
      () => {},
    );

    assert.deepStrictEqual(resolvedPlanValue, { approved: true });
    const planApproval = chunks.find((c) => c.chunkType === "plan_approval");
    assert.ok(planApproval);
    assert.strictEqual(planApproval.requestId, 88);
    assert.strictEqual(planApproval.plan, "1. Design\n2. Build\n3. Verify");
  });

  test("approveToolCall maps allow/alwaysAllow to server-provided option IDs", async () => {
    let allowValue: unknown = null;
    let alwaysValue: unknown = null;

    (client as any).pendingPermissions = new Map();
    (client as any).pendingPermissions.set(42, {
      kind: "permission",
      resolve: (value: unknown) => {
        allowValue = value;
      },
      options: [
        { optionId: "allow-once-id", kind: "allow_once" },
        { optionId: "allow-always-id", kind: "allow_always" },
      ],
    });

    await client.approveToolCall(42, "allow");
    assert.deepStrictEqual(allowValue, {
      outcome: { outcome: "selected", optionId: "allow-once-id" },
    });

    (client as any).pendingPermissions.set(43, {
      kind: "permission",
      resolve: (value: unknown) => {
        alwaysValue = value;
      },
      options: [
        { optionId: "allow-once-id", kind: "allow_once" },
        { optionId: "allow-always-id", kind: "allow_always" },
      ],
    });

    await client.approveToolCall(43, "alwaysAllow");
    assert.deepStrictEqual(alwaysValue, {
      outcome: { outcome: "selected", optionId: "allow-always-id" },
    });
  });

  test("rejectToolCall resolves pending permission with cancelled outcome", async () => {
    let resolvedValue: unknown = null;

    (client as any).pendingPermissions = new Map();
    (client as any).pendingPermissions.set(44, {
      kind: "permission",
      resolve: (value: unknown) => {
        resolvedValue = value;
      },
      options: [],
    });

    await client.rejectToolCall(44);
    assert.deepStrictEqual(resolvedValue, {
      outcome: { outcome: "cancelled" },
    });
  });

  test("answerQuestions resolves pending question request", async () => {
    let resolvedValue: unknown = null;

    (client as any).pendingPermissions = new Map();
    (client as any).pendingPermissions.set(45, {
      kind: "question",
      resolve: (value: unknown) => {
        resolvedValue = value;
      },
    });

    await client.answerQuestions(45, { q1: "yes" });
    assert.deepStrictEqual(resolvedValue, { answers: { q1: "yes" } });
  });

  test("approvePlan resolves pending plan request", async () => {
    let resolvedValue: unknown = null;

    (client as any).pendingPermissions = new Map();
    (client as any).pendingPermissions.set(46, {
      kind: "plan",
      resolve: (value: unknown) => {
        resolvedValue = value;
      },
    });

    await client.approvePlan(46, true);
    assert.deepStrictEqual(resolvedValue, { approved: true });
  });

  test("cancel sends session/cancel with sessionId", async () => {
    const coordinator = (client as any).sessionCoordinator;
    coordinator.setConnectionForTests({
      protocol: fakeProtocol,
      isConnected: true,
      sessionId: "test-session-123",
    });

    await client.cancel();

    const cancelReq = fakeProtocol.requests.find(
      (r) => r.method === "session/cancel",
    );
    assert.ok(cancelReq);
    assert.deepStrictEqual(cancelReq?.params, {
      sessionId: "test-session-123",
    });
  });

  test("oauth-iflow is preferred over iflow even when selectedAuthType is 'iflow'", async () => {
    // Reproduce the bug: when ~/.iflow/settings.json has selectedAuthType="iflow",
    // the extension was authenticating with "iflow" (API-key auth) before "oauth-iflow",
    // causing the CLI to return empty responses because no OAuth session was established.
    // The fix: selectedAuthType is only honoured when it is a custom/external auth type,
    // never for the built-in "iflow" method.

    // Override settingsRepository to simulate selectedAuthType="iflow" in settings
    (client as any).settingsRepository = {
      getSelectedAuthType: () => "iflow",
      updateModel: () => {},
      updateBaseUrl: () => {},
    };

    // Expose both auth methods so the resolution logic is exercised
    const originalSendRequest = fakeProtocol.sendRequest.bind(fakeProtocol);
    fakeProtocol.sendRequest = async (method: string, params?: unknown) => {
      if (method === "initialize") {
        return {
          isAuthenticated: false,
          authMethods: [{ id: "iflow" }, { id: "oauth-iflow" }],
        };
      }
      return originalSendRequest(method, params);
    };

    await client.run(
      {
        prompt: "hello",
        attachedFiles: [],
        mode: "default",
        think: false,
        model: "GLM-4.7" as any,
      },
      () => {},
      () => {},
      () => {},
    );

    // The first authenticate call must be for "oauth-iflow", not "iflow"
    const authRequests = fakeProtocol.requests.filter(
      (r) => r.method === "authenticate",
    );
    assert.ok(
      authRequests.length >= 1,
      "Expected at least one authenticate call",
    );
    assert.strictEqual(
      (authRequests[0]?.params as { methodId?: string } | undefined)?.methodId,
      "oauth-iflow",
      "oauth-iflow must be tried before iflow even when selectedAuthType='iflow'",
    );
  });
});
