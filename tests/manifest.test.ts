import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXTENSION_VERSION } from '../src/core/constants';

interface ExtensionManifest {
  version: string;
  js: string;
  css: string;
  generate_interceptor: string;
  hooks?: Record<string, string>;
}

describe('extension manifest', () => {
  it('points to committed, loadable assets and exported hooks', () => {
    const manifest = JSON.parse(readFileSync(resolve('manifest.json'), 'utf8')) as ExtensionManifest;
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string };
    const expectedVersionQuery = `v=${encodeURIComponent(EXTENSION_VERSION)}`;
    const jsAsset = manifest.js.replace(/\?.*$/, '');
    const cssAsset = manifest.css.replace(/\?.*$/, '');

    expect(manifest.version).toBe(EXTENSION_VERSION);
    expect(packageJson.version).toBe(EXTENSION_VERSION);
    expect(manifest.js.split('?')[1]).toBe(expectedVersionQuery);
    expect(manifest.css.split('?')[1]).toBe(expectedVersionQuery);
    expect(existsSync(resolve(jsAsset))).toBe(true);
    expect(existsSync(resolve(cssAsset))).toBe(true);
    expect(manifest.generate_interceptor).toBe('storyEchoGenerateInterceptor');
    expect(manifest.hooks).toEqual({ activate: 'onActivate' });

    const bundle = readFileSync(resolve(jsAsset), 'utf8');
    expect(bundle).toContain('globalThis.storyEchoGenerateInterceptor');
    expect(bundle).toContain('memoryMetadataManager');
    expect(bundle).toMatch(/export\s*\{[\s\S]*onActivate/);
  });
});
