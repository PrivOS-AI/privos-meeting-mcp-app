import { describe, expect, it } from 'vitest';
import type { McpApp } from '@privos_ai/app-react';

import { startHostMicStream } from './host-mic-stream.js';

const appAnswering = (answer: { granted: false; reason: string }) => ({ startMicrophone: async () => answer }) as unknown as McpApp;

describe('startHostMicStream', () => {
  it('falls back to getUserMedia when the SDK has no startMicrophone', async () => {
    expect(await startHostMicStream({} as McpApp)).toEqual({ kind: 'unsupported' });
  });

  it('falls back to getUserMedia when the host does not broker the mic (PrivOS mobile: unsupported_host)', async () => {
    expect(await startHostMicStream(appAnswering({ granted: false, reason: 'unsupported_host' }))).toEqual({ kind: 'unsupported' });
  });

  it.each(['denied', 'user_activation_required', 'not_declared', 'unavailable'])('keeps a real refusal (%s) a refusal', async (reason) => {
    expect(await startHostMicStream(appAnswering({ granted: false, reason }))).toEqual({ kind: 'denied', reason });
  });
});
