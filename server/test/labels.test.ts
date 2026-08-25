import { describe, expect, it } from 'vitest';
import {
  INSTANCE_LABEL,
  containerName,
  instanceFilter,
  instanceIdFromLabels,
  instanceLabels,
  managedFilter,
} from '../src/docker/labels.ts';

describe('labels', () => {
  it('labels a resource with its instance id', () => {
    expect(instanceLabels('abc123')).toEqual({ 'claudops.instance': 'abc123' });
  });

  it('reads the id back out', () => {
    expect(instanceIdFromLabels(instanceLabels('abc123'))).toBe('abc123');
  });

  it('ignores foreign or unlabelled containers', () => {
    expect(instanceIdFromLabels(undefined)).toBeUndefined();
    expect(instanceIdFromLabels({})).toBeUndefined();
    expect(instanceIdFromLabels({ [INSTANCE_LABEL]: '' })).toBeUndefined();
    expect(instanceIdFromLabels({ 'com.docker.compose.project': 'other' })).toBeUndefined();
  });

  it('filters by label existence for everything claudops owns', () => {
    expect(managedFilter).toEqual({ label: ['claudops.instance'] });
  });

  it('filters by label value for a single instance', () => {
    expect(instanceFilter('abc123')).toEqual({ label: ['claudops.instance=abc123'] });
  });

  it('derives a readable container name', () => {
    expect(containerName('abc123')).toBe('claudops-abc123');
  });
});
