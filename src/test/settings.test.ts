import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { IFlowClient, __setSDKModuleForTests } from '../iflowClient';

// Mock vscode module
const mockVscode = {
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/test/workspace' } }],
    getConfiguration: (section: string) => ({
      get: (key: string, defaultValue: any) => {
        const config: Record<string, any> = {
          'nodePath': null,
          'baseUrl': 'https://api.test.com/v1',
          'port': 8090,
          'timeout': 60000,
          'debugLogging': true,
          'apiKey': 'test-api-key-12345'
        };
        return config[key] ?? defaultValue;
      }
    })
  },
  window: {
    createOutputChannel: () => ({
      appendLine: () => {},
      show: () => {}
    })
  }
};

// Replace vscode import with mock
jest.mock('vscode', () => mockVscode);

// Mock SDK
function createMockSDK() {
  return {
    IFlowClient: class MockSDKClient {
      async connect(): Promise<void> {}
      async disconnect(): Promise<void> {}
      async sendMessage(): Promise<void> {}
      async *receiveMessages(): AsyncGenerator<Record<string, unknown>> {
        yield { type: 'task_finish', stopReason: 'end_turn' };
      }
    },
    MessageType: {
      TASK_FINISH: 'task_finish'
    }
  };
}

suite('IFlowClient Settings Management', () => {
  let tempDir: string;
  let settingsPath: string;
  let client: IFlowClient;

  setup(() => {
    // Create temp directory for tests
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iflow-test-'));
    settingsPath = path.join(tempDir, 'settings.json');
    
    __setSDKModuleForTests(createMockSDK());
    client = new IFlowClient();
    
    // Override settings path for testing
    (client as any).getIFlowSettingsPath = () => settingsPath;
  });

  teardown(() => {
    __setSDKModuleForTests(null);
    
    // Cleanup temp directory
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  test('readSettings creates default settings when file does not exist', () => {
    const result = (client as any).readSettings();
    
    assert.ok(result, 'readSettings should return a result');
    assert.deepStrictEqual(result.settings, {}, 'Should return empty object for new file');
    assert.strictEqual(result.path, settingsPath, 'Should return correct path');
    
    // Directory should be created
    const dir = path.dirname(settingsPath);
    assert.ok(fs.existsSync(dir), 'Settings directory should be created');
  });

  test('readSettings reads existing settings correctly', () => {
    // Create existing settings file
    const existingSettings = {
      modelName: 'Qwen3-Coder',
      baseUrl: 'https://existing.api.com/v1',
      apiKey: 'existing-key'
    };
    
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(existingSettings, null, 2));
    
    const result = (client as any).readSettings();
    
    assert.ok(result, 'readSettings should return a result');
    assert.strictEqual(result.settings.modelName, 'Qwen3-Coder', 'Should read modelName');
    assert.strictEqual(result.settings.baseUrl, 'https://existing.api.com/v1', 'Should read baseUrl');
    assert.strictEqual(result.settings.apiKey, 'existing-key', 'Should read apiKey');
  });

  test('readSettings handles corrupted JSON gracefully', () => {
    // Create corrupted settings file
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{ invalid json }');
    
    const result = (client as any).readSettings();
    
    assert.ok(result, 'readSettings should return a result even with corrupted file');
    assert.deepStrictEqual(result.settings, {}, 'Should return empty object for corrupted file');
  });

  test('writeSettings saves settings correctly', () => {
    const settings = {
      modelName: 'TestModel',
      baseUrl: 'https://test.com/v1'
    };
    
    const result = (client as any).writeSettings(settings, settingsPath);
    
    assert.strictEqual(result, true, 'writeSettings should return true on success');
    assert.ok(fs.existsSync(settingsPath), 'Settings file should be created');
    
    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    assert.strictEqual(saved.modelName, 'TestModel', 'Should save modelName');
    assert.strictEqual(saved.baseUrl, 'https://test.com/v1', 'Should save baseUrl');
  });

  test('updateIFlowCliModel creates new settings file', () => {
    (client as any).updateIFlowCliModel('NewModel');
    
    assert.ok(fs.existsSync(settingsPath), 'Settings file should be created');
    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    assert.strictEqual(saved.modelName, 'NewModel', 'Should save modelName');
  });

  test('updateIFlowCliModel updates existing model', () => {
    // Create initial settings
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ modelName: 'OldModel' }, null, 2));
    
    (client as any).updateIFlowCliModel('NewModel');
    
    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    assert.strictEqual(saved.modelName, 'NewModel', 'Should update modelName');
  });

  test('updateIFlowCliApiConfig saves baseUrl and apiKey', () => {
    (client as any).updateIFlowCliApiConfig();
    
    assert.ok(fs.existsSync(settingsPath), 'Settings file should be created');
    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    assert.strictEqual(saved.baseUrl, 'https://api.test.com/v1', 'Should save baseUrl from config');
    assert.strictEqual(saved.apiKey, 'test-api-key-12345', 'Should save apiKey from config');
  });

  test('updateIFlowCliApiConfig does not overwrite unchanged values', () => {
    // Create existing settings with different values
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ 
      modelName: 'ExistingModel',
      baseUrl: 'https://existing.api.com/v1',
      apiKey: 'existing-key',
      customField: 'custom-value'
    }, null, 2));
    
    const beforeStat = fs.statSync(settingsPath);
    
    // Call update with same baseUrl (should not update)
    (client as any).updateIFlowCliApiConfig();
    
    const afterStat = fs.statSync(settingsPath);
    
    // File should be modified because baseUrl is different
    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    assert.strictEqual(saved.baseUrl, 'https://api.test.com/v1', 'Should update to new baseUrl');
    assert.strictEqual(saved.customField, 'custom-value', 'Should preserve custom fields');
  });
});
