import * as assert from 'assert';
import { ChunkMapper } from '../chunkMapper';

function createMockSDK() {
  return {
    MessageType: {
      ASSISTANT: 'assistant',
      TOOL_CALL: 'tool_call',
      PLAN: 'plan',
      ERROR: 'error',
      TASK_FINISH: 'task_finish'
    }
  };
}

suite('ChunkMapper', () => {
  test('failed tool_call emits tool_start with input before tool_end', async () => {
    const mapper = new ChunkMapper(async () => createMockSDK(), () => {});
    mapper.reset();

    const chunks = await mapper.mapMessageToChunks({
      type: 'tool_call',
      status: 'failed',
      toolName: 'run_shell_command',
      args: { command: 'echo hello' },
      output: 'Command exited with code: 1'
    });

    assert.ok(chunks.length >= 2);
    assert.strictEqual(chunks[0].chunkType, 'tool_start');
    if (chunks[0].chunkType === 'tool_start') {
      assert.strictEqual(chunks[0].input.command, 'echo hello');
    }
    assert.ok(chunks.some(c => c.chunkType === 'tool_output'));
    assert.ok(chunks.some(c => c.chunkType === 'tool_end' && c.status === 'error'));
  });

  test('completed tool_call still emits input update for preview renderers', async () => {
    const mapper = new ChunkMapper(async () => createMockSDK(), () => {});
    mapper.reset();

    const chunks = await mapper.mapMessageToChunks({
      type: 'tool_call',
      status: 'completed',
      toolName: 'run_shell_command',
      args: { command: 'ls -la' },
      output: 'total 8'
    });

    assert.ok(chunks.length >= 2);
    assert.strictEqual(chunks[0].chunkType, 'tool_start');
    if (chunks[0].chunkType === 'tool_start') {
      assert.strictEqual(chunks[0].input.command, 'ls -la');
    }
    assert.ok(chunks.some(c => c.chunkType === 'tool_output'));
    assert.ok(chunks.some(c => c.chunkType === 'tool_end' && c.status === 'completed'));
  });

  test('todo_write tool_call is mapped to a plan chunk instead of a tool block', async () => {
    const mapper = new ChunkMapper(async () => createMockSDK(), () => {});
    mapper.reset();

    const chunks = await mapper.mapMessageToChunks({
      type: 'tool_call',
      status: 'completed',
      toolName: 'todo_write',
      label: 'Plan',
      args: {
        todos: [
          { task: 'Create HTML game structure', status: 'completed', priority: 'low' },
          { task: 'Test gameplay behavior', status: 'in_progress', priority: 'low' }
        ]
      }
    });

    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(chunks[0].chunkType, 'plan');
    if (chunks[0].chunkType === 'plan') {
      assert.strictEqual(chunks[0].entries.length, 2);
      assert.strictEqual(chunks[0].entries[0].content, 'Create HTML game structure');
      assert.strictEqual(chunks[0].entries[1].status, 'in_progress');
    }
  });
});
