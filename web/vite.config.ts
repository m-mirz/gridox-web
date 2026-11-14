import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';
import { PROVIDERS } from './src/chat/providers';

/**
 * Models can be confidential, and "nothing leaves your browser" should be enforced rather than
 * promised. Pages cannot set headers, so this is a meta tag. Build only: the dev server needs
 * its own connections.
 */
function contentSecurityPolicy(): Plugin {
  const policy = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self'",
    "img-src 'self' data:",
    // The example, and only when asked for: ReliCapGrid's files from its repository. And the chat's
    // providers, with the user's own key, only when they ask.
    `connect-src 'self' https://raw.githubusercontent.com ${PROVIDERS.map((p) => p.host).join(' ')}`,
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; ');
  return {
    name: 'cimlens-csp',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: policy },
        injectTo: 'head-prepend',
      },
    ],
  };
}

export default defineConfig({
  // The repository's path on GitHub Pages.
  base: process.env.CIMLENS_BASE ?? '/cimlens/',
  worker: { format: 'es' },
  plugins: [
    svelte(),
    contentSecurityPolicy(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'cimlens',
        short_name: 'cimlens',
        description: 'Power system models in your browser. Nothing leaves your machine.',
        theme_color: '#14532d',
        background_color: '#ffffff',
        display: 'standalone',
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,wasm,svg,webmanifest,txt}'],
        // The wasm is the app, and is larger than workbox's default limit of 2 MiB.
        maximumFileSizeToCacheInBytes: 16 * 1024 * 1024,
      },
    }),
  ],
  test: { include: ['src/**/*.test.ts'] },
});
