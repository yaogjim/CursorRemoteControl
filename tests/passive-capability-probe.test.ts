import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { probePassiveCapabilities } from '../src/server/passive-capability-probe.js';

class FakeClient {
  script = '';
  async evaluate(script: string): Promise<unknown> {
    this.script = script;
    return {
      composerReady: true,
      observedAt: 123,
      modes: [{
        id: 'agent', label: 'Agent', current: true, source: 'data_attribute',
        confidence: 1, scope: 'composer', selectable: true, observedAt: 123,
      }],
      models: {
        items: [{
          id: 'label::GPT-5', label: 'GPT-5', selected: true, scope: 'composer',
          idStability: 'label', source: 'inferred', confidence: 0.4,
          selectable: true, observedAt: 123,
        }],
        completeness: 'unknown', filterActive: false, observedAt: 123,
      },
      tools: [{ id: 'tool-1', type: 'shell', source: 'data_attribute', executable: false, actions: [] }],
    };
  }
}

describe('Passive capability probe', () => {
  it('returns observed capability data without interactive DOM operations', async () => {
    const client = new FakeClient();
    const result = await probePassiveCapabilities(
      client as unknown as Parameters<typeof probePassiveCapabilities>[0],
      ['[data-mode]'],
      ['[aria-label="model"]'],
    );
    assert.equal(result.modes[0]?.id, 'agent');
    assert.equal(result.models.completeness, 'unknown');
    assert.equal(result.tools[0]?.executable, false);
    assert.match(client.script, /querySelectorAll/);
    assert.doesNotMatch(client.script, /\.click\(|\.focus\(|scrollIntoView/);
  });
});