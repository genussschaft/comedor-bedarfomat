import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
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
  options: { keepIntroRows?: boolean } = {},
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

  // Drop everything above the header so the file starts directly with the column titles.
  const rowOffset = options.keepIntroRows ? 0 : source.config.headerRow - 1
  if (rowOffset > 0) {
    shiftWorksheetUp(worksheet, rowOffset)
  }

  const headerRow = source.config.headerRow - rowOffset
  const productRowNumbers = source.products.map((product) => product.rowNumber - rowOffset)
  const numericColumns = detectNumericColumns(
    worksheet,
    productRowNumbers,
    [
      source.config.mapping.price,
      source.config.mapping.packSize,
      targetColumn,
      actualColumn,
      orderColumn,
      totalColumn,
    ],
  )

  const lastRow = productRowNumbers.length > 0 ? Math.max(...productRowNumbers) : headerRow
  const columnWidths = fitColumnWidths(worksheet, headerRow, productRowNumbers)
  worksheet['!cols'] = columnWidths
  worksheet['!margins'] = { left: 0.25, right: 0.25, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 }
  setPrintNames(workbook, source.config.sheetName, headerRow, columnWidths.length - 1, lastRow)

  const filename = `${source.baseName}-prefilled.xlsx`
  const output = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  const styled = addExportStyles(new Uint8Array(output), {
    sheetIndex: workbook.SheetNames.indexOf(source.config.sheetName),
    headerRow,
    lastHeaderColumn: columnWidths.length - 1,
    numericColumns,
    lastColumn: actualColumn,
    orderColumn,
    firstRow: productRowNumbers.length > 0 ? Math.min(...productRowNumbers) : null,
    lastRow,
  })
  downloadFile(styled, filename)
  return filename
}

// Approximates Excel's double-click autofit for the 8pt export font. Only the table counts,
// so long intro texts above the header don't blow up the widths. Headers wrap, so they only
// need room for their longest word. Empty trailing columns are left out.
function fitColumnWidths(
  worksheet: XLSX.WorkSheet,
  headerRow: number,
  productRowNumbers: number[],
) {
  const range = XLSX.utils.decode_range(worksheet['!ref'] ?? 'A1')
  const cellText = (column: number, rowNumber: number) =>
    stringifyCell(
      worksheet[XLSX.utils.encode_cell({ c: column, r: rowNumber - 1 })] as
        | XLSX.CellObject
        | undefined,
    ).trim()
  const widths: Array<{ wch: number }> = []
  let lastUsedColumn = -1

  for (let column = 0; column <= range.e.c; column += 1) {
    // Bold header glyphs run a bit wider than regular ones.
    const headerWidth = Math.max(
      0,
      ...cellText(column, headerRow).split(/\s+/).map((word) => textWidth(word) * 1.1),
    )
    let contentWidth = 0

    for (const rowNumber of productRowNumbers) {
      contentWidth = Math.max(contentWidth, textWidth(cellText(column, rowNumber)))
    }

    if (headerWidth > 0 || contentWidth > 0) {
      lastUsedColumn = column
    }
    widths.push({ wch: Math.ceil(Math.max(4, headerWidth, contentWidth) + 1) })
  }

  return widths.slice(0, lastUsedColumn + 1)
}

// Column widths count in digit widths; Calibri is proportional, so weigh glyphs roughly.
function textWidth(text: string) {
  let width = 0

  for (const char of text) {
    if (/[ilIjtfr.,:;'!|()[\] -]/.test(char)) {
      width += 0.5
    } else if (/[mwMW@%]/.test(char)) {
      width += 1.4
    } else if (/[A-Z]/.test(char)) {
      width += 1.1
    } else if (/[0-9]/.test(char)) {
      width += 1
    } else {
      width += 0.85
    }
  }

  return width
}

// Prints the table (plus intro rows when kept) and repeats the header row on every page.
function setPrintNames(
  workbook: XLSX.WorkBook,
  sheetName: string,
  headerRow: number,
  lastColumn: number,
  lastRow: number,
) {
  const sheetIndex = workbook.SheetNames.indexOf(sheetName)
  const sheetRef = `'${sheetName.replace(/'/g, "''")}'`
  const names = (workbook.Workbook?.Names ?? []).filter(
    (name) =>
      !(
        (name.Name === '_xlnm.Print_Titles' || name.Name === '_xlnm.Print_Area') &&
        name.Sheet === sheetIndex
      ),
  )

  names.push(
    {
      Name: '_xlnm.Print_Area',
      Sheet: sheetIndex,
      Ref: `${sheetRef}!$A$1:$${XLSX.utils.encode_col(lastColumn)}$${lastRow}`,
    },
    {
      Name: '_xlnm.Print_Titles',
      Sheet: sheetIndex,
      Ref: `${sheetRef}!$${headerRow}:$${headerRow}`,
    },
  )
  workbook.Workbook = { ...workbook.Workbook, Names: names }
}

function shiftWorksheetUp(worksheet: XLSX.WorkSheet, offset: number) {
  const cellKeys = Object.keys(worksheet).filter((key) => !key.startsWith('!'))
  const shifted: Record<string, XLSX.CellObject> = {}

  for (const key of cellKeys) {
    const { r, c } = XLSX.utils.decode_cell(key)
    const cell = worksheet[key] as XLSX.CellObject
    delete worksheet[key]

    if (r < offset) {
      continue
    }

    if (cell.f) {
      cell.f = shiftFormulaRows(cell.f, offset)
    }
    shifted[XLSX.utils.encode_cell({ r: r - offset, c })] = cell
  }

  Object.assign(worksheet, shifted)

  if (worksheet['!ref']) {
    const range = XLSX.utils.decode_range(worksheet['!ref'])
    range.e.r = Math.max(0, range.e.r - offset)
    worksheet['!ref'] = XLSX.utils.encode_range(range)
  }

  worksheet['!merges'] = (worksheet['!merges'] ?? [])
    .filter((merge) => merge.s.r >= offset)
    .map((merge) => ({
      s: { r: merge.s.r - offset, c: merge.s.c },
      e: { r: merge.e.r - offset, c: merge.e.c },
    }))

  if (worksheet['!rows']) {
    worksheet['!rows'] = worksheet['!rows'].slice(offset)
  }

  delete worksheet['!autofilter']
}

// Moves plain A1 references up; references pointing into the removed rows clamp to row 1.
function shiftFormulaRows(formula: string, offset: number) {
  return formula
    .split(/("[^"]*")/)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(
            /(?<![A-Za-z_\d])(\$?[A-Z]{1,3})(\$?)(\d+)(?![\d(A-Za-z_])/g,
            (_, column: string, dollar: string, row: string) =>
              `${column}${dollar}${Math.max(1, Number(row) - offset)}`,
          ),
    )
    .join('')
}

// A column counts as numeric when most filled product cells hold numbers.
function detectNumericColumns(
  worksheet: XLSX.WorkSheet,
  productRowNumbers: number[],
  knownNumeric: Array<number | undefined>,
) {
  const range = XLSX.utils.decode_range(worksheet['!ref'] ?? 'A1')
  const columns = new Set(
    knownNumeric.filter((column): column is number => column !== undefined),
  )

  for (let column = 0; column <= range.e.c; column += 1) {
    let numbers = 0
    let filled = 0

    for (const rowNumber of productRowNumbers) {
      const cell = worksheet[XLSX.utils.encode_cell({ c: column, r: rowNumber - 1 })] as
        | XLSX.CellObject
        | undefined
      const text = stringifyCell(cell).trim()
      if (!text) {
        continue
      }
      filled += 1
      if (cell?.t === 'n' || /^-?[\d'.,]+$/.test(text)) {
        numbers += 1
      }
    }

    if (filled > 0 && numbers / filled >= 0.8) {
      columns.add(column)
    }
  }

  return [...columns]
}

// SheetJS CE cannot write cell styles, so formatting is added by patching the written XML:
// 8pt font everywhere, bold headers (right-aligned when numeric), landscape print setup, a tinted Bestellung column and a
// conditional yellow highlight on ordered rows that also follows later edits in Excel.
function addExportStyles(
  xlsx: Uint8Array,
  layout: {
    sheetIndex: number
    headerRow: number
    lastHeaderColumn: number
    numericColumns: number[]
    lastColumn: number
    orderColumn: number
    firstRow: number | null
    lastRow: number
  },
) {
  const files = unzipSync(xlsx)
  const sheetPath = `xl/worksheets/sheet${layout.sheetIndex + 1}.xml`
  const sheetXml = files[sheetPath] ? strFromU8(files[sheetPath]) : null
  const stylesXml = files['xl/styles.xml'] ? strFromU8(files['xl/styles.xml']) : null

  if (!sheetXml || !stylesXml) {
    return xlsx
  }

  const fontCount = Number(/<fonts count="(\d+)"/.exec(stylesXml)?.[1] ?? 0)
  let patchedStyles = stylesXml
    .replace(/<fonts[^>]*>[\s\S]*?<\/fonts>/, (fonts) =>
      fonts.replace(/<sz val="[^"]*"\/>/g, '<sz val="8"/>'),
    )
    .replace(/<fonts count="\d+"([^>]*)>/, `<fonts count="${fontCount + 1}"$1>`)
    .replace(
      '</fonts>',
      '<font><b/><sz val="8"/><color theme="1"/><name val="Calibri"/><family val="2"/>' +
        '<scheme val="minor"/></font></fonts>',
    )

  // Two new cell formats for the header row: bold + wrapped, left or right-aligned.
  const xfCount = Number(/<cellXfs count="(\d+)"/.exec(patchedStyles)?.[1] ?? 0)
  const headerXf = xfCount
  const numericHeaderXf = xfCount + 1
  patchedStyles = patchedStyles
    .replace(/<cellXfs count="\d+">/, `<cellXfs count="${xfCount + 2}">`)
    .replace(
      '</cellXfs>',
      `<xf numFmtId="0" fontId="${fontCount}" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1">` +
        '<alignment vertical="bottom" wrapText="1"/></xf>' +
        `<xf numFmtId="0" fontId="${fontCount}" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1">` +
        '<alignment horizontal="right" vertical="bottom" wrapText="1"/></xf></cellXfs>',
    )

  const dxfCount = Number(/<dxfs count="(\d+)"/.exec(patchedStyles)?.[1] ?? 0)
  const fillDxf = (color: string) =>
    `<dxf><fill><patternFill patternType="solid"><bgColor rgb="${color}"/></patternFill></fill></dxf>`
  const newDxfs = fillDxf('FFFFFF00') + fillDxf('FFFFF2CC')
  patchedStyles = patchedStyles.includes('<dxfs count="0"/>')
    ? patchedStyles.replace('<dxfs count="0"/>', `<dxfs count="2">${newDxfs}</dxfs>`)
    : patchedStyles.includes('</dxfs>')
      ? patchedStyles
          .replace(/<dxfs count="\d+">/, `<dxfs count="${dxfCount + 2}">`)
          .replace('</dxfs>', `${newDxfs}</dxfs>`)
      : patchedStyles.replace(
          /<tableStyles|<\/styleSheet>/,
          (match) => `<dxfs count="2">${newDxfs}</dxfs>${match}`,
        )

  let patchedSheet = sheetXml
  for (let column = 0; column <= layout.lastHeaderColumn; column += 1) {
    const address = XLSX.utils.encode_cell({ c: column, r: layout.headerRow - 1 })
    const style = layout.numericColumns.includes(column) ? numericHeaderXf : headerXf
    patchedSheet = patchedSheet.replace(
      new RegExp(`<c r="${address}"( s="\\d+")?`),
      `<c r="${address}" s="${style}"`,
    )
  }

  // Landscape, scaled to one page wide; as many pages tall as needed.
  // pageSetUpPr is the last allowed child of sheetPr.
  patchedSheet = patchedSheet
    .replace(/<pageSetUpPr[^>]*\/>/, '')
    .replace(/<sheetPr([^>]*?)\/>/, '<sheetPr$1></sheetPr>')
  patchedSheet = patchedSheet.includes('</sheetPr>')
    ? patchedSheet.replace('</sheetPr>', '<pageSetUpPr fitToPage="1"/></sheetPr>')
    : patchedSheet.replace('<dimension', '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension')
  patchedSheet = patchedSheet
    .replace(/<pageSetup[^>]*\/>/, '')
    .replace(
      /(<pageMargins[^>]*\/>)/,
      '$1<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>',
    )

  const orderLetter = XLSX.utils.encode_col(layout.orderColumn)
  let rules =
    `<conditionalFormatting sqref="${orderLetter}${layout.headerRow}:${orderLetter}${layout.lastRow}">` +
    `<cfRule type="expression" dxfId="${dxfCount + 1}" priority="2">` +
    '<formula>TRUE</formula></cfRule></conditionalFormatting>'

  if (layout.firstRow !== null) {
    const orderCell = `$${orderLetter}${layout.firstRow}`
    const range = `A${layout.firstRow}:${XLSX.utils.encode_col(layout.lastColumn)}${layout.lastRow}`
    rules =
      `<conditionalFormatting sqref="${range}">` +
      `<cfRule type="expression" dxfId="${dxfCount}" priority="1">` +
      `<formula>AND(ISNUMBER(${orderCell}),${orderCell}&gt;0)</formula>` +
      '</cfRule></conditionalFormatting>' +
      rules
  }

  // conditionalFormatting must precede these elements in the worksheet schema.
  const insertBefore =
    /<(dataValidations|hyperlinks|printOptions|pageMargins|pageSetup|headerFooter|rowBreaks|colBreaks|ignoredErrors|drawing|legacyDrawing|tableParts|extLst)[\s>/]|<\/worksheet>/
  patchedSheet = patchedSheet.replace(insertBefore, (match) => `${rules}${match}`)

  files['xl/styles.xml'] = strToU8(patchedStyles)
  files[sheetPath] = strToU8(patchedSheet)
  return zipSync(files)
}

function downloadFile(data: Uint8Array, filename: string) {
  const blob = new Blob([data as BlobPart], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
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
