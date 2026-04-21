export type ColumnRole =
  | 'sku'
  | 'name'
  | 'producer'
  | 'category'
  | 'price'
  | 'packSize'
  | 'targetQuantity'
  | 'actualQuantity'
  | 'orderQuantity'
  | 'lineTotal'

export type AppView = 'catalog' | 'inventory'

export type SortMode =
  | 'producer'
  | 'name'
  | 'target-desc'
  | 'price-asc'
  | 'price-desc'

export interface ColumnMapping {
  sku?: number
  name?: number
  producer?: number
  category?: number
  price?: number
  packSize?: number
  targetQuantity?: number
  actualQuantity?: number
  orderQuantity?: number
  lineTotal?: number
}

export interface ImportConfig {
  sheetName: string
  headerRow: number
  mapping: ColumnMapping
}

export interface ColumnOption {
  index: number
  letter: string
  label: string
}

export interface HeaderCandidate {
  rowNumber: number
  preview: string
}

export interface SheetOption {
  name: string
  rowCount: number
  columnCount: number
  headerCandidates: HeaderCandidate[]
}

export interface Product {
  id: string
  sheetName: string
  rowNumber: number
  sku: string
  name: string
  producer: string
  category: string
  packSize: string
  price: number | null
  targetQuantity: number | null
  actualQuantity: number | null
  orderQuantity: number
  skuKey: string
  nameKey: string
  producerKey: string
  matchKey: string
  searchText: string
}

export interface WorkbookSource {
  fileName: string
  baseName: string
  workbookKey: string
  importedAt: string
  sheetName: string
  rowCount: number
  columnCount: number
  sheetOptions: SheetOption[]
  columns: ColumnOption[]
  config: ImportConfig
  products: Product[]
  warnings: string[]
}

export interface InventoryDraft {
  target?: string
  lastTarget?: string
  actual?: string
  order?: string
  inInventory?: boolean
}

export interface PersistedFilters {
  producer: string
}

export interface PersistedAppState {
  activeView: AppView
  currentWorkbook: WorkbookSource | null
  previousWorkbook: WorkbookSource | null
  inventoryDrafts: Record<string, InventoryDraft>
  searchQuery: string
  inventoryQuery: string
  filters: PersistedFilters
  sortMode: SortMode
}
