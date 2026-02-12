import * as assert from 'assert';
import { IFlowClient, __setSDKModuleForTests } from '../iflowClient';

type RawEnvelope = { jsonData?: Record<string, unknown> };

class RawQueue {
  private queue: RawEnvelope[] = [];
  private resolvers: Array<(item: IteratorResult<RawEnvelope>) => void> = [];

  push(item: RawEnvelope): void {
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value: item, done: false });
      return;
    }
    this.queue.push(item);
  }

  iterator(): AsyncIterator<RawEnvelope> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          const item = this.queue.shift() as RawEnvelope;
          return Promise.resolve({ value: item, done: false });
        }
        return new Promise<IteratorResult<RawEnvelope>>((resolve) => {
          this.resolvers.push(resolve);
        });
      }
    };
  }
}

class FakeRawDataClient {
  static lastInstance: FakeRawDataClient | null = null;
  static lastOptions: Record<string, unknown> | null = null;
  static sendRawCalls: Array<{ method: string; params: any }> = [];

  public sessionId = 'session-1';
  public sendMessageCalled = false;
  private rawQueue = new RawQueue();

  constructor(_options: unknown, _captureRaw: boolean) {
    FakeRawDataClient.lastInstance = this;
    FakeRawDataClient.lastOptions = _options as Record<string, unknown>;
  }

  async connect(): Promise<void> {
    this.rawQueue.push({
      jsonData: {
        method: 'session/update',
        params: {
          _meta: {
            models: {
              currentModelId: 'model-1',
              availableModels: [{ id: 'model-1', name: 'Model 1' }]
            }
          }
        }
      }
    });
  }

  async disconnect(): Promise<void> {}

  receiveRawMessages(): AsyncIterator<RawEnvelope> {
    return this.rawQueue.iterator();
  }

  async sendRaw(payload: Record<string, unknown>): Promise<void> {
    const id = payload.id as string;
    const method = payload.method as string;
    const params = payload.params as any;
    FakeRawDataClient.sendRawCalls.push({ method, params });

    if (method === 'session/set_model') {
      this.rawQueue.push({ jsonData: { id, result: { currentModelId: params?.modelId } } });
    }
  }

  async sendMessage(_prompt: string): Promise<void> {
    this.sendMessageCalled = true;
  }

  async *receiveMessages(): AsyncGenerator<Record<string, unknown>> {
    yield { type: 'assistant', chunk: { text: 'ok' } };
    yield { type: 'task_finish', stopReason: 'end_turn' };
  }
}

function createMockSDK() {
  return {
    RawDataClient: FakeRawDataClient,
    MessageType: {
      ASSISTANT: 'assistant',
      TOOL_CALL: 'tool_call',
      PLAN: 'plan',
      ERROR: 'error',
      TASK_FINISH: 'task_finish'
    }
  };
}

suite('IFlowClient', () => {
  teardown(() => {
    FakeRawDataClient.lastInstance = null;
    FakeRawDataClient.lastOptions = null;
    FakeRawDataClient.sendRawCalls = [];
    __setSDKModuleForTests(null);
  });

  test('run does not pass authMethodInfo by default; sets model via ACP', async () => {
    __setSDKModuleForTests(createMockSDK());

    const client = new IFlowClient() as any;
    client.getConfig = () => ({
      nodePath: null,
      port: 8090,
      timeout: 60000,
      debugLogging: false,
      apiKey: null,
      baseUrl: null,
      telemetry: 'default',
      thinkKeyword: 'think'
    });

    let ended = false;
    let error = '';

    await client.run(
      {
        prompt: 'hello',
        attachedFiles: [],
        mode: 'smart',
        think: false,
        modelId: 'model-1'
      },
      () => {},
      () => {
        ended = true;
      },
      (message: string) => {
        error = message;
      }
    );

    assert.strictEqual(error, '');
    assert.strictEqual(ended, true);
    assert.strictEqual(FakeRawDataClient.lastInstance?.sendMessageCalled, true);

    const opts = FakeRawDataClient.lastOptions as any;
    assert.strictEqual(opts?.authMethodInfo, undefined);
    assert.strictEqual(opts?.sessionSettings?.permission_mode, 'smart');

    assert.ok(FakeRawDataClient.sendRawCalls.some(c => c.method === 'session/set_model' && c.params?.modelId === 'model-1'));
  });

});
