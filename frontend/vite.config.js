import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: [
      'react',
      'react-dom',
      'use-context-selector',
      'styled-components',
      '@googleforcreators/react',
      '@googleforcreators/design-system',
      '@googleforcreators/elements',
      '@googleforcreators/units'
    ]
  },
  server: {
    port: 5173,
    host: true
  }
});
