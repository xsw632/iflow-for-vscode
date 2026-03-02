import * as assert from 'assert';
import { SendMessagePipeline } from '../webview/sendMessagePipeline';
import { ConversationStore } from '../store';
import { PlanApprovalCoordinator } from '../webview/planApprovalCoordinator';
import { PlanModeOrchestrator } from '../webview/planModeOrchestrator';
import { ConversationState, ExtensionMessage, StreamChunk } from '../protocol';
import { RunOptions } from '../acp/types';

class FakeMemento {
  private value: unknown;

  constructor(initialValue: unknown) {
    this.value = initialValue;
  }

  get<T>(key: string): T | undefined {
    if (key !== 'iflow.conversations') {
      return undefined;
    }
    return this.value as T;
  }

  update(key: string, value: unknown): Thenable<void> {
    if (key === 'iflow.conversations') {
      this.value = value;
    }
    return Promise.resolve();
  }
}

type RunImplementation = (
  options: RunOptions,
  onChunk: (chunk: StreamChunk) => void,
  onEnd: () => void,
  onError: (error: string) => void,
) => Promise<string | undefined>;

class FakeClient {
  runCalls: RunOptions[] = [];

  constructor(private readonly impl?: RunImplementation) {}

  async run(
    options: RunOptions,
    onChunk: (chunk: StreamChunk) => void,
    onEnd: () => void,
    onError: (error: string) => void,
  ): Promise<string | undefined> {
    this.runCalls.push(options);
    if (this.impl) {
      return this.impl(options, onChunk, onEnd, onError);
    }
    onEnd();
    return `session-${this.runCalls.length}`;
  }
}

function createStore(onStateChange?: (state: ConversationState) => void): ConversationStore {
  const store = new ConversationStore(
    new FakeMemento({ currentId: null, conversations: [] }) as unknown as import('vscode').Memento,
    (state) => {
      onStateChange?.(state);
    },
  );
  store.newConversation();
  return store;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

suite('SendMessagePipeline', () => {
  test('emits streamStatus phases while waiting for first chunk', async () => {
    const store = createStore();
    const messages: ExtensionMessage[] = [];
    const client = new FakeClient(async (_options, onChunk, onEnd) => {
      await sleep(350);
      onChunk({ chunkType: 'text', content: 'hello' });
      onEnd();
      return 'session-1';
    });

    const pipeline = new SendMessagePipeline({
      store,
      client: client as unknown as import('../acpClient').AcpClient,
      postMessage: (message) => messages.push(message),
      markCliUnavailable: () => {},
      resolveWorkspaceFolder: () => '/tmp/workspace',
      getAllWorkspaceFolderPaths: () => ['/tmp/workspace'],
      getWorkspaceFileList: async () => [],
      shouldIncludeWorkspaceFiles: () => false,
      getWorkspaceFilesLimit: () => 80,
      getStreamRenderIntervalMs: () => 50,
      planApprovalCoordinator: new PlanApprovalCoordinator(new PlanModeOrchestrator()),
      debug: () => {},
      setSessionId: (sessionId) => store.setSessionId(sessionId),
    });

    await pipeline.execute({
      content: 'slow first chunk',
      attachedFiles: [],
      silent: false,
    });

    const phases = messages
      .filter((m): m is Extract<ExtensionMessage, { type: 'streamStatus' }> => m.type === 'streamStatus')
      .map((m) => m.phase);
    assert.deepStrictEqual(phases, ['preparing', 'connecting', 'waiting_first_chunk']);
    assert.ok(messages.some((m) => m.type === 'streamChunk'));
    assert.ok(messages.some((m) => m.type === 'streamEnd'));
  });

  test('skips workspace file scan when autoIncludeWorkspaceFiles is disabled', async () => {
    const store = createStore();
    const client = new FakeClient();
    let workspaceFileListCalls = 0;

    const pipeline = new SendMessagePipeline({
      store,
      client: client as unknown as import('../acpClient').AcpClient,
      postMessage: () => {},
      markCliUnavailable: () => {},
      resolveWorkspaceFolder: () => '/tmp/workspace',
      getAllWorkspaceFolderPaths: () => ['/tmp/workspace'],
      getWorkspaceFileList: async () => {
        workspaceFileListCalls += 1;
        return ['should-not-be-used.ts'];
      },
      shouldIncludeWorkspaceFiles: () => false,
      getWorkspaceFilesLimit: () => 80,
      getStreamRenderIntervalMs: () => 50,
      planApprovalCoordinator: new PlanApprovalCoordinator(new PlanModeOrchestrator()),
      debug: () => {},
      setSessionId: (sessionId) => store.setSessionId(sessionId),
    });

    await pipeline.execute({
      content: 'no workspace scan',
      attachedFiles: [],
      silent: false,
    });

    assert.strictEqual(workspaceFileListCalls, 0);
    assert.deepStrictEqual(client.runCalls[0]?.workspaceFiles, []);
  });

  test('uses configured workspace file limit when autoIncludeWorkspaceFiles is enabled', async () => {
    const store = createStore();
    const client = new FakeClient();
    let capturedLimit: number | undefined;

    const pipeline = new SendMessagePipeline({
      store,
      client: client as unknown as import('../acpClient').AcpClient,
      postMessage: () => {},
      markCliUnavailable: () => {},
      resolveWorkspaceFolder: () => '/tmp/workspace',
      getAllWorkspaceFolderPaths: () => ['/tmp/workspace'],
      getWorkspaceFileList: async (_cwd, limit) => {
        capturedLimit = limit;
        return ['src/main.ts'];
      },
      shouldIncludeWorkspaceFiles: () => true,
      getWorkspaceFilesLimit: () => 42,
      getStreamRenderIntervalMs: () => 50,
      planApprovalCoordinator: new PlanApprovalCoordinator(new PlanModeOrchestrator()),
      debug: () => {},
      setSessionId: (sessionId) => store.setSessionId(sessionId),
    });

    await pipeline.execute({
      content: 'with workspace scan',
      attachedFiles: [],
      silent: false,
    });

    assert.strictEqual(capturedLimit, 42);
    assert.deepStrictEqual(client.runCalls[0]?.workspaceFiles, ['src/main.ts']);
  });

  test('adds Re-check CLI hint when connectivity error occurs', async () => {
    const store = createStore();
    const messages: ExtensionMessage[] = [];
    const markCliUnavailableCalls: string[] = [];
    const failingClient = new FakeClient(async (_options, _onChunk, _onEnd, onError) => {
      onError('connect ECONNREFUSED 127.0.0.1:8090');
      return undefined;
    });

    const pipeline = new SendMessagePipeline({
      store,
      client: failingClient as unknown as import('../acpClient').AcpClient,
      postMessage: (message) => messages.push(message),
      markCliUnavailable: (diagnostics) => {
        markCliUnavailableCalls.push(diagnostics);
      },
      resolveWorkspaceFolder: () => '/tmp/workspace',
      getAllWorkspaceFolderPaths: () => ['/tmp/workspace'],
      getWorkspaceFileList: async () => [],
      shouldIncludeWorkspaceFiles: () => false,
      getWorkspaceFilesLimit: () => 80,
      getStreamRenderIntervalMs: () => 50,
      planApprovalCoordinator: new PlanApprovalCoordinator(new PlanModeOrchestrator()),
      debug: () => {},
      setSessionId: (sessionId) => store.setSessionId(sessionId),
    });

    await pipeline.execute({
      content: 'trigger connect error',
      attachedFiles: [],
      silent: false,
    });

    assert.strictEqual(markCliUnavailableCalls.length, 1);
    const streamError = messages.find((m) => m.type === 'streamError') as Extract<ExtensionMessage, { type: 'streamError' }> | undefined;
    assert.ok(streamError);
    assert.ok(streamError?.error.includes('Re-check CLI'));
    assert.strictEqual(failingClient.runCalls.length, 1);
  });

  test('does not mark CLI unavailable on session-not-found and clears stored session id', async () => {
    const store = createStore();
    store.setSessionId('stale-session-1');
    const messages: ExtensionMessage[] = [];
    const markCliUnavailableCalls: string[] = [];
    const failingClient = new FakeClient(async (_options, _onChunk, _onEnd, onError) => {
      onError('[JSON-RPC -32600] Invalid request (data: {"details":"Session not found: stale-session-1"})');
      return undefined;
    });

    const pipeline = new SendMessagePipeline({
      store,
      client: failingClient as unknown as import('../acpClient').AcpClient,
      postMessage: (message) => messages.push(message),
      markCliUnavailable: (diagnostics) => {
        markCliUnavailableCalls.push(diagnostics);
      },
      clearSessionId: () => store.clearSessionId(),
      resolveWorkspaceFolder: () => '/tmp/workspace',
      getAllWorkspaceFolderPaths: () => ['/tmp/workspace'],
      getWorkspaceFileList: async () => [],
      shouldIncludeWorkspaceFiles: () => false,
      getWorkspaceFilesLimit: () => 80,
      getStreamRenderIntervalMs: () => 50,
      planApprovalCoordinator: new PlanApprovalCoordinator(new PlanModeOrchestrator()),
      debug: () => {},
      setSessionId: (sessionId) => store.setSessionId(sessionId),
    });

    await pipeline.execute({
      content: 'trigger session missing',
      attachedFiles: [],
      silent: false,
    });

    assert.strictEqual(markCliUnavailableCalls.length, 0);
    assert.strictEqual(store.getCurrentConversation()?.sessionId, undefined);
    const streamError = messages.find((m) => m.type === 'streamError') as Extract<ExtensionMessage, { type: 'streamError' }> | undefined;
    assert.ok(streamError);
    assert.ok(!streamError?.error.includes('Re-check CLI'));
  });

  test('opens synthetic plan approval when run ends without server plan_approval chunk', async () => {
    const store = createStore();
    store.setMode('plan');

    const client = new FakeClient(async (options, _onChunk, onEnd) => {
      onEnd();
      return `session-${options.mode}`;
    });

    const messages: ExtensionMessage[] = [];
    const planApprovalCoordinator = new PlanApprovalCoordinator(new PlanModeOrchestrator());
    const pipeline = new SendMessagePipeline({
      store,
      client: client as unknown as import('../acpClient').AcpClient,
      postMessage: (message) => {
        messages.push(message);
        if (message.type === 'streamChunk'
          && message.chunk.chunkType === 'plan_approval'
          && message.chunk.requestId === -1) {
          planApprovalCoordinator.registerSyntheticApproval('keep');
        }
      },
      markCliUnavailable: () => {},
      resolveWorkspaceFolder: () => '/tmp/workspace',
      getAllWorkspaceFolderPaths: () => ['/tmp/workspace'],
      getWorkspaceFileList: async () => [],
      shouldIncludeWorkspaceFiles: () => false,
      getWorkspaceFilesLimit: () => 80,
      getStreamRenderIntervalMs: () => 50,
      planApprovalCoordinator,
      debug: () => {},
      setSessionId: (sessionId) => store.setSessionId(sessionId),
    });

    await pipeline.execute({
      content: 'plan this work',
      attachedFiles: [],
      silent: false,
    });

    assert.strictEqual(client.runCalls.length, 1);
    assert.strictEqual(client.runCalls[0].mode, 'plan');
    assert.strictEqual(store.getCurrentConversation()?.mode, 'plan');
    assert.ok(messages.some(
      (m) => m.type === 'streamChunk'
        && m.chunk.chunkType === 'plan_approval'
        && m.chunk.requestId === -1
    ));
  });

  test('replays approved server plan via queue without recursive send', async () => {
    const store = createStore();
    store.setMode('plan');

    const client = new FakeClient(async (options, onChunk, onEnd) => {
      if (options.mode === 'plan') {
        onChunk({ chunkType: 'plan_approval', requestId: 42, plan: 'final plan' });
      }
      onEnd();
      return `session-${options.mode}`;
    });

    const messages: ExtensionMessage[] = [];
    const planApprovalCoordinator = new PlanApprovalCoordinator(new PlanModeOrchestrator());

    const pipeline = new SendMessagePipeline({
      store,
      client: client as unknown as import('../acpClient').AcpClient,
      postMessage: (message) => {
        messages.push(message);
        if (message.type === 'streamChunk'
          && message.chunk.chunkType === 'plan_approval'
          && message.chunk.requestId === 42) {
          planApprovalCoordinator.registerServerApproval('smart');
        }
      },
      markCliUnavailable: () => {},
      resolveWorkspaceFolder: () => '/tmp/workspace',
      getAllWorkspaceFolderPaths: () => ['/tmp/workspace'],
      getWorkspaceFileList: async () => [],
      shouldIncludeWorkspaceFiles: () => false,
      getWorkspaceFilesLimit: () => 80,
      getStreamRenderIntervalMs: () => 50,
      planApprovalCoordinator,
      debug: () => {},
      setSessionId: (sessionId) => store.setSessionId(sessionId),
    });

    await pipeline.execute({
      content: 'plan this work',
      attachedFiles: [],
      silent: false,
    });

    assert.strictEqual(client.runCalls.length, 2);
    assert.strictEqual(client.runCalls[0].mode, 'plan');
    assert.strictEqual(client.runCalls[1].mode, 'smart');
    assert.ok(client.runCalls[1].prompt.includes('system-reminder'));
    assert.ok(messages.some(
      (m) => m.type === 'streamChunk'
        && m.chunk.chunkType === 'plan_approval'
        && m.chunk.requestId === 42
    ));
  });

  test('normalizes empty runtime errors before emitting streamError', async () => {
    const store = createStore();
    const messages: ExtensionMessage[] = [];
    const failingClient = new FakeClient(async (_options, _onChunk, _onEnd, onError) => {
      onError('   ');
      return undefined;
    });

    const pipeline = new SendMessagePipeline({
      store,
      client: failingClient as unknown as import('../acpClient').AcpClient,
      postMessage: (message) => messages.push(message),
      markCliUnavailable: () => {},
      resolveWorkspaceFolder: () => '/tmp/workspace',
      getAllWorkspaceFolderPaths: () => ['/tmp/workspace'],
      getWorkspaceFileList: async () => [],
      shouldIncludeWorkspaceFiles: () => false,
      getWorkspaceFilesLimit: () => 80,
      getStreamRenderIntervalMs: () => 50,
      planApprovalCoordinator: new PlanApprovalCoordinator(new PlanModeOrchestrator()),
      debug: () => {},
      setSessionId: (sessionId) => store.setSessionId(sessionId),
    });

    await pipeline.execute({
      content: 'trigger error',
      attachedFiles: [],
      silent: false,
    });

    const streamError = messages.find((m) => m.type === 'streamError') as Extract<ExtensionMessage, { type: 'streamError' }> | undefined;
    assert.ok(streamError);
    assert.strictEqual(streamError?.error, 'Unknown error');
  });

  test('throttles stateUpdated during streaming while preserving streamChunk count', async () => {
    const messages: ExtensionMessage[] = [];
    const store = createStore((state) => {
      messages.push({ type: 'stateUpdated', state });
    });

    const client = new FakeClient(async (_options, onChunk, onEnd) => {
      onChunk({ chunkType: 'text', content: 'a' });
      await sleep(5);
      onChunk({ chunkType: 'text', content: 'b' });
      await sleep(5);
      onChunk({ chunkType: 'text', content: 'c' });
      await sleep(40);
      onChunk({ chunkType: 'text', content: 'd' });
      await sleep(5);
      onChunk({ chunkType: 'text', content: 'e' });
      onEnd();
      return undefined;
    });

    const pipeline = new SendMessagePipeline({
      store,
      client: client as unknown as import('../acpClient').AcpClient,
      postMessage: (message) => messages.push(message),
      markCliUnavailable: () => {},
      resolveWorkspaceFolder: () => '/tmp/workspace',
      getAllWorkspaceFolderPaths: () => ['/tmp/workspace'],
      getWorkspaceFileList: async () => [],
      shouldIncludeWorkspaceFiles: () => false,
      getWorkspaceFilesLimit: () => 80,
      getStreamRenderIntervalMs: () => 30,
      planApprovalCoordinator: new PlanApprovalCoordinator(new PlanModeOrchestrator()),
      debug: () => {},
      setSessionId: (sessionId) => store.setSessionId(sessionId),
    });

    await pipeline.execute({
      content: 'throttled output',
      attachedFiles: [],
      silent: false,
    });

    const streamChunks = messages.filter(
      (m): m is Extract<ExtensionMessage, { type: 'streamChunk' }> => m.type === 'streamChunk'
    );
    assert.strictEqual(streamChunks.length, 5);

    const stateUpdates = messages.filter(
      (m): m is Extract<ExtensionMessage, { type: 'stateUpdated' }> => m.type === 'stateUpdated'
    );
    const streamingStateUpdates = stateUpdates.filter((m) => m.state.isStreaming);
    assert.ok(streamingStateUpdates.length >= 2);
    assert.ok(streamingStateUpdates.length < streamChunks.length);

    const beforeWaitCount = stateUpdates.length;
    await sleep(80);
    const afterWaitCount = messages.filter((m) => m.type === 'stateUpdated').length;
    assert.strictEqual(afterWaitCount, beforeWaitCount);
  });

  test('cleans up pending throttled updates on streamError', async () => {
    const messages: ExtensionMessage[] = [];
    const store = createStore((state) => {
      messages.push({ type: 'stateUpdated', state });
    });

    const failingClient = new FakeClient(async (_options, onChunk, _onEnd, onError) => {
      onChunk({ chunkType: 'text', content: 'partial' });
      onError('connect ECONNREFUSED 127.0.0.1:8090');
      return undefined;
    });

    const pipeline = new SendMessagePipeline({
      store,
      client: failingClient as unknown as import('../acpClient').AcpClient,
      postMessage: (message) => messages.push(message),
      markCliUnavailable: () => {},
      resolveWorkspaceFolder: () => '/tmp/workspace',
      getAllWorkspaceFolderPaths: () => ['/tmp/workspace'],
      getWorkspaceFileList: async () => [],
      shouldIncludeWorkspaceFiles: () => false,
      getWorkspaceFilesLimit: () => 80,
      getStreamRenderIntervalMs: () => 30,
      planApprovalCoordinator: new PlanApprovalCoordinator(new PlanModeOrchestrator()),
      debug: () => {},
      setSessionId: (sessionId) => store.setSessionId(sessionId),
    });

    await pipeline.execute({
      content: 'trigger error cleanup',
      attachedFiles: [],
      silent: false,
    });

    const stateUpdates = messages.filter(
      (m): m is Extract<ExtensionMessage, { type: 'stateUpdated' }> => m.type === 'stateUpdated'
    );
    assert.ok(stateUpdates.length > 0);
    assert.strictEqual(stateUpdates[stateUpdates.length - 1].state.isStreaming, false);

    const beforeWaitCount = stateUpdates.length;
    await sleep(80);
    const afterWaitCount = messages.filter((m) => m.type === 'stateUpdated').length;
    assert.strictEqual(afterWaitCount, beforeWaitCount);
  });

  test('run hooks are called in start/chunk/finalize order on success', async () => {
    const store = createStore();
    const calls: string[] = [];
    const client = new FakeClient(async (_options, onChunk, onEnd) => {
      onChunk({ chunkType: 'text', content: 'ok' });
      onEnd();
      return 'session-success';
    });

    const pipeline = new SendMessagePipeline({
      store,
      client: client as unknown as import('../acpClient').AcpClient,
      postMessage: () => {},
      markCliUnavailable: () => {},
      resolveWorkspaceFolder: () => '/tmp/workspace',
      getAllWorkspaceFolderPaths: () => ['/tmp/workspace'],
      getWorkspaceFileList: async () => [],
      shouldIncludeWorkspaceFiles: () => false,
      getWorkspaceFilesLimit: () => 80,
      getStreamRenderIntervalMs: () => 50,
      planApprovalCoordinator: new PlanApprovalCoordinator(new PlanModeOrchestrator()),
      debug: () => {},
      setSessionId: (sessionId) => store.setSessionId(sessionId),
      onRunStart: () => calls.push('start'),
      onChunk: () => calls.push('chunk'),
      onRunFinalize: (context) => calls.push(context.succeeded ? 'finalize:success' : 'finalize:error'),
    });

    await pipeline.execute({
      content: 'hook success',
      attachedFiles: [],
      silent: false,
    });

    assert.deepStrictEqual(calls, ['start', 'chunk', 'finalize:success']);
  });

  test('run finalize hook is called on error', async () => {
    const store = createStore();
    const calls: string[] = [];
    const client = new FakeClient(async (_options, _onChunk, _onEnd, onError) => {
      onError('fatal');
      return undefined;
    });

    const pipeline = new SendMessagePipeline({
      store,
      client: client as unknown as import('../acpClient').AcpClient,
      postMessage: () => {},
      markCliUnavailable: () => {},
      resolveWorkspaceFolder: () => '/tmp/workspace',
      getAllWorkspaceFolderPaths: () => ['/tmp/workspace'],
      getWorkspaceFileList: async () => [],
      shouldIncludeWorkspaceFiles: () => false,
      getWorkspaceFilesLimit: () => 80,
      getStreamRenderIntervalMs: () => 50,
      planApprovalCoordinator: new PlanApprovalCoordinator(new PlanModeOrchestrator()),
      debug: () => {},
      setSessionId: (sessionId) => store.setSessionId(sessionId),
      onRunStart: () => calls.push('start'),
      onRunFinalize: (context) => calls.push(context.succeeded ? 'finalize:success' : 'finalize:error'),
    });

    await pipeline.execute({
      content: 'hook error',
      attachedFiles: [],
      silent: false,
    });

    assert.deepStrictEqual(calls, ['start', 'finalize:error']);
  });

  test('fails fast with INVALID_FILES before context/model checks and does not run client', async () => {
    const store = createStore();
    store.setModel('invalid-model' as unknown as import('../protocol').ModelType);
    const messages: ExtensionMessage[] = [];
    const client = new FakeClient();

    const pipeline = new SendMessagePipeline({
      store,
      client: client as unknown as import('../acpClient').AcpClient,
      postMessage: (message) => messages.push(message),
      markCliUnavailable: () => {},
      resolveWorkspaceFolder: () => '/tmp/workspace',
      getAllWorkspaceFolderPaths: () => ['/tmp/workspace'],
      getWorkspaceFileList: async () => [],
      shouldIncludeWorkspaceFiles: () => false,
      getWorkspaceFilesLimit: () => 80,
      getStreamRenderIntervalMs: () => 50,
      planApprovalCoordinator: new PlanApprovalCoordinator(new PlanModeOrchestrator()),
      debug: () => {},
      setSessionId: (sessionId) => store.setSessionId(sessionId),
    });

    await pipeline.execute({
      content: 'invalid files first',
      attachedFiles: [{ path: '   ' }],
      silent: false,
      ideContext: {
        activeFile: { path: '', name: 'bad.ts' },
        selection: null,
      },
    });

    const streamError = messages.find((m) => m.type === 'streamError') as Extract<ExtensionMessage, { type: 'streamError' }> | undefined;
    assert.ok(streamError);
    assert.ok(streamError?.error.startsWith('[INVALID_FILES]'));
    assert.ok(!streamError?.error.includes('[INVALID_CONTEXT]'));
    assert.ok(!streamError?.error.includes('[INVALID_MODEL]'));
    assert.strictEqual(streamError?.error.split('\n').filter((line) => line.startsWith('Action:')).length, 1);
    assert.strictEqual(client.runCalls.length, 0);
  });

  test('fails fast with INVALID_CONTEXT before model checks and does not run client', async () => {
    const store = createStore();
    store.setModel('invalid-model' as unknown as import('../protocol').ModelType);
    const messages: ExtensionMessage[] = [];
    const client = new FakeClient();

    const pipeline = new SendMessagePipeline({
      store,
      client: client as unknown as import('../acpClient').AcpClient,
      postMessage: (message) => messages.push(message),
      markCliUnavailable: () => {},
      resolveWorkspaceFolder: () => '/tmp/workspace',
      getAllWorkspaceFolderPaths: () => ['/tmp/workspace'],
      getWorkspaceFileList: async () => [],
      shouldIncludeWorkspaceFiles: () => false,
      getWorkspaceFilesLimit: () => 80,
      getStreamRenderIntervalMs: () => 50,
      planApprovalCoordinator: new PlanApprovalCoordinator(new PlanModeOrchestrator()),
      debug: () => {},
      setSessionId: (sessionId) => store.setSessionId(sessionId),
    });

    await pipeline.execute({
      content: 'invalid context before model',
      attachedFiles: [{ path: '/tmp/workspace/ok.ts' }],
      silent: false,
      ideContext: {
        activeFile: { path: '', name: 'missing-path.ts' },
        selection: null,
      },
    });

    const streamError = messages.find((m) => m.type === 'streamError') as Extract<ExtensionMessage, { type: 'streamError' }> | undefined;
    assert.ok(streamError);
    assert.ok(streamError?.error.startsWith('[INVALID_CONTEXT]'));
    assert.ok(!streamError?.error.includes('[INVALID_MODEL]'));
    assert.strictEqual(streamError?.error.split('\n').filter((line) => line.startsWith('Action:')).length, 1);
    assert.strictEqual(client.runCalls.length, 0);
  });

  test('emits INVALID_MODEL only when files/context preflight passes', async () => {
    const store = createStore();
    store.setModel('invalid-model' as unknown as import('../protocol').ModelType);
    const messages: ExtensionMessage[] = [];
    const client = new FakeClient();

    const pipeline = new SendMessagePipeline({
      store,
      client: client as unknown as import('../acpClient').AcpClient,
      postMessage: (message) => messages.push(message),
      markCliUnavailable: () => {},
      resolveWorkspaceFolder: () => '/tmp/workspace',
      getAllWorkspaceFolderPaths: () => ['/tmp/workspace'],
      getWorkspaceFileList: async () => [],
      shouldIncludeWorkspaceFiles: () => false,
      getWorkspaceFilesLimit: () => 80,
      getStreamRenderIntervalMs: () => 50,
      planApprovalCoordinator: new PlanApprovalCoordinator(new PlanModeOrchestrator()),
      debug: () => {},
      setSessionId: (sessionId) => store.setSessionId(sessionId),
    });

    await pipeline.execute({
      content: 'invalid model after preflight',
      attachedFiles: [{ path: '/tmp/workspace/ok.ts' }],
      silent: false,
      ideContext: {
        activeFile: { path: '/tmp/workspace/main.ts', name: 'main.ts' },
        selection: null,
      },
    });

    const streamError = messages.find((m) => m.type === 'streamError') as Extract<ExtensionMessage, { type: 'streamError' }> | undefined;
    assert.ok(streamError);
    assert.ok(streamError?.error.startsWith('[INVALID_MODEL]'));
    assert.strictEqual(streamError?.error.split('\n').filter((line) => line.startsWith('Action:')).length, 1);
    assert.strictEqual(client.runCalls.length, 0);
  });

  test('keeps streamError concise while logging rich preflight diagnostics', async () => {
    const store = createStore();
    store.setModel('invalid-model' as unknown as import('../protocol').ModelType);
    const messages: ExtensionMessage[] = [];
    const debugLogs: string[] = [];
    const client = new FakeClient();

    const pipeline = new SendMessagePipeline({
      store,
      client: client as unknown as import('../acpClient').AcpClient,
      postMessage: (message) => messages.push(message),
      markCliUnavailable: () => {},
      resolveWorkspaceFolder: () => '/tmp/workspace',
      getAllWorkspaceFolderPaths: () => ['/tmp/workspace'],
      getWorkspaceFileList: async () => [],
      shouldIncludeWorkspaceFiles: () => false,
      getWorkspaceFilesLimit: () => 80,
      getStreamRenderIntervalMs: () => 50,
      planApprovalCoordinator: new PlanApprovalCoordinator(new PlanModeOrchestrator()),
      debug: (message) => debugLogs.push(message),
      setSessionId: (sessionId) => store.setSessionId(sessionId),
    });

    await pipeline.execute({
      content: 'debug preflight',
      attachedFiles: [{ path: '/tmp/workspace/main.ts' }],
      silent: false,
      ideContext: {
        activeFile: { path: '/tmp/workspace/main.ts', name: 'main.ts' },
        selection: null,
      },
    });

    const streamError = messages.find((m) => m.type === 'streamError') as Extract<ExtensionMessage, { type: 'streamError' }> | undefined;
    assert.ok(streamError);
    assert.strictEqual(streamError?.error.split('\n').length, 2);
    assert.ok(!streamError?.error.includes('reason='));
    assert.ok(debugLogs.some((line) => line.includes('[preflight] stage=INVALID_MODEL')
      && line.includes('reason=')
      && line.includes('runSuppressed=true')));
    assert.strictEqual(client.runCalls.length, 0);
  });

  test('runs finalize cleanup hooks after preflight validation failure', async () => {
    const store = createStore();
    store.setModel('invalid-model' as unknown as import('../protocol').ModelType);
    const messages: ExtensionMessage[] = [];
    const lifecycleCalls: string[] = [];
    const client = new FakeClient();

    const pipeline = new SendMessagePipeline({
      store,
      client: client as unknown as import('../acpClient').AcpClient,
      postMessage: (message) => messages.push(message),
      markCliUnavailable: () => {},
      resolveWorkspaceFolder: () => '/tmp/workspace',
      getAllWorkspaceFolderPaths: () => ['/tmp/workspace'],
      getWorkspaceFileList: async () => [],
      shouldIncludeWorkspaceFiles: () => false,
      getWorkspaceFilesLimit: () => 80,
      getStreamRenderIntervalMs: () => 50,
      planApprovalCoordinator: new PlanApprovalCoordinator(new PlanModeOrchestrator()),
      debug: () => {},
      setSessionId: (sessionId) => store.setSessionId(sessionId),
      onRunStart: () => lifecycleCalls.push('start'),
      onRunFinalize: (context) => lifecycleCalls.push(context.succeeded ? 'finalize:success' : 'finalize:error'),
    });

    await pipeline.execute({
      content: 'cleanup on preflight failure',
      attachedFiles: [{ path: '/tmp/workspace/main.ts' }],
      silent: false,
      ideContext: {
        activeFile: { path: '/tmp/workspace/main.ts', name: 'main.ts' },
        selection: null,
      },
    });

    const state = store.getState();
    const streamError = messages.find((m) => m.type === 'streamError') as Extract<ExtensionMessage, { type: 'streamError' }> | undefined;
    assert.ok(streamError);
    assert.deepStrictEqual(lifecycleCalls, ['start', 'finalize:error']);
    assert.strictEqual(state.isStreaming, false);
    assert.strictEqual(client.runCalls.length, 0);
  });
});
