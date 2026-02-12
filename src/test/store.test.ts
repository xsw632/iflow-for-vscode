import * as assert from 'assert';
import { ConversationStore } from '../store';
import { ModelType, MODELS } from '../protocol';

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

suite('ConversationStore', () => {
  test('loads saved conversation and preserves mode and model', () => {
    const memento = new FakeMemento({
      currentId: 'c1',
      conversations: [
        {
          id: 'c1',
          title: 'legacy',
          messages: [],
          mode: 'smart',
          think: false,
          model: 'GLM-4.7',
          createdAt: 1,
          updatedAt: 1
        }
      ]
    });

    const store = new ConversationStore(memento as unknown as import('vscode').Memento, () => {});
    const conversation = store.getCurrentConversation();

    assert.ok(conversation);
    assert.strictEqual(conversation?.mode, 'smart');
    assert.strictEqual(conversation?.model, 'GLM-4.7');
  });

  test('new conversation gets default model and mode', () => {
    const memento = new FakeMemento({
      currentId: null,
      conversations: []
    });
    const store = new ConversationStore(memento as unknown as import('vscode').Memento, () => {});
    const conversation = store.newConversation();

    assert.strictEqual(conversation.model, MODELS[0]);
    assert.strictEqual(conversation.mode, 'default');
    assert.strictEqual(conversation.think, false);
  });

  test('setModel updates current conversation model', () => {
    const memento = new FakeMemento({
      currentId: null,
      conversations: []
    });
    const store = new ConversationStore(memento as unknown as import('vscode').Memento, () => {});
    store.newConversation();

    const newModel: ModelType = 'DeepSeek-V3.2';
    store.setModel(newModel);

    const current = store.getCurrentConversation();
    assert.ok(current);
    assert.strictEqual(current?.model, 'DeepSeek-V3.2');
  });
});
