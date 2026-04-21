import * as XLSX from 'xlsx'
import type {
  ColumnMapping,
  ColumnOption,
  ColumnRole,
  HeaderCandidate,
  ImportConfig,
  Product,
  SheetOption,
  WorkbookSource,
} from '../types'

const HEADER_SCAN_LIMIT = 30

const ROLE_KEYWORDS: Record<ColumnRole, string[]> = {
  sku: ['artikelnummer', 'artikel nr', 'nummer', 'sku', 'id'],
  name: ['name', 'produkt', 'artikel', 'bezeichnung'],
  producer: ['produzent', 'hersteller', 'lieferant', 'marke'],
  category: ['verpackung', 'typ', 'type', 'kategorie', 'warengruppe'],
  price: ['preis', 'price', 'chf', 'einzelpreis'],
  packSize: [
    'gebindegroesse',
    'gebindegröße',
    'gebinde',
    'bulk',
    'kartongroesse',
    'kartongröße',
  ],
  targetQuantity: ['soll', 'target'],
  actualQuantity: ['ist', 'actual'],
  orderQuantity: ['bestellung', 'bestellmenge', 'menge', 'quantity', 'qty'],
  lineTotal: ['total', 'summe', 'subtotal', 'gesamt'],
}

const SKIP_ROW_NAMES = new Set([
  'name',
  'total',
  'summe',
  'subtotal',
  'gesamt',
  'information',
])

export const COLUMN_ROLE_ORDER: ColumnRole[] = [
  'name',
  'producer',
  'category',
  'packSize',
  'price',
  'targetQuantity',
  'actualQuantity',
  'orderQuantity',
  'lineTotal',
  'sku',
]

export const ROLE_LABELS: Record<ColumnRole, string> = {
  sku: 'Artikelnummer',
  name: 'Name',
  producer: 'Produzent',
  category: 'Verpackung / Typ',
  price: 'Preis',
  packSize: 'Gebindegröße',
  targetQuantity: 'Soll',
  actualQuantity: 'Ist',
  orderQuantity: 'Bestellung',
  lineTotal: 'Total',
}

export interface ParsedWorkbookData {
  baseName: string
  fileName: string
  sheetName: string
  rowCount: number
  columnCount: number
  sheetOptions: SheetOption[]
  columns: ColumnOption[]
  config: ImportConfig
  products: Product[]
  warnings: string[]
}

interface SheetAnalysis {
  name: string
  rows: string[][]
  rowCount: number
  columnCount: number
  headerCandidates: HeaderCandidate[]
  detectedHeaderRow: number
  detectedMapping: ColumnMapping
  estimatedProducts: number
}

export function parseWorkbookBuffer(
  fileName: string,
  buffer: ArrayBuffer,
  configOverride?: Partial<ImportConfig>,
): ParsedWorkbookData {
  const workbook = XLSX.read(buffer, { type: 'array', cellFormula: true })
  const analyses = workbook.SheetNames.map((sheetName) =>
    analyzeSheet(sheetName, workbook.Sheets[sheetName]),
  )

  const fallbackSheet = analyses[0]
  const chosenSheet =
    analyses.find((analysis) => analysis.name === configOverride?.sheetName) ??
    analyses
      .slice()
      .sort((left, right) => right.estimatedProducts - left.estimatedProducts)[0] ??
    fallbackSheet

  const detectedForChoice = detectMapping(
    chosenSheet.rows[resolvedHeaderIndex(chosenSheet, configOverride)] ?? [],
    chosenSheet.rows,
    resolvedHeaderIndex(chosenSheet, configOverride),
    chosenSheet.columnCount,
  )

  const config: ImportConfig = {
    sheetName: chosenSheet.name,
    headerRow: configOverride?.headerRow ?? chosenSheet.detectedHeaderRow,
    mapping: {
      ...detectedForChoice,
      ...configOverride?.mapping,
    },
  }

  const products = extractProducts(
    chosenSheet.rows,
    chosenSheet.name,
    config,
  )

  return {
    baseName: stripExtension(fileName),
    fileName,
    sheetName: chosenSheet.name,
    rowCount: chosenSheet.rowCount,
    columnCount: chosenSheet.columnCount,
    sheetOptions: analyses.map((analysis) => ({
      name: analysis.name,
      rowCount: analysis.rowCount,
      columnCount: analysis.columnCount,
      headerCandidates: analysis.headerCandidates,
    })),
    columns: buildColumnOptions(
      chosenSheet.rows[config.headerRow - 1] ?? [],
      chosenSheet.columnCount,
    ),
    config,
    products,
    warnings: buildWarnings(config.mapping, products.length),
  }
}

export function exportWorkbookWithPlan(
  buffer: ArrayBuffer,
  source: WorkbookSource,
  planRows: Array<{
    productId: string
    target: number
    actual: number | null
    order: number
  }>,
) {
  const workbook = XLSX.read(buffer, { type: 'array', cellFormula: true })
  const worksheet = workbook.Sheets[source.config.sheetName]

  if (!worksheet) {
    throw new Error('The saved workbook sheet could not be found anymore.')
  }

  const orderColumn =
    source.config.mapping.orderQuantity ?? source.columnCount
  const targetColumn =
    source.config.mapping.targetQuantity ??
    Math.max(
      source.columnCount,
      source.config.mapping.lineTotal !== undefined
        ? source.config.mapping.lineTotal + 1
        : orderColumn + 1,
    )
  const actualColumn =
    source.config.mapping.actualQuantity ??
    Math.max(source.columnCount + 1, targetColumn + 1)
  const totalColumn =
    source.config.mapping.lineTotal ??
    Math.max(source.columnCount + 2, actualColumn + 1)

  ensureWorksheetRange(
    worksheet,
    Math.max(targetColumn, actualColumn, orderColumn, totalColumn),
    source.products[source.products.length - 1]?.rowNumber ?? source.config.headerRow,
  )

  writeHeaderCell(worksheet, source.config.headerRow, targetColumn, 'Soll')
  writeHeaderCell(worksheet, source.config.headerRow, actualColumn, 'Ist')
  writeHeaderCell(worksheet, source.config.headerRow, orderColumn, 'Bestellung')
  writeHeaderCell(worksheet, source.config.headerRow, totalColumn, 'Total (CHF)')

  const planByProductId = new Map(planRows.map((row) => [row.productId, row]))

  for (const product of source.products) {
    const plan = planByProductId.get(product.id)
    const target = sanitizeQuantity(plan?.target ?? 0)
    const actual =
      plan?.actual === null || plan?.actual === undefined
        ? null
        : sanitizeQuantity(plan.actual)
    const quantity = sanitizeQuantity(plan?.order ?? 0)
    const targetCell = XLSX.utils.encode_cell({
      c: targetColumn,
      r: product.rowNumber - 1,
    })
    const actualCell = XLSX.utils.encode_cell({
      c: actualColumn,
      r: product.rowNumber - 1,
    })
    const orderCell = XLSX.utils.encode_cell({
      c: orderColumn,
      r: product.rowNumber - 1,
    })

    if (target > 0) {
      worksheet[targetCell] = { t: 'n', v: target }
    } else {
      delete worksheet[targetCell]
    }

    if (actual !== null) {
      worksheet[actualCell] = { t: 'n', v: actual }
    } else {
      delete worksheet[actualCell]
    }

    if (quantity > 0) {
      worksheet[orderCell] = { t: 'n', v: quantity }
    } else {
      delete worksheet[orderCell]
    }

    if (source.config.mapping.price !== undefined) {
      const totalCell = XLSX.utils.encode_cell({
        c: totalColumn,
        r: product.rowNumber - 1,
      })
      const priceCell = XLSX.utils.encode_cell({
        c: source.config.mapping.price,
        r: product.rowNumber - 1,
      })

      if (quantity > 0) {
        const totalValue = roundCurrency(quantity * (product.price ?? 0))
        worksheet[totalCell] = {
          t: 'n',
          f: `${priceCell}*${orderCell}`,
          v: totalValue,
          z: '0.00',
        }
      } else {
        delete worksheet[totalCell]
      }
    }
  }

  const filename = `${source.baseName}-prefilled.xlsx`
  XLSX.writeFile(workbook, filename)
  return filename
}

function analyzeSheet(sheetName: string, worksheet: XLSX.WorkSheet): SheetAnalysis {
  const rows = extractUsedRows(worksheet)
  const rowCount = rows.length
  const columnCount = rows.reduce(
    (maximum, row) => Math.max(maximum, row.length),
    0,
  )

  const headerCandidates = detectHeaderCandidates(rows)
  const detectedHeaderRow = headerCandidates[0]?.rowNumber ?? 1
  const headerIndex = Math.max(0, detectedHeaderRow - 1)
  const detectedMapping = detectMapping(
    rows[headerIndex] ?? [],
    rows,
    headerIndex,
    columnCount,
  )
  const estimatedProducts = extractProducts(
    rows,
    sheetName,
    {
      sheetName,
      headerRow: detectedHeaderRow,
      mapping: detectedMapping,
    },
  ).length

  return {
    name: sheetName,
    rows,
    rowCount,
    columnCount,
    headerCandidates,
    detectedHeaderRow,
    detectedMapping,
    estimatedProducts,
  }
}

function extractUsedRows(worksheet: XLSX.WorkSheet) {
  const cellKeys = Object.keys(worksheet).filter((key) => !key.startsWith('!'))
  let maxRow = 0
  let maxCol = 0

  for (const key of cellKeys) {
    const cell = XLSX.utils.decode_cell(key)
    if (cell.r > maxRow) {
      maxRow = cell.r
    }
    if (cell.c > maxCol) {
      maxCol = cell.c
    }
  }

  const rows = Array.from({ length: maxRow + 1 }, () =>
    Array.from({ length: maxCol + 1 }, () => ''),
  )

  for (const key of cellKeys) {
    const cell = worksheet[key]
    const { r, c } = XLSX.utils.decode_cell(key)
    rows[r][c] = stringifyCell(cell)
  }

  return rows
}

function stringifyCell(cell: XLSX.CellObject | undefined) {
  if (!cell) {
    return ''
  }

  if (typeof cell.w === 'string') {
    return cell.w
  }

  if (cell.v === undefined || cell.v === null) {
    return ''
  }

  return String(cell.v)
}

function detectHeaderCandidates(rows: string[][]) {
  const candidates = rows
    .slice(0, HEADER_SCAN_LIMIT)
    .map((row, rowIndex) => {
      const mapping = detectHeaderHits(row)
      const uniqueRoles = Object.keys(mapping).length
      const nonEmptyCount = row.filter((value) => value.trim()).length
      const score =
        uniqueRoles * 10 +
        nonEmptyCount +
        (mapping.name !== undefined ? 8 : 0) +
        (mapping.orderQuantity !== undefined ? 4 : 0) +
        (mapping.price !== undefined ? 4 : 0)

      return {
        rowNumber: rowIndex + 1,
        preview: previewRow(row),
        score,
      }
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 6)

  return candidates.length > 0
    ? candidates
    : [
        {
          rowNumber: 1,
          preview: 'Row 1',
        },
      ]
}

function detectMapping(
  headerRow: string[],
  rows: string[][],
  headerIndex: number,
  columnCount: number,
) {
  const mapping = detectHeaderHits(headerRow)

  if (mapping.name === undefined) {
    const inferredName = inferNameColumn(rows, headerIndex, columnCount)
    if (inferredName !== undefined) {
      mapping.name = inferredName
    }
  }

  return mapping
}

function detectHeaderHits(row: string[]) {
  const mapping: ColumnMapping = {}

  row.forEach((value, index) => {
    const header = normalizeKey(value)
    if (!header) {
      return
    }

    for (const role of COLUMN_ROLE_ORDER) {
      const keywords = ROLE_KEYWORDS[role]
      if (keywords.some((keyword) => header.includes(normalizeKey(keyword)))) {
        if (mapping[role] === undefined) {
          mapping[role] = index
        }
      }
    }
  })

  return mapping
}

function inferNameColumn(
  rows: string[][],
  headerIndex: number,
  columnCount: number,
) {
  let bestColumn: number | undefined
  let bestScore = 0

  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    const sample = rows
      .slice(headerIndex + 1, headerIndex + 18)
      .map((row) => asText(row[columnIndex]))
      .filter(Boolean)

    if (sample.length < 2) {
      continue
    }

    const textRatio =
      sample.filter((value) => parseNumber(value) === null).length / sample.length
    const avgLength =
      sample.reduce((total, value) => total + value.length, 0) / sample.length
    const distinctRatio =
      new Set(sample.map((value) => normalizeKey(value))).size / sample.length
    const score = textRatio * 10 + distinctRatio * 6 + avgLength / 3

    if (score > bestScore) {
      bestScore = score
      bestColumn = columnIndex
    }
  }

  return bestScore > 8 ? bestColumn : undefined
}

function extractProducts(
  rows: string[][],
  sheetName: string,
  config: ImportConfig,
) {
  const headerIndex = Math.max(0, config.headerRow - 1)
  const products: Product[] = []

  if (config.mapping.name === undefined) {
    return products
  }

  for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? []
    const name = asText(row[config.mapping.name])

    if (!name) {
      continue
    }

    if (SKIP_ROW_NAMES.has(normalizeKey(name))) {
      continue
    }

    const producer = readMappedValue(row, config.mapping.producer)
    const category = readMappedValue(row, config.mapping.category)
    const packSize = readMappedValue(row, config.mapping.packSize)
    const price = parseNumber(readMappedValue(row, config.mapping.price))
    const targetQuantity = parseNumber(
      readMappedValue(row, config.mapping.targetQuantity),
    )
    const actualQuantity = parseNumber(
      readMappedValue(row, config.mapping.actualQuantity),
    )
    const orderQuantity = sanitizeQuantity(
      parseNumber(readMappedValue(row, config.mapping.orderQuantity)) ?? 0,
    )
    const sku = readMappedValue(row, config.mapping.sku)
    const skuKey = normalizeKey(sku)
    const nameKey = normalizeKey(name)
    const producerKey = normalizeKey(producer)

    if (!nameKey) {
      continue
    }

    products.push({
      id: `${sheetName}:${rowIndex + 1}`,
      sheetName,
      rowNumber: rowIndex + 1,
      sku,
      name,
      producer,
      category,
      packSize,
      price,
      targetQuantity,
      actualQuantity,
      orderQuantity,
      skuKey,
      nameKey,
      producerKey,
      matchKey: buildMatchKey(skuKey, nameKey, producerKey),
      searchText: normalizeKey(
        [sku, name, producer, category, packSize].join(' '),
      ),
    })
  }

  return products
}

function buildColumnOptions(headerRow: string[], columnCount: number) {
  return Array.from({ length: columnCount }, (_, index) => {
    const letter = XLSX.utils.encode_col(index)
    const label = asText(headerRow[index])

    return {
      index,
      letter,
      label: label ? `${letter} - ${label}` : `Column ${letter}`,
    }
  })
}

function buildWarnings(mapping: ColumnMapping, productCount: number) {
  const warnings: string[] = []

  if (mapping.name === undefined) {
    warnings.push(
      'Es wurde noch keine Namensspalte erkannt. Bitte Kopfzeile oder Feldzuordnung prüfen.',
    )
  }

  if (mapping.orderQuantity === undefined) {
    warnings.push(
      'Es wurde keine Bestellspalte erkannt. Beim Export wird automatisch eine Spalte "Bestellung" ergänzt.',
    )
  }

  if (mapping.price === undefined) {
    warnings.push(
      'Es wurde keine Preisspalte erkannt. Totale funktionieren erst, wenn ein Preisfeld zugeordnet ist.',
    )
  }

  if (productCount === 0) {
    warnings.push(
      'Aus dem gewählten Blatt konnten keine Produkte gelesen werden. Bitte Kopfzeile und Feldzuordnung prüfen.',
    )
  }

  return warnings
}

function resolvedHeaderIndex(
  sheet: SheetAnalysis,
  configOverride?: Partial<ImportConfig>,
) {
  const chosenHeaderRow = configOverride?.headerRow ?? sheet.detectedHeaderRow
  return Math.max(0, chosenHeaderRow - 1)
}

function previewRow(row: string[]) {
  const preview = row
    .slice(0, 6)
    .map((value) => asText(value))
    .filter(Boolean)
    .join(' • ')

  return preview || 'No visible labels'
}

function readMappedValue(row: string[], columnIndex: number | undefined) {
  if (columnIndex === undefined) {
    return ''
  }

  return asText(row[columnIndex])
}

function asText(value: string | undefined) {
  return String(value ?? '').trim()
}

export function normalizeKey(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function parseNumber(value: string) {
  const raw = value.trim()

  if (!raw) {
    return null
  }

  const cleaned = raw.replace(/[^\d,.'-]/g, '')
  if (!cleaned) {
    return null
  }

  const lastComma = cleaned.lastIndexOf(',')
  const lastDot = cleaned.lastIndexOf('.')
  let normalized = cleaned.replace(/'/g, '')

  if (lastComma > lastDot) {
    normalized = normalized.replace(/\./g, '').replace(/,/g, '.')
  } else if (lastDot > lastComma) {
    normalized = normalized.replace(/,/g, '')
  } else {
    normalized = normalized.replace(/,/g, '.')
  }

  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function sanitizeQuantity(value: number) {
  const rounded = Math.round(Math.max(0, value) * 1000) / 1000
  return Number.isFinite(rounded) ? rounded : 0
}

function buildMatchKey(skuKey: string, nameKey: string, producerKey: string) {
  if (skuKey) {
    return `sku:${skuKey}`
  }

  if (producerKey) {
    return `np:${nameKey}::${producerKey}`
  }

  return `n:${nameKey}`
}

function writeHeaderCell(
  worksheet: XLSX.WorkSheet,
  headerRow: number,
  columnIndex: number,
  label: string,
) {
  const address = XLSX.utils.encode_cell({
    c: columnIndex,
    r: headerRow - 1,
  })

  worksheet[address] = {
    t: 's',
    v: label,
  }
}

function ensureWorksheetRange(
  worksheet: XLSX.WorkSheet,
  maxColumnIndex: number,
  maxRowNumber: number,
) {
  const decoded = XLSX.utils.decode_range(
    worksheet['!ref'] ?? `A1:${XLSX.utils.encode_col(maxColumnIndex)}${maxRowNumber}`,
  )

  decoded.e.c = Math.max(decoded.e.c, maxColumnIndex)
  decoded.e.r = Math.max(decoded.e.r, Math.max(0, maxRowNumber - 1))

  worksheet['!ref'] = XLSX.utils.encode_range(decoded)
}

function roundCurrency(value: number) {
  return Math.round(value * 100) / 100
}

function stripExtension(fileName: string) {
  return fileName.replace(/\.[^.]+$/, '')
}
