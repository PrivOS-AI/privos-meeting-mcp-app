import { describe, expect, it } from 'vitest';

import { DEFAULT_WORKSPACE_SETTINGS, isWorkspaceSettingKey, WORKSPACE_SETTING_VALIDATORS } from './app-settings.js';

describe('room settings allowlist', () => {
  it('defaults the summary language to the meeting\'s own language', () => {
    expect(DEFAULT_WORKSPACE_SETTINGS.summaryLanguage).toBe('auto');
    expect(WORKSPACE_SETTING_VALIDATORS.summaryLanguage('auto')).toBe('auto');
    expect(WORKSPACE_SETTING_VALIDATORS.summaryLanguage('ja')).toBe('ja');
    expect(() => WORKSPACE_SETTING_VALIDATORS.summaryLanguage('xx')).toThrow(/summaryLanguage/);
  });

  it('only accepts keys something actually reads', () => {
    expect(isWorkspaceSettingKey('speakerSessionMatchThreshold')).toBe(false);
    expect(isWorkspaceSettingKey('speakerSessionMergeThreshold')).toBe(false);
    expect(isWorkspaceSettingKey('summaryLength')).toBe(true);
  });
});

describe('speakerRecognition', () => {
  it('is on by default and only accepts a boolean', () => {
    expect(DEFAULT_WORKSPACE_SETTINGS.speakerRecognition).toBe(true);
    expect(WORKSPACE_SETTING_VALIDATORS.speakerRecognition(false)).toBe(false);
    expect(() => WORKSPACE_SETTING_VALIDATORS.speakerRecognition('off')).toThrow(/speakerRecognition/);
  });
});

describe('meeting follow-up settings', () => {
  it('summarizes live every 5 minutes by default and only at the offered cadences', () => {
    expect(DEFAULT_WORKSPACE_SETTINGS.liveSummaryMinutes).toBe(5);
    expect(WORKSPACE_SETTING_VALIDATORS.liveSummaryMinutes(0)).toBe(0);
    expect(WORKSPACE_SETTING_VALIDATORS.liveSummaryMinutes(15)).toBe(15);
    expect(() => WORKSPACE_SETTING_VALIDATORS.liveSummaryMinutes(1)).toThrow(/liveSummaryMinutes/);
  });

  it('does not post to chat unless the room turns it on', () => {
    expect(DEFAULT_WORKSPACE_SETTINGS.autoSendSummaryToChat).toBe(false);
    expect(() => WORKSPACE_SETTING_VALIDATORS.autoSendSummaryToChat('yes')).toThrow(/autoSendSummaryToChat/);
  });
});
