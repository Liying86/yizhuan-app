import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import { resolve } from 'path'

export default defineConfig({
  plugins: [
    vue(),
    electron([
      {
        entry: 'electron/main/index.ts',
        onstart(options) {
          options.startup()
        },
        vite: {
          build: {
            sourcemap: false,
            minify: 'esbuild',
            outDir: 'dist-electron/main',
            rollupOptions: {
              external: ['electron', 'tesseract.js', 'sharp', 'heic-convert', 'ffmpeg-static', 'pdf-lib', 'tslib', 'pdfjs-dist'],
              output: {
                // 将 polyfill 分离为独立 chunk，确保 ESM 依赖图求值时 polyfill 在 pdfjs-dist 之前执行
                manualChunks(id) {
                  if (id.includes('polyfills')) {
                    return 'polyfills'
                  }
                }
              }
            }
          }
        }
      },
      {
        entry: 'electron/preload/index.ts',
        onstart(options) {
          options.reload()
        },
        vite: {
          build: {
            sourcemap: false,
            minify: 'esbuild',
            outDir: 'dist-electron/preload',
            lib: {
              entry: 'electron/preload/index.ts',
              formats: ['cjs'],
              fileName: () => 'index.js'
            },
            rollupOptions: {
              external: ['electron', 'tesseract.js', 'sharp', 'heic-convert', 'ffmpeg-static']
            }
          }
        }
      }
    ]),
    renderer()
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  },
  build: {
    target: 'esnext',
    minify: 'esbuild',
    cssMinify: true,
    chunkSizeWarningLimit: 2000,
  },
  clearScreen: false
})
