import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://wowfarer.com',
  output: 'static',
  trailingSlash: 'never',
  integrations: [sitemap()],
  build: {
    // Keep CSS external so the page can carry a strict Content Security Policy.
    inlineStylesheets: 'never',
  },
  vite: {
    build: {
      // Never inline assets as data: URIs; everything is a same-origin file.
      assetsInlineLimit: 0,
    },
  },
});
