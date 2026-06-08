const COMEDOR_DOWNLOAD_PAGE = 'https://foodcoop-comedor.ch/index.php?page-id=2'
const DEFAULT_ALLOWED_ORIGINS = 'https://genussschaft.github.io'
const DEFAULT_FILE_NAME = 'comedor-bestellliste.xlsx'

const FORWARDED_HEADERS = [
  'content-type',
  'content-length',
  'last-modified',
  'etag',
  'cache-control',
]

interface WorkerEnv {
  ALLOWED_ORIGINS?: string
  ENVIRONMENT?: string
}

class HttpError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv) {
    const allowedOrigins = parseAllowedOrigins(env)

    if (request.method === 'OPTIONS') {
      const corsOrigin = getCorsOrigin(request, allowedOrigins, env)

      if (!corsOrigin) {
        return jsonResponse({ error: 'Forbidden origin.' }, 403)
      }

      const headers = new Headers()
      setCorsHeaders(headers, corsOrigin)

      return new Response(null, {
        status: 204,
        headers,
      })
    }

    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        throw new HttpError(405, 'Method not allowed.')
      }

      const requestUrl = new URL(request.url)

      if (!isWorkbookRoute(requestUrl)) {
        throw new HttpError(404, 'Not found.')
      }

      const corsOrigin = enforceOrigin(request, env, allowedOrigins)
      const workbook = await fetchCurrentWorkbook()
      const responseHeaders = new Headers()
      setCorsHeaders(responseHeaders, corsOrigin)

      for (const header of FORWARDED_HEADERS) {
        const value = workbook.response.headers.get(header)

        if (value) {
          responseHeaders.set(header, value)
        }
      }

      if (!responseHeaders.has('cache-control')) {
        responseHeaders.set('cache-control', 'public, max-age=300')
      }

      responseHeaders.set('content-type', workbook.contentType)
      responseHeaders.set('content-disposition', `attachment; filename="${workbook.fileName}"`)
      responseHeaders.set('x-comedor-filename', workbook.fileName)
      responseHeaders.set('access-control-expose-headers', 'Content-Disposition, X-Comedor-Filename')

      return new Response(request.method === 'HEAD' ? null : workbook.response.body, {
        status: workbook.response.status,
        statusText: workbook.response.statusText,
        headers: responseHeaders,
      })
    } catch (error) {
      const errorCorsOrigin = getCorsOrigin(request, allowedOrigins, env)

      if (error instanceof HttpError) {
        return jsonResponse({ error: error.message }, error.status, errorCorsOrigin)
      }

      return jsonResponse(
        {
          error: error instanceof Error ? error.message : 'Comedor download failed.',
        },
        502,
        errorCorsOrigin,
      )
    }
  },
}

async function fetchCurrentWorkbook() {
  const pageResponse = await fetch(COMEDOR_DOWNLOAD_PAGE)

  if (!pageResponse.ok) {
    throw new HttpError(pageResponse.status, `Comedor download page returned ${pageResponse.status}.`)
  }

  const workbookUrl = findCurrentOrderListUrl(await pageResponse.text())

  if (!workbookUrl) {
    throw new HttpError(502, 'No Comedor Excel order list was found.')
  }

  const workbookResponse = await fetch(workbookUrl)

  if (!workbookResponse.ok) {
    throw new HttpError(workbookResponse.status, `Comedor workbook returned ${workbookResponse.status}.`)
  }

  return {
    response: workbookResponse,
    fileName: sanitizeFileName(fileNameFromUrl(workbookUrl)),
    contentType:
      workbookResponse.headers.get('content-type') ??
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }
}

function findCurrentOrderListUrl(html: string) {
  const anchorPattern = /<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi

  for (const match of html.matchAll(anchorPattern)) {
    const href = decodeHtmlValue(match[2] ?? '')
    const text = normalizeText(stripTags(decodeHtmlValue(match[3] ?? '')))

    if (!text.includes('bestellliste')) {
      continue
    }

    const url = new URL(href, COMEDOR_DOWNLOAD_PAGE)

    if (/\.xlsx?$/i.test(url.pathname)) {
      return url.href
    }
  }

  return null
}

function isWorkbookRoute(requestUrl: URL) {
  return requestUrl.pathname === '/' || requestUrl.pathname === '/comedor.xlsx'
}

function parseAllowedOrigins(env: WorkerEnv) {
  const rawAllowedOrigins =
    typeof env.ALLOWED_ORIGINS === 'string' && env.ALLOWED_ORIGINS.trim() !== ''
      ? env.ALLOWED_ORIGINS
      : DEFAULT_ALLOWED_ORIGINS

  return new Set(
    rawAllowedOrigins
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  )
}

function isDevelopmentEnvironment(env: WorkerEnv) {
  return (env.ENVIRONMENT || 'production').toLowerCase() !== 'production'
}

function isLocalDevelopmentOrigin(origin: string) {
  try {
    const parsedOrigin = new URL(origin)

    return (
      (parsedOrigin.protocol === 'http:' || parsedOrigin.protocol === 'https:') &&
      (parsedOrigin.hostname === 'localhost' ||
        parsedOrigin.hostname === '127.0.0.1' ||
        parsedOrigin.hostname === '[::1]' ||
        parsedOrigin.hostname === '::1')
    )
  } catch {
    return false
  }
}

function getCorsOrigin(request: Request, allowedOrigins: Set<string>, env: WorkerEnv) {
  const origin = request.headers.get('Origin')

  if (!origin) {
    return null
  }

  if (allowedOrigins.has(origin)) {
    return origin
  }

  return isDevelopmentEnvironment(env) && isLocalDevelopmentOrigin(origin) ? origin : null
}

function enforceOrigin(request: Request, env: WorkerEnv, allowedOrigins: Set<string>) {
  const origin = request.headers.get('Origin')

  if (isDevelopmentEnvironment(env) && !origin) {
    return null
  }

  const corsOrigin = getCorsOrigin(request, allowedOrigins, env)

  if (!corsOrigin) {
    throw new HttpError(403, 'Forbidden origin.')
  }

  return corsOrigin
}

function setCorsHeaders(headers: Headers, corsOrigin: string | null) {
  if (corsOrigin) {
    headers.set('access-control-allow-origin', corsOrigin)
    headers.set('vary', 'Origin')
  }

  headers.set('access-control-allow-methods', 'GET, HEAD, OPTIONS')
  headers.set('access-control-allow-headers', 'content-type')
}

function jsonResponse(body: unknown, status = 200, corsOrigin: string | null = null) {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })

  setCorsHeaders(headers, corsOrigin)

  return new Response(JSON.stringify(body), {
    status,
    headers,
  })
}

function fileNameFromUrl(url: string) {
  const pathname = new URL(url).pathname
  const rawName = pathname.split('/').filter(Boolean).pop() ?? DEFAULT_FILE_NAME

  return decodeURIComponent(rawName)
}

function sanitizeFileName(fileName: string) {
  return fileName.replace(/[^A-Za-z0-9._-]/g, '_') || DEFAULT_FILE_NAME
}

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function stripTags(value: string) {
  return value.replace(/<[^>]*>/g, ' ')
}

function decodeHtmlValue(value: string) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}
