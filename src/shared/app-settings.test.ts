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
