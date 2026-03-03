import * as assert from "assert";
import { WebviewHandler, type WebviewHandlerDeps } from "../webviewHandler";
import type { WebviewMessage } from "../protocol";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import {
  createWebviewMessageHandlers,
  type WebviewMessageHandlerContext,
} from "../webview/messageHandler";
import { routeWebviewMessage } from "../webview/messageRouter";
import { createFileChangeActionHandler } from "../webview/fileChangeHandler";

class FakeMemento {
  private value: unknown;

  constructor(initialValue: unknown) {
    this.value = initialValue;
  }

  get<T>(key: string): T | undefined {
    if (key !== "iflow.conversations") {
      return undefined;
    }
    return this.value as T;
  }

  update(key: string, value: unknown): Thenable<void> {
    if (key === "iflow.conversations") {
      this.value = value;
    }
    return Promise.resolve();
  }
}

type WorkspaceFolderLike = { uri: { fsPath: string }; name: string };

interface HandlerTestHarness {
  handler: WebviewHandler;
  state: {
    workspaceFolders: WorkspaceFolderLike[] | undefined;
    findFilesImpl: (
      include: string,
      exclude: string,
      maxResults: number,
    ) => Promise<Array<{ fsPath: string }>>;
    getWorkspaceFolderImpl: (uri: {
      fsPath: string;
    }) => WorkspaceFolderLike | undefined;
    executeCommandImpl: (
      command: string,
      uri: { fsPath: string },
    ) => Promise<void>;
    errorMessages: string[];
  };
}

function createHarness(): HandlerTestHarness {
  const noopDisposable = { dispose() {} } as vscode.Disposable;
  const outputChannel = {
    appendLine() {},
    dispose() {},
  } as unknown as vscode.OutputChannel;

  const state: HandlerTestHarness["state"] = {
    workspaceFolders: [],
    findFilesImpl: async () => [],
    getWorkspaceFolderImpl: () => undefined,
    executeCommandImpl: async () => {},
    errorMessages: [],
  };

  const deps: Partial<WebviewHandlerDeps> = {
    getConfig: <T>(_key: string, defaultValue: T): T => defaultValue,
    getWorkspaceFolders: () =>
      state.workspaceFolders as unknown as
        | readonly vscode.WorkspaceFolder[]
        | undefined,
    onDidChangeConfiguration: () => noopDisposable,
    onDidChangeWorkspaceFolders: () => noopDisposable,
    findFiles: async (include, exclude, maxResults) => {
      const result = await state.findFilesImpl(
        String(include),
        String(exclude ?? ""),
        maxResults ?? 0,
      );
      return result as unknown as vscode.Uri[];
    },
    getWorkspaceFolder: (uri) =>
      state.getWorkspaceFolderImpl(
        uri as unknown as { fsPath: string },
      ) as unknown as vscode.WorkspaceFolder | undefined,
    getActiveTextEditor: () => undefined,
    onDidChangeActiveTextEditor: () => noopDisposable,
    onDidChangeTextEditorSelection: () => noopDisposable,
    showOpenDialog: async () => undefined,
    showInformationMessage: async () => undefined,
    showErrorMessage: async (message) => {
      state.errorMessages.push(message);
      return undefined;
    },
    createOutputChannel: () => outputChannel,
    executeCommand: async (command, ...rest) => {
      const uri = rest[0] as { fsPath: string };
      await state.executeCommandImpl(command, uri);
      return undefined;
    },
    registerTextDocumentContentProvider: () => noopDisposable,
  };

  const handler = new WebviewHandler(
    { fsPath: "/tmp/ext" } as unknown as vscode.Uri,
    new FakeMemento({
      currentId: null,
      conversations: [],
    }) as unknown as vscode.Memento,
    deps,
  );

  return { handler, state };
}

suite("WebviewHandler", () => {
  test("synthetic plan approval updates mode immediately", async () => {
    const { handler } = createHarness();

    await handler.handleMessage({
      type: "planApproval",
      requestId: -1,
      option: "smart",
    });

    const mode = handler.getStore().getCurrentConversation()?.mode;
    assert.strictEqual(mode, "smart");

    await handler.dispose();
  });

  test("getWorkspaceFileList passes limit to vscode.findFiles", async () => {
    const { handler, state } = createHarness();
    let capturedLimit = -1;

    state.workspaceFolders = [{ uri: { fsPath: "/root" }, name: "root" }];
    state.findFilesImpl = async (_include, _exclude, maxResults) => {
      capturedLimit = maxResults;
      return [{ fsPath: "/root/src/a.ts" }, { fsPath: "/root/src/b.ts" }];
    };
    state.getWorkspaceFolderImpl = () => state.workspaceFolders?.[0];

    const files = await (
      handler as unknown as {
        workspaceFileService: {
          getWorkspaceFileList: (
            cwd?: string,
            limit?: number,
          ) => Promise<string[]>;
        };
      }
    ).workspaceFileService.getWorkspaceFileList("/root", 12);

    assert.strictEqual(capturedLimit, 12);
    assert.deepStrictEqual(files, ["src/a.ts", "src/b.ts"]);
    await handler.dispose();
  });

  test("getWorkspaceFileList keeps multi-root prefix behavior", async () => {
    const { handler, state } = createHarness();

    state.workspaceFolders = [
      { uri: { fsPath: "/root-a" }, name: "A" },
      { uri: { fsPath: "/root-b" }, name: "B" },
    ];
    state.findFilesImpl = async () => [
      { fsPath: "/root-a/src/in-a.ts" },
      { fsPath: "/root-b/src/in-b.ts" },
    ];
    state.getWorkspaceFolderImpl = (uri) => {
      if (uri.fsPath.startsWith("/root-a/")) {
        return state.workspaceFolders?.[0];
      }
      if (uri.fsPath.startsWith("/root-b/")) {
        return state.workspaceFolders?.[1];
      }
      return undefined;
    };

    const files = await (
      handler as unknown as {
        workspaceFileService: {
          getWorkspaceFileList: (
            cwd?: string,
            limit?: number,
          ) => Promise<string[]>;
        };
      }
    ).workspaceFileService.getWorkspaceFileList("/root-a", 20);

    assert.deepStrictEqual(files, ["src/in-a.ts", "[B] src/in-b.ts"]);
    await handler.dispose();
  });

  test("workspaceFileService.openFile rejects path outside workspace folders", async () => {
    const { handler, state } = createHarness();
    state.workspaceFolders = [{ uri: { fsPath: "/tmp" }, name: "workspace" }];

    let opened = false;
    state.executeCommandImpl = async () => {
      opened = true;
    };

    await assert.rejects(async () => {
      await (
        handler as unknown as {
          workspaceFileService: {
            openFile: (filePath: string) => Promise<void>;
          };
        }
      ).workspaceFileService.openFile("/etc/passwd");
    }, /outside workspace folders/);

    assert.strictEqual(opened, false);
    await handler.dispose();
  });

  test("workspaceFileService.readFiles reads files inside workspace folder", async () => {
    const { handler, state } = createHarness();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-wvh-test-"));
    const filePath = path.join(tempDir, "inside.txt");
    fs.writeFileSync(filePath, "hello from workspace", "utf-8");

    state.workspaceFolders = [{ uri: { fsPath: tempDir }, name: "workspace" }];

    try {
      const files = await (
        handler as unknown as {
          workspaceFileService: {
            readFiles: (
              paths: string[],
            ) => Promise<Array<{ path: string; content?: string }>>;
          };
        }
      ).workspaceFileService.readFiles([filePath]);

      assert.strictEqual(files.length, 1);
      assert.strictEqual(files[0].path, filePath);
      assert.strictEqual(files[0].content, "hello from workspace");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      await handler.dispose();
    }
  });

  test("workspaceFileService.readFiles rejects files outside workspace folders", async () => {
    const { handler, state } = createHarness();
    state.workspaceFolders = [{ uri: { fsPath: "/tmp" }, name: "workspace" }];

    const files = await (
      handler as unknown as {
        workspaceFileService: {
          readFiles: (paths: string[]) => Promise<Array<{ content?: string }>>;
        };
      }
    ).workspaceFileService.readFiles(["/etc/passwd"]);

    assert.strictEqual(files.length, 1);
    assert.ok(files[0].content?.startsWith("["));
    await handler.dispose();
  });

  test("handleMessage catches unexpected handler errors", async () => {
    const { handler } = createHarness();

    await assert.doesNotReject(async () => {
      await handler.handleMessage({
        type: "sendMessage",
        content: undefined,
        attachedFiles: [],
      } as unknown as WebviewMessage);
    });

    await handler.dispose();
  });

  test("fileChangeAction approve updates summary status and posts roundFileChanges", async () => {
    const { handler } = createHarness();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-wvh-diff-"));
    const filePath = path.join(tempDir, "sample.ts");
    fs.writeFileSync(filePath, "before\n", "utf-8");

    const posted: unknown[] = [];
    (
      handler as unknown as { postMessage: (message: unknown) => void }
    ).postMessage = (message) => {
      posted.push(message);
    };

    try {
      const reviewService = (
        handler as unknown as {
          fileChangeReviewService: {
            startRun: (context: {
              conversationId: string;
              assistantMessageId: string;
              cwd?: string;
              allowedDirs: string[];
            }) => void;
            onChunk: (chunk: unknown) => void;
            finalizeRun: (context: {
              conversationId: string;
              assistantMessageId: string;
              succeeded: boolean;
            }) => unknown;
          };
        }
      ).fileChangeReviewService;

      reviewService.startRun({
        conversationId: "conv-1",
        assistantMessageId: "msg-1",
        cwd: tempDir,
        allowedDirs: [tempDir],
      });
      reviewService.onChunk({
        chunkType: "tool_start",
        name: "write_file",
        input: { file_path: filePath },
      });
      fs.writeFileSync(filePath, "after\nline2\n", "utf-8");
      reviewService.onChunk({
        chunkType: "tool_end",
        status: "completed",
      });
      reviewService.finalizeRun({
        conversationId: "conv-1",
        assistantMessageId: "msg-1",
        succeeded: true,
      });

      await handler.handleMessage({
        type: "fileChangeAction",
        action: "approve",
        conversationId: "conv-1",
        assistantMessageId: "msg-1",
        path: filePath,
      });

      const roundSummary = posted.find((entry) => {
        return (
          Boolean(entry) &&
          typeof entry === "object" &&
          (entry as { type?: string }).type === "roundFileChanges"
        );
      }) as
        | { type: string; summary: { changedFiles: Array<{ status: string }> } }
        | undefined;
      assert.ok(roundSummary);
      assert.strictEqual(
        roundSummary?.summary.changedFiles[0]?.status,
        "accepted",
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      await handler.dispose();
    }
  });

  test("fileChangeAction failure shows error message and keeps extension alive", async () => {
    const { handler, state } = createHarness();

    await assert.doesNotReject(async () => {
      await handler.handleMessage({
        type: "fileChangeAction",
        action: "rollback",
        conversationId: "missing",
        assistantMessageId: "missing",
        path: "/tmp/none.ts",
      });
    });

    assert.strictEqual(state.errorMessages.length, 1);
    await handler.dispose();
  });

  test("file change handler posts roundFileChanges summary on success", async () => {
    const message: Extract<WebviewMessage, { type: "fileChangeAction" }> = {
      type: "fileChangeAction",
      action: "approve",
      conversationId: "conv-1",
      assistantMessageId: "msg-1",
      path: "/tmp/file.ts",
    };
    const postedSummaries: Array<{ changedFiles: Array<{ status: string }> }> =
      [];
    const actionHandler = createFileChangeActionHandler({
      handleAction: async () => ({
        conversationId: "conv-1",
        assistantMessageId: "msg-1",
        changedFiles: [
          { path: "/tmp/file.ts", status: "accepted", operation: "create" },
        ],
      }),
      postRoundFileChanges: (summary) => {
        postedSummaries.push(summary);
      },
      debug: () => {},
      showErrorMessage: async () => undefined,
    });

    await actionHandler(message);

    assert.strictEqual(postedSummaries.length, 1);
    assert.strictEqual(postedSummaries[0].changedFiles[0].status, "accepted");
  });

  test("file change handler wraps errors and surfaces message", async () => {
    const message: Extract<WebviewMessage, { type: "fileChangeAction" }> = {
      type: "fileChangeAction",
      action: "rollback",
      conversationId: "conv-1",
      assistantMessageId: "msg-1",
      path: "/tmp/file.ts",
    };
    const debugMessages: string[] = [];
    const shownErrors: string[] = [];
    const actionHandler = createFileChangeActionHandler({
      handleAction: async () => {
        throw new Error("no change summary");
      },
      postRoundFileChanges: () => {},
      debug: (entry) => {
        debugMessages.push(entry);
      },
      showErrorMessage: async (entry) => {
        shownErrors.push(entry);
        return undefined;
      },
    });

    await actionHandler(message);

    assert.strictEqual(shownErrors.length, 1);
    assert.ok(shownErrors[0].includes("no change summary"));
    assert.strictEqual(debugMessages.length, 1);
    assert.ok(
      debugMessages[0].startsWith("fileChangeAction failed (rollback): "),
    );
  });

  test("message handler factory preserves ready and unknown-message routing behavior", async () => {
    const callOrder: string[] = [];
    const context = {
      syncWorkspaceFolders: () => {
        callOrder.push("syncWorkspaceFolders");
      },
      postStateUpdated: () => {
        callOrder.push("postStateUpdated");
      },
      pushIdeContext: () => {
        callOrder.push("pushIdeContext");
      },
    } as unknown as WebviewMessageHandlerContext;

    const handlers = createWebviewMessageHandlers(context);
    const unhandled: string[] = [];

    const readyHandled = await routeWebviewMessage(
      { type: "ready" },
      handlers,
      (messageType) => {
        unhandled.push(messageType);
      },
    );
    const unknownHandled = await routeWebviewMessage(
      { type: "pickFiles" },
      {},
      (messageType) => {
        unhandled.push(messageType);
      },
    );

    assert.strictEqual(readyHandled, true);
    assert.deepStrictEqual(callOrder, [
      "syncWorkspaceFolders",
      "postStateUpdated",
      "pushIdeContext",
    ]);
    assert.strictEqual(unknownHandled, false);
    assert.deepStrictEqual(unhandled, ["pickFiles"]);
  });
});
