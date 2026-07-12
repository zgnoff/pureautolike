import assert from 'node:assert/strict';
import test from 'node:test';
import * as api from '../src/index.js';

test('exports only the documented foundation API', () => {
  assert.deepEqual(Object.keys(api).sort(), [
    'CORE_TOOL_DEFINITIONS',
    'ERROR_CODES',
    'MAX_DEPTH',
    'MAX_INPUT_BYTES',
    'MAX_ITEMS',
    'MAX_KEYS',
    'ToolCoreError',
    'authorize',
    'confirmationBinding',
    'createRegistry',
    'createRouter',
    'createToolCore',
    'failure',
    'normalizeArgs',
    'success',
    'toolError'
  ]);
});
