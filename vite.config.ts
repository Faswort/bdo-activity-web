import { defineConfig } from 'vite';

// Относительная база: сборка работает и в корне домена, и в подпапке
// вида https://user.github.io/repo/ без пересборки.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
  },
  server: {
    port: 5173,
  },
});
