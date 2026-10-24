import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '0.0.0.0',
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
        changeOrigin: true
      },
      '/ping': 'http://localhost:3001',
      '/health': 'http://localhost:3001'
    }
  },
  build: {
    target: 'es2022'
  }
});
