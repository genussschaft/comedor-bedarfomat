import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const COMEDOR_PROXY_PATHS = new Set([
  '/api/comedor-proxy',
  '/comedor-bedarfomat/api/comedor-proxy',
])

// https://vite.dev/config/
export default defineConfig({
  base: '/comedor-bedarfomat/',
  plugins: [
    react(),
    {
      name: 'comedor-local-download-proxy',
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          const requestUrl = new URL(request.url ?? '/', 'http://localhost')

          if (!COMEDOR_PROXY_PATHS.has(requestUrl.pathname)) {
            next()
            return
          }

          const rawTargetUrl = requestUrl.searchParams.get('url')

          if (!rawTargetUrl) {
            response.statusCode = 400
            response.end('Missing url parameter.')
            return
          }

          let targetUrl: URL

          try {
            targetUrl = new URL(rawTargetUrl)
          } catch {
            response.statusCode = 400
            response.end('Invalid url parameter.')
            return
          }

          if (
            targetUrl.protocol !== 'https:' ||
            targetUrl.hostname !== 'foodcoop-comedor.ch'
          ) {
            response.statusCode = 403
            response.end('Only foodcoop-comedor.ch downloads are allowed.')
            return
          }

          try {
            const upstreamResponse = await fetch(targetUrl)

            response.statusCode = upstreamResponse.status

            for (const header of ['content-type', 'content-length', 'last-modified', 'etag']) {
              const value = upstreamResponse.headers.get(header)

              if (value) {
                response.setHeader(header, value)
              }
            }

            response.setHeader('access-control-allow-origin', '*')
            response.end(Buffer.from(await upstreamResponse.arrayBuffer()))
          } catch (error) {
            response.statusCode = 502
            response.end(
              error instanceof Error ? error.message : 'Comedor download failed.',
            )
          }
        })
      },
    },
  ],
  build: {
    chunkSizeWarningLimit: 1000,
  },
})
