import { describe, expect, it } from 'vitest';
import { PRESETS } from '../../src/presets/presets.ts';
import { Capability, ModelTier } from '../../src/shared/types.ts';

describe('presets', () => {
  it('offers the six roles of the design', () => {
    expect(Object.keys(PRESETS)).toEqual(['chief_of_staff', 'engineering_lead', 'engineer', 'reviewer', 'marketing_writer', 'analyst']);
  });

  it('every preset names a role sentence, capabilities that exist and a model tier', () => {
    for (const [id, preset] of Object.entries(PRESETS)) {
      expect(preset.label.length, id).toBeGreaterThan(3);
      expect(preset.role.length, id).toBeGreaterThan(30);
      expect(preset.capabilities.length, id).toBeGreaterThan(0);
      for (const capability of preset.capabilities) expect(Capability.options, id).toContain(capability);
      expect(ModelTier.options, id).toContain(preset.tier);
    }
  });

  it('leads and the reviewer get the lead tier; nobody is preset to send messages or push', () => {
    expect([PRESETS.chief_of_staff.tier, PRESETS.engineering_lead.tier, PRESETS.reviewer.tier]).toEqual(['lead', 'lead', 'lead']);
    expect([PRESETS.engineer.tier, PRESETS.analyst.tier, PRESETS.marketing_writer.tier]).toEqual(['member', 'member', 'member']);
    for (const preset of Object.values(PRESETS)) expect(preset.capabilities.some((c) => c === 'send_messages' || c === 'git_push')).toBe(false);
    expect(PRESETS.reviewer.capabilities).not.toContain('write_code');
    expect(PRESETS.chief_of_staff.capabilities).toEqual(['read_files']);
  });
});
