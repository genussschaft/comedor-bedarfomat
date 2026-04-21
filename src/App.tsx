import {
  startTransition,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from 'react'
import './App.css'
import {
  clearAppState,
  getInitialAppState,
  loadAppState,
  loadWorkbookBinary,
  removeWorkbookBinary,
  saveAppState,
  saveWorkbookBinary,
} from './lib/storage'
import {
  COLUMN_ROLE_ORDER,
  ROLE_LABELS,
  exportWorkbookWithPlan,
  normalizeKey,
  parseNumber,
  parseWorkbookBuffer,
} from './lib/workbook'
import type {
  ColumnMapping,
  InventoryDraft,
  PersistedAppState,
  Product,
  SortMode,
  WorkbookSource,
} from './types'

interface BusyState {
  aktuellerImport: boolean
  vorherigerImport: boolean
  aktuellesMapping: boolean
  vorherigesMapping: boolean
  export: boolean
}

interface PlanRow {
  product: Product
  previousMatch: Product | null
  target: number
  actual: number | null
  derivedOrder: number
  order: number
  difference: number
  targetInput: string
  actualInput: string
  orderInput: string
  hasOrderOverride: boolean
}

interface PlanModel {
  rows: PlanRow[]
  addableRows: PlanRow[]
  allRows: PlanRow[]
  discontinued: Product[]
  matchedCount: number
  sollCount: number
  bestellCount: number
}

interface ProductIndex {
  bySku: Map<string, Product>
  byNameProducer: Map<string, Product>
  byName: Map<string, Product>
}

function App() {
  const [appState, setAppState] = useState<PersistedAppState>(() => loadAppState())
  const [busyState, setBusyState] = useState<BusyState>({
    aktuellerImport: false,
    vorherigerImport: false,
    aktuellesMapping: false,
    vorherigesMapping: false,
    export: false,
  })
  const [meldung, setMeldung] = useState<string | null>(null)
  const [fehler, setFehler] = useState<string | null>(null)
  const [zeigeAktuellesMapping, setZeigeAktuellesMapping] = useState(false)
  const [zeigeVorherigesMapping, setZeigeVorherigesMapping] = useState(false)

  const aktuellerInputRef = useRef<HTMLInputElement | null>(null)
  const vorherigerInputRef = useRef<HTMLInputElement | null>(null)

  const deferredSuche = useDeferredValue(appState.searchQuery)
  const deferredInventurSuche = useDeferredValue(appState.inventoryQuery)

  useEffect(() => {
    saveAppState(appState)
  }, [appState])

  const aktuelleProdukte = appState.currentWorkbook?.products ?? []
  const vorherigeProdukte = appState.previousWorkbook?.products ?? []
  const planModel = buildPlanModel(
    aktuelleProdukte,
    vorherigeProdukte,
    appState.inventoryDrafts,
    deferredInventurSuche,
  )

  const sichtbarePlanRows = planModel.allRows
    .filter((row) => matchesKatalogFilter(row.product, deferredSuche, appState))
    .sort((left, right) => comparePlanRows(left, right, appState.sortMode))

  const producerOptions = uniqueSortedValues(
    aktuelleProdukte.map((product) => product.producer),
  )

  const bestellRows = planModel.allRows
    .filter((row) => row.order > 0)
    .sort((left, right) => compareProducts(left.product, right.product))

  const bestellSumme = bestellRows.reduce(
    (total, row) => total + row.order * (row.product.price ?? 0),
    0,
  )
  const positionsAnzahl = bestellRows.length
  const bestellMenge = roundQuantity(
    bestellRows.reduce((total, row) => total + row.order, 0),
  )

  async function importWorkbook(kind: 'aktuell' | 'vorherig', file: File) {
    setFehler(null)
    setMeldung(null)
    setBusy(kind, true)

    try {
      const buffer = await file.arrayBuffer()
      const parsed = parseWorkbookBuffer(file.name, buffer)
      const existingSource =
        kind === 'aktuell' ? appState.currentWorkbook : appState.previousWorkbook
      const workbookKey =
        existingSource?.workbookKey ?? `comedorbedarfomat:${crypto.randomUUID()}`

      await saveWorkbookBinary(workbookKey, buffer)

      const source: WorkbookSource = {
        ...parsed,
        workbookKey,
        importedAt: new Date().toISOString(),
      }

      startTransition(() => {
        setAppState((previous) => {
          if (kind === 'aktuell') {
            return {
              ...previous,
              activeView: 'catalog',
              currentWorkbook: source,
              inventoryDrafts: remapInventoryDrafts(
                previous.currentWorkbook?.products ?? [],
                previous.inventoryDrafts,
                source.products,
              ),
            }
          }

          return {
            ...previous,
            activeView: 'inventory',
            previousWorkbook: source,
          }
        })
      })

      setMeldung(
        kind === 'aktuell'
          ? `${source.products.length} Produkte aus ${file.name} importiert.`
          : `Vorherige Bestellliste ${file.name} importiert.`,
      )
    } catch (error) {
      setFehler(
        error instanceof Error
          ? error.message
          : 'Die Datei konnte nicht importiert werden.',
      )
    } finally {
      setBusy(kind, false)
    }
  }

  async function updateWorkbookConfig(
    kind: 'aktuell' | 'vorherig',
    partialConfig: Partial<WorkbookSource['config']>,
  ) {
    const source =
      kind === 'aktuell' ? appState.currentWorkbook : appState.previousWorkbook

    if (!source) {
      return
    }

    setFehler(null)
    setBusy(kind, true, true)

    try {
      const buffer = await loadWorkbookBinary(source.workbookKey)

      if (!buffer) {
        throw new Error('Die lokal gespeicherte Arbeitsmappe fehlt. Bitte erneut importieren.')
      }

      const override = buildConfigOverride(source, partialConfig)
      const parsed = parseWorkbookBuffer(source.fileName, buffer, override)
      const nextSource: WorkbookSource = {
        ...parsed,
        workbookKey: source.workbookKey,
        importedAt: source.importedAt,
      }

      startTransition(() => {
        setAppState((previous) => {
          if (kind === 'aktuell') {
            return {
              ...previous,
              currentWorkbook: nextSource,
              inventoryDrafts: remapInventoryDrafts(
                previous.currentWorkbook?.products ?? [],
                previous.inventoryDrafts,
                nextSource.products,
              ),
            }
          }

          return {
            ...previous,
            previousWorkbook: nextSource,
          }
        })
      })

      setMeldung('Die Spaltenzuordnung wurde aktualisiert.')
    } catch (error) {
      setFehler(
        error instanceof Error
          ? error.message
          : 'Die Spaltenzuordnung konnte nicht aktualisiert werden.',
      )
    } finally {
      setBusy(kind, false, true)
    }
  }

  async function exportCurrentWorkbook() {
    if (!appState.currentWorkbook) {
      return
    }

    setFehler(null)
    setMeldung(null)

    const rowsWithDecimalOrders = planModel.allRows.filter(
      (row) => row.order > 0 && hasDecimalPart(row.order),
    )

    if (rowsWithDecimalOrders.length > 0) {
      const preview = rowsWithDecimalOrders
        .slice(0, 12)
        .map(
          (row) =>
            `- ${row.product.name} (${formatQuantity(row.order)})`,
        )
        .join('\n')
      const extra =
        rowsWithDecimalOrders.length > 12
          ? `\n... und ${rowsWithDecimalOrders.length - 12} weitere Produkte`
          : ''

      if (
        !window.confirm(
          `Diese Bestellmengen haben Kommastellen:\n${preview}${extra}\n\nTrotzdem exportieren?`,
        )
      ) {
        setMeldung('Export abgebrochen. Runde die betroffenen Bestellmengen oder exportiere trotzdem.')
        return
      }
    }

    setBusyState((previous) => ({ ...previous, export: true }))

    try {
      const buffer = await loadWorkbookBinary(appState.currentWorkbook.workbookKey)

      if (!buffer) {
        throw new Error('Die lokal gespeicherte Arbeitsmappe fehlt. Bitte die aktuelle Liste erneut importieren.')
      }

      const filename = exportWorkbookWithPlan(
        buffer,
        appState.currentWorkbook,
        planModel.allRows.map((row) => ({
          productId: row.product.id,
          target: row.target,
          actual: row.actual,
          order: row.order,
        })),
      )

      setMeldung(`${filename} wurde mit Soll-, Ist- und Bestellmengen exportiert.`)
    } catch (error) {
      setFehler(
        error instanceof Error
          ? error.message
          : 'Der Export ist fehlgeschlagen.',
      )
    } finally {
      setBusyState((previous) => ({ ...previous, export: false }))
    }
  }

  function setBusy(kind: 'aktuell' | 'vorherig', value: boolean, mapping = false) {
    setBusyState((previous) => ({
      ...previous,
      [kind === 'aktuell'
        ? mapping
          ? 'aktuellesMapping'
          : 'aktuellerImport'
        : mapping
          ? 'vorherigesMapping'
          : 'vorherigerImport']: value,
    }))
  }

  function setSuche(value: string) {
    startTransition(() => {
      setAppState((previous) => ({
        ...previous,
        searchQuery: value,
      }))
    })
  }

  function setInventurSuche(value: string) {
    startTransition(() => {
      setAppState((previous) => ({
        ...previous,
        inventoryQuery: value,
      }))
    })
  }

  function setFilter(field: 'producer', value: string) {
    startTransition(() => {
      setAppState((previous) => ({
        ...previous,
        filters: {
          ...previous.filters,
          [field]: value,
        },
      }))
    })
  }

  function setSortMode(value: SortMode) {
    startTransition(() => {
      setAppState((previous) => ({
        ...previous,
        sortMode: value,
      }))
    })
  }

  function setDraftValue(
    productId: string,
    field: keyof InventoryDraft,
    value: string,
  ) {
    setAppState((previous) => ({
      ...previous,
      inventoryDrafts: {
        ...previous.inventoryDrafts,
        [productId]: {
          ...previous.inventoryDrafts[productId],
          [field]: value,
        },
      },
    }))
  }

  function nudgeSoll(productId: string, currentValue: number, delta: number) {
    const nextValue = roundQuantity(Math.max(0, currentValue + delta))
    setDraftValue(productId, 'target', nextValue > 0 ? String(nextValue) : '')
  }

  function addProductToInventory(productId: string) {
    startTransition(() => {
      setAppState((previous) => ({
        ...previous,
        inventoryDrafts: {
          ...previous.inventoryDrafts,
          [productId]: {
            ...previous.inventoryDrafts[productId],
            target: '1',
            actual: '0',
          },
        },
      }))
    })
  }

  function nudgeOrder(productId: string, currentValue: number, direction: -1 | 1) {
    setAppState((previous) => {
      const currentDraft = previous.inventoryDrafts[productId]
      const valueFromDraft = resolveOrderQuantity(currentDraft?.order, currentValue)
      const nextValue =
        direction > 0
          ? hasDecimalPart(valueFromDraft)
            ? Math.ceil(valueFromDraft)
            : valueFromDraft + 1
          : hasDecimalPart(valueFromDraft)
            ? Math.floor(valueFromDraft)
            : valueFromDraft - 1

      return {
        ...previous,
        inventoryDrafts: {
          ...previous.inventoryDrafts,
          [productId]: {
            ...(currentDraft ?? {}),
            order: String(roundQuantity(Math.max(0, nextValue))),
          },
        },
      }
    })
  }

  function resetOrderOverride(productId: string) {
    startTransition(() => {
      setAppState((previous) => {
        const currentDraft = previous.inventoryDrafts[productId]

        if (!currentDraft || currentDraft.order === undefined) {
          return previous
        }

        const nextDraft = { ...currentDraft }
        delete nextDraft.order

        return {
          ...previous,
          inventoryDrafts: {
            ...previous.inventoryDrafts,
            [productId]: nextDraft,
          },
        }
      })
    })
  }

  async function clearSavedWorkspace() {
    const hasData = appState.currentWorkbook || appState.previousWorkbook

    if (!hasData) {
      startTransition(() => {
        setAppState(getInitialAppState())
      })
      setMeldung('Es gibt nichts zu löschen.')
      return
    }

    if (!window.confirm('Lokale Daten, importierte Dateien und alle Soll-/Ist-Werte wirklich löschen?')) {
      return
    }

    const keys = [
      appState.currentWorkbook?.workbookKey,
      appState.previousWorkbook?.workbookKey,
    ].filter(Boolean) as string[]

    await Promise.all(keys.map((key) => removeWorkbookBinary(key)))
    clearAppState()
    startTransition(() => {
      setAppState(getInitialAppState())
    })
    setZeigeAktuellesMapping(false)
    setZeigeVorherigesMapping(false)
    setFehler(null)
    setMeldung('Die lokal gespeicherte Arbeitsfläche wurde geleert.')
  }

  return (
    <div className="app-shell">
      <header className="hero-panel panel">
        <div className="hero-copy">
          <span className="eyebrow">Comedor Bestellwerkzeug</span>
          <h1>ComedorBedarfomat</h1>
          <p className="hero-text">
            Importiere die aktuelle Bestellliste, setze Soll-Werte direkt im Katalog
            oder über die Inventur, und exportiere wieder eine Excel-Datei mit den
            Spalten <strong>Soll</strong>, <strong>Ist</strong> und <strong>Bestellung</strong>.
          </p>

          <div className="hero-actions">
            <button
              className="button button-primary"
              type="button"
              onClick={() => aktuellerInputRef.current?.click()}
              disabled={busyState.aktuellerImport}
            >
              {busyState.aktuellerImport
                ? 'Aktuelle Liste wird importiert...'
                : 'Aktuelle Bestellliste importieren'}
            </button>
            <button
              className="button button-secondary"
              type="button"
              onClick={() => vorherigerInputRef.current?.click()}
              disabled={busyState.vorherigerImport}
            >
              {busyState.vorherigerImport
                ? 'Vorherige Liste wird importiert...'
                : 'Vorherige Bestellliste importieren'}
            </button>
            <button
              className="button button-ghost"
              type="button"
              onClick={() => void clearSavedWorkspace()}
            >
              Lokale Daten löschen
            </button>
          </div>
        </div>

        <div className="stats-grid">
          <StatCard label="Produkte" value={aktuelleProdukte.length.toString()} tone="accent" />
          <StatCard label="Soll gesetzt" value={planModel.sollCount.toString()} tone="leaf" />
          <StatCard label="Bestellpositionen" value={positionsAnzahl.toString()} tone="neutral" />
          <StatCard label="Geschätzte Summe" value={formatCurrency(bestellSumme)} tone="neutral" />
        </div>
      </header>

      <input
        ref={aktuellerInputRef}
        className="visually-hidden"
        type="file"
        accept=".xlsx,.xls,.csv"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          if (file) {
            void importWorkbook('aktuell', file)
          }
          event.currentTarget.value = ''
        }}
      />
      <input
        ref={vorherigerInputRef}
        className="visually-hidden"
        type="file"
        accept=".xlsx,.xls,.csv"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          if (file) {
            void importWorkbook('vorherig', file)
          }
          event.currentTarget.value = ''
        }}
      />

      <section className="wizard-rail">
        <RailStep
          title="1. Import"
          description="Aktuelle Bestellliste laden."
          isReady={Boolean(appState.currentWorkbook)}
        />
        <RailStep
          title="2. Inventur machen"
          description="Vorherige Bestellliste importieren, um Soll- und Ist-Werte automatisch zu übernehmen."
          isReady={appState.previousWorkbook !== null}
          optional
        />
        <RailStep
          title="3. Excel exportieren"
          description="Bestellung, Soll und Ist wieder in die Datei zurückschreiben."
          isReady={Boolean(appState.currentWorkbook)}
        />
      </section>

      {(meldung || fehler) && (
        <section className="message-stack">
          {meldung ? <MessageBanner tone="success">{meldung}</MessageBanner> : null}
          {fehler ? <MessageBanner tone="error">{fehler}</MessageBanner> : null}
        </section>
      )}

      <section className="import-grid">
        <ImportCard
          title="Aktuelle Bestellliste"
          subtitle="Diese Datei bestimmt Katalog, Export und Bestellübersicht."
          source={appState.currentWorkbook}
          busy={busyState.aktuellerImport}
          onSelectFile={() => aktuellerInputRef.current?.click()}
          onDropFile={(file) => void importWorkbook('aktuell', file)}
        >
          {appState.currentWorkbook ? (
            <>
              <div className="pill-row">
                <span className="pill pill-accent">
                  Kopfzeile {appState.currentWorkbook.config.headerRow}
                </span>
                <span className="pill">
                  {appState.currentWorkbook.products.length} Produkte
                </span>
                <span className="pill">{appState.currentWorkbook.sheetName}</span>
              </div>
              <div className="meta-line">
                Importiert am {formatDateTime(appState.currentWorkbook.importedAt)} aus{' '}
                {appState.currentWorkbook.fileName}
              </div>
              <button
                className="link-button"
                type="button"
                onClick={() => setZeigeAktuellesMapping((value) => !value)}
              >
                {zeigeAktuellesMapping
                  ? 'Spaltenzuordnung ausblenden'
                  : 'Spaltenzuordnung anpassen'}
              </button>
              {zeigeAktuellesMapping ? (
                <MappingEditor
                  source={appState.currentWorkbook}
                  busy={busyState.aktuellesMapping}
                  onConfigChange={(config) =>
                    void updateWorkbookConfig('aktuell', config)
                  }
                />
              ) : null}
              {appState.currentWorkbook.warnings.length > 0 ? (
                <WarningList warnings={appState.currentWorkbook.warnings} />
              ) : null}
            </>
          ) : (
            <p className="empty-copy">
              Ziehe die aktuelle Comedor-Bestellliste hier hinein oder wähle sie aus.
              Die App erkennt die echte Beispielstruktur mit der Kopfzeile in Zeile 16.
            </p>
          )}
        </ImportCard>

        <ImportCard
          title="Vorherige Bestellliste"
          subtitle="Für automatische Übernahme von Soll- und Ist-Werten"
          source={appState.previousWorkbook}
          busy={busyState.vorherigerImport}
          onSelectFile={() => vorherigerInputRef.current?.click()}
          onDropFile={(file) => void importWorkbook('vorherig', file)}
        >
          {appState.previousWorkbook ? (
            <>
              <div className="pill-row">
                <span className="pill pill-leaf">
                  Kopfzeile {appState.previousWorkbook.config.headerRow}
                </span>
                <span className="pill">
                  {appState.previousWorkbook.products.length} Produkte
                </span>
              </div>
              <div className="meta-line">
                Importiert am {formatDateTime(appState.previousWorkbook.importedAt)} aus{' '}
                {appState.previousWorkbook.fileName}
              </div>
              <button
                className="link-button"
                type="button"
                onClick={() => setZeigeVorherigesMapping((value) => !value)}
              >
                {zeigeVorherigesMapping
                  ? 'Spaltenzuordnung ausblenden'
                  : 'Spaltenzuordnung anpassen'}
              </button>
              {zeigeVorherigesMapping ? (
                <MappingEditor
                  source={appState.previousWorkbook}
                  busy={busyState.vorherigesMapping}
                  onConfigChange={(config) =>
                    void updateWorkbookConfig('vorherig', config)
                  }
                />
              ) : null}
              {appState.previousWorkbook.warnings.length > 0 ? (
                <WarningList warnings={appState.previousWorkbook.warnings} />
              ) : null}
            </>
          ) : (
            <p className="empty-copy">
              Wenn du die vorige Runde importierst, kann die Inventur Soll-Mengen
              automatisch vorbelegen und nicht mehr verfügbare Produkte markieren.
            </p>
          )}
        </ImportCard>
      </section>

      <div className="content-layout">
        <main className="workspace-panel panel">
          <div className="workspace-head">
            <div>
              <span className="eyebrow">Arbeitsbereich</span>
              <h2>{appState.activeView === 'catalog' ? 'Katalog' : 'Inventur'}</h2>
            </div>
            <div className="tab-switch">
              <TabButton
                label="Katalog"
                active={appState.activeView === 'catalog'}
                onClick={() =>
                  startTransition(() =>
                    setAppState((previous) => ({
                      ...previous,
                      activeView: 'catalog',
                    })),
                  )
                }
              />
              <TabButton
                label="Inventur"
                active={appState.activeView === 'inventory'}
                onClick={() =>
                  startTransition(() =>
                    setAppState((previous) => ({
                      ...previous,
                      activeView: 'inventory',
                    })),
                  )
                }
              />
            </div>
          </div>

          {appState.currentWorkbook ? (
            appState.activeView === 'catalog' ? (
              <>
                <div className="catalog-controls">
                  <div className="filters-grid">
                    <label className="field field-wide">
                      <span className="field-label">Suche</span>
                      <input
                        className="field-input"
                        type="search"
                        value={appState.searchQuery}
                        onChange={(event) => setSuche(event.target.value)}
                        placeholder="Produktname, Produzent, Verpackung, Gebinde..."
                      />
                    </label>
                    <label className="field">
                      <span className="field-label">Produzent</span>
                      <select
                        className="field-input"
                        value={appState.filters.producer}
                        onChange={(event) => setFilter('producer', event.target.value)}
                      >
                        <option value="">Alle</option>
                        {producerOptions.map((producer) => (
                          <option key={producer} value={producer}>
                            {producer}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <label className="field sort-control">
                    <span className="field-label">Sortierung</span>
                    <select
                      className="field-input field-input-quiet"
                      value={appState.sortMode}
                      onChange={(event) => setSortMode(event.target.value as SortMode)}
                    >
                      <option value="producer">Produzent, dann Name</option>
                      <option value="name">Name</option>
                      <option value="target-desc">Soll zuerst</option>
                      <option value="price-asc">Preis aufsteigend</option>
                      <option value="price-desc">Preis absteigend</option>
                    </select>
                  </label>
                </div>

                <div className="summary-strip">
                  <span>{sichtbarePlanRows.length} sichtbare Produkte</span>
                  <span>{planModel.sollCount} Produkte mit Soll-Wert</span>
                  <span>
                    Wenn kein Ist gesetzt ist, wird die Soll-Menge direkt bestellt.
                  </span>
                </div>

                <div className="catalog-grid">
                  {sichtbarePlanRows.map((row) => (
                    <ProductCard
                      key={row.product.id}
                      row={row}
                      onDecrease={() => nudgeSoll(row.product.id, row.target, -1)}
                      onIncrease={() => nudgeSoll(row.product.id, row.target, 1)}
                      onSollChange={(value) =>
                        setDraftValue(row.product.id, 'target', value)
                      }
                    />
                  ))}
                </div>

                {sichtbarePlanRows.length === 0 ? (
                  <EmptyState
                    title="Keine Produkte passend zur aktuellen Filterung"
                    description="Versuche eine breitere Suche oder setze den Produzentenfilter zurück."
                  />
                ) : null}
              </>
            ) : (
              <>
                <div className="inventory-topline">
                  <div className="filters-grid filters-grid-tight">
                    <label className="field field-wide">
                      <span className="field-label">Produkte in der Inventur suchen</span>
                      <input
                        className="field-input"
                        type="search"
                        value={appState.inventoryQuery}
                        onChange={(event) => setInventurSuche(event.target.value)}
                        placeholder="Produktname, Produzent, Verpackung..."
                      />
                    </label>
                  </div>

                  <div className="inventory-summary">
                    <StatCard label="Soll gesetzt" value={planModel.sollCount.toString()} tone="leaf" />
                    <StatCard
                      label="Zu bestellen"
                      value={planModel.bestellCount.toString()}
                      tone="accent"
                    />
                    <StatCard
                      label="Nicht gefunden"
                      value={planModel.discontinued.length.toString()}
                      tone="neutral"
                    />
                  </div>
                </div>

                <div className="inventory-actions">
                  <span className="helper-copy">
                    Die Inventur ist optional. Bereits ausgewählte Produkte stehen oben;
                    weitere Produkte kannst du unten zur Inventur hinzufügen.
                  </span>
                </div>

                <section className="inventory-section inventory-section-active">
                  <div className="inventory-section-head">
                    <div>
                      <span className="eyebrow">Inventur</span>
                      <h3>Ausgewählte Produkte</h3>
                    </div>
                    <span className="section-count">
                      {planModel.rows.length} Produkte
                    </span>
                  </div>

                  <div className="inventory-list">
                    {planModel.rows.map((row) => (
                      <InventoryRowCard
                        key={row.product.id}
                        row={row}
                        onSollChange={(value) =>
                          setDraftValue(row.product.id, 'target', value)
                        }
                        onIstChange={(value) =>
                          setDraftValue(row.product.id, 'actual', value)
                        }
                        onOrderChange={(value) =>
                          setDraftValue(row.product.id, 'order', value)
                        }
                        onOrderDecrease={() => nudgeOrder(row.product.id, row.order, -1)}
                        onOrderIncrease={() => nudgeOrder(row.product.id, row.order, 1)}
                        onResetOrder={() => resetOrderOverride(row.product.id)}
                      />
                    ))}
                  </div>
                </section>

                {planModel.rows.length === 0 ? (
                  <EmptyState
                    title="Noch keine Produkte in der Inventur"
                    description="Füge unten ein Produkt hinzu oder importiere eine vorige Liste mit Soll-Werten."
                  />
                ) : null}

                {planModel.discontinued.length > 0 ? (
                  <section className="discontinued-panel">
                    <div className="panel-head">
                      <div>
                        <span className="eyebrow">Nicht mehr verfügbar</span>
                        <h3>Produkte aus der vorigen Liste ohne Treffer in der aktuellen Datei</h3>
                        <p className="discontinued-copy">
                          Diese Positionen sind in der alten Datei vorhanden, aber in
                          der aktuellen Bestellliste nicht mehr enthalten.
                        </p>
                      </div>
                    </div>
                    <div className="discontinued-list">
                      {planModel.discontinued
                        .filter((product) => previousTarget(product) > 0)
                        .map((product) => (
                          <div key={product.id} className="discontinued-item">
                            <div>
                              <strong>{product.name}</strong>
                              <span>{product.producer || 'Produzent unbekannt'}</span>
                            </div>
                            <div className="discontinued-meta">
                              <span>{buildBulkLabel(product)}</span>
                              <span>
                                Letztes Soll: {formatQuantity(previousTarget(product))}
                              </span>
                            </div>
                          </div>
                        ))}
                    </div>
                  </section>
                ) : null}

                <section className="inventory-section inventory-section-add">
                  <div className="inventory-section-head">
                    <div>
                      <span className="eyebrow">Weitere Produkte</span>
                      <h3>Zur Inventur hinzufügen</h3>
                    </div>
                    <span className="section-count">
                      {planModel.addableRows.length} Produkte
                    </span>
                  </div>
                  <div className="inventory-add-list">
                    {planModel.addableRows.map((row) => (
                      <AddInventoryProductCard
                        key={row.product.id}
                        row={row}
                        onAdd={() => addProductToInventory(row.product.id)}
                      />
                    ))}
                  </div>
                </section>

                {planModel.addableRows.length === 0 ? (
                  <EmptyState
                    title="Keine weiteren Produkte sichtbar"
                    description="Die Suche filtert alles weg oder alle passenden Produkte sind bereits in der aktiven Inventur."
                    compact
                  />
                ) : null}
              </>
            )
          ) : (
            <EmptyState
              title="Bitte zuerst die aktuelle Bestellliste importieren"
              description="Danach wird hier der Katalog mit Soll-Eingabe und Inventuransicht angezeigt."
            />
          )}
        </main>

        <aside className="cart-panel panel">
          <div className="panel-head">
            <div>
              <span className="eyebrow">Bestellübersicht</span>
              <h2>Bestellung</h2>
            </div>
            <button
              className="button button-primary"
              type="button"
              onClick={() => void exportCurrentWorkbook()}
              disabled={!appState.currentWorkbook || busyState.export}
            >
              {busyState.export ? 'Export läuft...' : 'Excel exportieren'}
            </button>
          </div>

          <div className="cart-metrics">
            <Metric label="Positionen" value={positionsAnzahl.toString()} />
            <Metric label="Summe" value={formatCurrency(bestellSumme)} />
          </div>

          {bestellRows.length > 0 ? (
            <div className="cart-list">
              {bestellRows.map((row) => (
                <CartRow key={row.product.id} row={row} />
              ))}
            </div>
          ) : (
            <EmptyState
              title="Noch keine Bestellung"
              description="Setze im Katalog einen Soll-Wert oder fülle die Inventur aus."
              compact
            />
          )}

          <div className="cart-footer">
            <div className="cart-total">
              <span>Geschätzte Summe</span>
              <strong>{formatCurrency(bestellSumme)}</strong>
            </div>
            <p className="helper-copy">
              Exportiert werden immer die Spalten <strong>Soll</strong>, <strong>Ist</strong>{' '}
              und <strong>Bestellung</strong>. Die Bestellmenge ergibt sich aus Soll minus
              Ist oder direkt aus Soll, falls kein Ist gesetzt ist. In der Inventur kann
              sie bei Bedarf manuell gerundet werden.
            </p>
          </div>
        </aside>
      </div>
    </div>
  )
}

function matchesKatalogFilter(
  product: Product,
  query: string,
  appState: PersistedAppState,
) {
  const normalizedQuery = normalizeKey(query)

  if (normalizedQuery && !product.searchText.includes(normalizedQuery)) {
    return false
  }

  if (
    appState.filters.producer &&
    product.producer !== appState.filters.producer
  ) {
    return false
  }

  return true
}

function buildPlanModel(
  currentProducts: Product[],
  previousProducts: Product[],
  drafts: Record<string, InventoryDraft>,
  query: string,
): PlanModel {
  const index = buildProductIndex(previousProducts)
  const matchedPreviousIds = new Set<string>()
  const normalizedQuery = normalizeKey(query)

  const allRows = currentProducts
    .map((product) => {
      const previousMatch = findProductMatch(index, product)
      if (previousMatch) {
        matchedPreviousIds.add(previousMatch.id)
      }

      const draft = drafts[product.id]
      const fallbackTarget = fallbackTargetQuantity(product, previousMatch)
      const fallbackActual = fallbackActualQuantity(product, previousMatch)
      
      const targetInput = draft?.target ?? formatNumberInput(fallbackTarget)
      const actualInput = draft?.actual ?? formatNullableNumberInput(fallbackActual)
      const target = resolveTargetQuantity(draft?.target, fallbackTarget)
      const actual = resolveActualQuantity(draft?.actual, fallbackActual)
      const difference =
        actual === null ? target : roundQuantity(target - actual)
      const derivedOrder =
        actual === null
          ? target
          : roundQuantity(Math.max(0, target - actual))
      const orderInput = draft?.order ?? formatNumberInput(derivedOrder)
      const order = resolveOrderQuantity(draft?.order, derivedOrder)

      return {
        product,
        previousMatch,
        target,
        actual,
        derivedOrder,
        order,
        difference,
        targetInput,
        actualInput,
        orderInput,
        hasOrderOverride:
          draft?.order !== undefined && draft.order.trim() !== '',
      }
    })
    .sort((left, right) => compareProducts(left.product, right.product))

  const matchingRows = allRows.filter((row) => {
    if (!normalizedQuery) {
      return true
    }

    return row.product.searchText.includes(normalizedQuery)
  })

  const rows = matchingRows.filter((row) => row.target > 0)
  const addableRows = matchingRows.filter((row) => row.target <= 0)

  const discontinued = previousProducts
    .filter((product) => !matchedPreviousIds.has(product.id))
    .sort(compareProducts)

  return {
    rows,
    addableRows,
    allRows,
    discontinued,
    matchedCount: matchedPreviousIds.size,
    sollCount: allRows.filter((row) => row.target > 0).length,
    bestellCount: allRows.filter((row) => row.order > 0).length,
  }
}

function buildProductIndex(products: Product[]): ProductIndex {
  const bySku = new Map<string, Product>()
  const byNameProducer = new Map<string, Product>()
  const byName = new Map<string, Product>()

  for (const product of products) {
    if (product.skuKey && !bySku.has(product.skuKey)) {
      bySku.set(product.skuKey, product)
    }

    const nameProducerKey = createNameProducerKey(product.nameKey, product.producerKey)
    if (nameProducerKey && !byNameProducer.has(nameProducerKey)) {
      byNameProducer.set(nameProducerKey, product)
    }

    if (product.nameKey && !byName.has(product.nameKey)) {
      byName.set(product.nameKey, product)
    }
  }

  return {
    bySku,
    byNameProducer,
    byName,
  }
}

function findProductMatch(index: ProductIndex, product: Product) {
  if (product.skuKey && index.bySku.has(product.skuKey)) {
    return index.bySku.get(product.skuKey) ?? null
  }

  const nameProducerKey = createNameProducerKey(product.nameKey, product.producerKey)
  if (nameProducerKey && index.byNameProducer.has(nameProducerKey)) {
    return index.byNameProducer.get(nameProducerKey) ?? null
  }

  if (product.nameKey && index.byName.has(product.nameKey)) {
    return index.byName.get(product.nameKey) ?? null
  }

  return null
}

function remapInventoryDrafts(
  oldProducts: Product[],
  drafts: Record<string, InventoryDraft>,
  nextProducts: Product[],
) {
  const lookup = new Map<string, InventoryDraft>()

  for (const product of oldProducts) {
    const draft = drafts[product.id]
    if (!draft) {
      continue
    }

    for (const key of productLookupKeys(product)) {
      if (!lookup.has(key)) {
        lookup.set(key, draft)
      }
    }
  }

  return nextProducts.reduce<Record<string, InventoryDraft>>((result, product) => {
    for (const key of productLookupKeys(product)) {
      if (lookup.has(key)) {
        result[product.id] = lookup.get(key) ?? {}
        break
      }
    }
    return result
  }, {})
}

function productLookupKeys(product: Product) {
  const keys = []

  if (product.skuKey) {
    keys.push(`sku:${product.skuKey}`)
  }

  if (product.nameKey && product.producerKey) {
    keys.push(`np:${createNameProducerKey(product.nameKey, product.producerKey)}`)
  }

  if (product.nameKey) {
    keys.push(`n:${product.nameKey}`)
  }

  return keys
}

function createNameProducerKey(nameKey: string, producerKey: string) {
  if (!nameKey) {
    return ''
  }

  return producerKey ? `${nameKey}::${producerKey}` : nameKey
}

function buildConfigOverride(
  source: WorkbookSource,
  partialConfig: Partial<WorkbookSource['config']>,
) {
  const baseOverride: Partial<WorkbookSource['config']> = {
    sheetName: partialConfig.sheetName ?? source.config.sheetName,
    headerRow: partialConfig.headerRow ?? source.config.headerRow,
  }

  if (partialConfig.mapping) {
    const resetMapping =
      partialConfig.sheetName !== undefined || partialConfig.headerRow !== undefined

    baseOverride.mapping = resetMapping
      ? partialConfig.mapping
      : {
          ...source.config.mapping,
          ...partialConfig.mapping,
        }
  }

  return baseOverride
}

function fallbackTargetQuantity(product: Product, previousMatch: Product | null) {
  if (product.targetQuantity !== null && product.targetQuantity !== undefined) {
    return product.targetQuantity
  }

  if (product.orderQuantity > 0) {
    return product.orderQuantity
  }

  if (previousMatch) {
    return previousTarget(previousMatch)
  }

  return 0
}

function fallbackActualQuantity(product: Product, previousMatch: Product | null) {
  if (product.actualQuantity !== null && product.actualQuantity !== undefined) {
    return product.actualQuantity
  }
  if (previousMatch) {
    return previousActual(previousMatch)
  }
  return null
}

function previousTarget(product: Product) {
  if (product.targetQuantity !== null && product.targetQuantity !== undefined) {
    return product.targetQuantity
  }

  return product.orderQuantity > 0 ? product.orderQuantity : 0
}

function previousActual(product: Product) {
  if (product.actualQuantity !== null && product.actualQuantity !== undefined) {
    return product.actualQuantity
  }
  return null
}

function resolveTargetQuantity(value: string | undefined, fallback: number) {
  if (value === undefined) {
    return roundQuantity(Math.max(0, fallback))
  }

  if (value.trim() === '') {
    return 0
  }

  return roundQuantity(Math.max(0, parseNumber(value) ?? 0))
}

function resolveActualQuantity(
  value: string | undefined,
  fallback: number | null,
) {
  if (value === undefined) {
    return fallback === null ? null : roundQuantity(Math.max(0, fallback))
  }

  if (value.trim() === '') {
    return null
  }

  return roundQuantity(Math.max(0, parseNumber(value) ?? 0))
}

function resolveOrderQuantity(value: string | undefined, fallback: number) {
  if (value === undefined || value.trim() === '') {
    return roundQuantity(Math.max(0, fallback))
  }

  return roundQuantity(Math.max(0, parseNumber(value) ?? fallback))
}

function compareProducts(left: Product, right: Product) {
  return (
    left.producer.localeCompare(right.producer) ||
    left.name.localeCompare(right.name)
  )
}

function comparePlanRows(left: PlanRow, right: PlanRow, sortMode: SortMode) {
  if (sortMode === 'name') {
    return left.product.name.localeCompare(right.product.name) || compareProducts(left.product, right.product)
  }

  if (sortMode === 'target-desc') {
    return right.target - left.target || compareProducts(left.product, right.product)
  }

  if (sortMode === 'price-asc') {
    return compareNullablePrice(left.product.price, right.product.price) || compareProducts(left.product, right.product)
  }

  if (sortMode === 'price-desc') {
    return compareNullablePrice(right.product.price, left.product.price) || compareProducts(left.product, right.product)
  }

  return compareProducts(left.product, right.product)
}

function compareNullablePrice(left: number | null, right: number | null) {
  if (left === null && right === null) {
    return 0
  }

  if (left === null) {
    return 1
  }

  if (right === null) {
    return -1
  }

  return left - right
}

function uniqueSortedValues(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort((left, right) =>
    left.localeCompare(right),
  )
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat('de-CH', {
    style: 'currency',
    currency: 'CHF',
    maximumFractionDigits: 2,
  }).format(value)
}

function formatQuantity(value: number) {
  return new Intl.NumberFormat('de-CH', {
    maximumFractionDigits: 3,
  }).format(value)
}

function formatNumberInput(value: number) {
  return value > 0 ? String(value) : ''
}

function formatNullableNumberInput(value: number | null) {
  return value === null ? '' : String(value)
}

function roundQuantity(value: number) {
  return Math.round(value * 1000) / 1000
}

function hasDecimalPart(value: number) {
  return Math.abs(value - Math.round(value)) > 0.000001
}

function buildBulkLabel(product: Product) {
  if (product.packSize && product.category) {
    return `${product.packSize} x ${product.category}`
  }

  return product.packSize || product.category || 'Gebinde nicht angegeben'
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('de-CH', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function MessageBanner({
  children,
  tone,
}: {
  children: ReactNode
  tone: 'success' | 'error'
}) {
  return <div className={`message-banner tone-${tone}`}>{children}</div>
}

function WarningList({ warnings }: { warnings: string[] }) {
  return (
    <div className="warning-list">
      {warnings.map((warning) => (
        <div key={warning} className="warning-item">
          {warning}
        </div>
      ))}
    </div>
  )
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone: 'accent' | 'leaf' | 'neutral'
}) {
  return (
    <div className={`stat-card tone-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function RailStep({
  title,
  description,
  isReady,
  optional = false,
}: {
  title: string
  description: string
  isReady: boolean
  optional?: boolean
}) {
  return (
    <article
      className={`rail-step ${
        isReady ? 'is-ready' : optional ? 'is-optional' : ''
      }`}
    >
      <div className="rail-badge">
        {isReady ? 'bereit' : optional ? 'optional' : 'offen'}
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
    </article>
  )
}

function ImportCard({
  title,
  subtitle,
  source,
  busy,
  onSelectFile,
  onDropFile,
  children,
}: {
  title: string
  subtitle: string
  source: WorkbookSource | null
  busy: boolean
  onSelectFile: () => void
  onDropFile: (file: File) => void
  children: ReactNode
}) {
  const [isDragging, setIsDragging] = useState(false)

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setIsDragging(false)
    const file = event.dataTransfer.files?.[0]
    if (file) {
      onDropFile(file)
    }
  }

  return (
    <section
      className={`panel upload-card ${isDragging ? 'is-dragging' : ''}`}
      onDragOver={(event) => {
        event.preventDefault()
        setIsDragging(true)
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
    >
      <div className="panel-head">
        <div>
          <span className="eyebrow">{title}</span>
          <h2>{subtitle}</h2>
        </div>
        <button
          className="button button-secondary"
          type="button"
          onClick={onSelectFile}
          disabled={busy}
        >
          {busy ? 'Bitte warten...' : source ? 'Datei ersetzen' : 'Datei wählen'}
        </button>
      </div>
      {children}
    </section>
  )
}

function MappingEditor({
  source,
  busy,
  onConfigChange,
}: {
  source: WorkbookSource
  busy: boolean
  onConfigChange: (config: Partial<WorkbookSource['config']>) => void
}) {
  const currentSheet = source.sheetOptions.find(
    (sheet) => sheet.name === source.config.sheetName,
  )

  return (
    <div className="mapping-editor">
      <div className="mapping-grid">
        <label className="field">
          <span className="field-label">Tabellenblatt</span>
          <select
            className="field-input"
            value={source.config.sheetName}
            onChange={(event) => onConfigChange({ sheetName: event.target.value })}
            disabled={busy}
          >
            {source.sheetOptions.map((sheet) => (
              <option key={sheet.name} value={sheet.name}>
                {sheet.name}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="field-label">Kopfzeile</span>
          <select
            className="field-input"
            value={source.config.headerRow}
            onChange={(event) =>
              onConfigChange({ headerRow: Number(event.target.value) })
            }
            disabled={busy}
          >
            {currentSheet?.headerCandidates.map((candidate) => (
              <option key={candidate.rowNumber} value={candidate.rowNumber}>
                Zeile {candidate.rowNumber}: {candidate.preview}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mapping-fields">
        {COLUMN_ROLE_ORDER.map((role) => (
          <label key={role} className="field">
            <span className="field-label">{ROLE_LABELS[role]}</span>
            <select
              className="field-input"
              value={source.config.mapping[role] ?? ''}
              onChange={(event) =>
                onConfigChange({
                  mapping: {
                    [role]:
                      event.target.value === ''
                        ? undefined
                        : Number(event.target.value),
                  } as ColumnMapping,
                })
              }
              disabled={busy}
            >
              <option value="">Nicht verwendet</option>
              {source.columns.map((column) => (
                <option key={column.index} value={column.index}>
                  {column.label}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
    </div>
  )
}

function ProductCard({
  row,
  onDecrease,
  onIncrease,
  onSollChange,
}: {
  row: PlanRow
  onDecrease: () => void
  onIncrease: () => void
  onSollChange: (value: string) => void
}) {
  const subtotal =
    row.order > 0 && row.product.price !== null
      ? row.order * row.product.price
      : null

  return (
    <article className="product-card">
      <div className="product-head">
        <div>
          <h3>{row.product.name}</h3>
          <p>{row.product.producer || 'Produzent unbekannt'}</p>
        </div>
        {row.product.category ? <span className="pill">{row.product.category}</span> : null}
      </div>

      <div className="product-meta">
        <span>Gebinde: {buildBulkLabel(row.product)}</span>
        <span>
          Preis: {row.product.price !== null ? formatCurrency(row.product.price) : 'nicht erkannt'}
        </span>
      </div>

      <div className="quantity-stepper">
        <button className="qty-button" type="button" onClick={onDecrease}>
          -
        </button>
        <label className="qty-field">
          <span>Soll</span>
          <input
            className="qty-input"
            type="text"
            inputMode="decimal"
            value={row.targetInput}
            onChange={(event) => onSollChange(event.target.value)}
            placeholder="0"
          />
        </label>
        <button className="qty-button" type="button" onClick={onIncrease}>
          +
        </button>
      </div>

      <div className="product-footer">
        <span>
          {row.actual === null
            ? `Bestellung: ${formatQuantity(row.order)}`
            : `Ist ${formatQuantity(row.actual)} -> Bestellung ${formatQuantity(row.order)}`}
        </span>
        <strong>{subtotal !== null ? formatCurrency(subtotal) : ' '}</strong>
      </div>
    </article>
  )
}

function InventoryRowCard({
  row,
  onSollChange,
  onIstChange,
  onOrderChange,
  onOrderDecrease,
  onOrderIncrease,
  onResetOrder,
}: {
  row: PlanRow
  onSollChange: (value: string) => void
  onIstChange: (value: string) => void
  onOrderChange: (value: string) => void
  onOrderDecrease: () => void
  onOrderIncrease: () => void
  onResetOrder: () => void
}) {
  return (
    <article className={`inventory-row ${row.hasOrderOverride ? 'has-order-override' : ''}`}>
      <div className="inventory-product">
        <div>
          <h3>{row.product.name}</h3>
          <p>{row.product.producer || 'Produzent unbekannt'}</p>
        </div>
        <div className="inventory-badges">
          <span className="pill">{buildBulkLabel(row.product)}</span>
          {row.previousMatch ? (
            <span
              className="pill pill-leaf pill-icon"
              title="Treffer aus vorheriger Liste"
              aria-label="Treffer aus vorheriger Liste"
            >
              ✓
            </span>
          ) : (
            <span className="pill">Kein Treffer</span>
          )}
        </div>
      </div>

      <div className="inventory-grid">
        <label className="field">
          <span className="field-label">Soll</span>
          <input
            className="field-input"
            type="text"
            inputMode="decimal"
            value={row.targetInput}
            onChange={(event) => onSollChange(event.target.value)}
            placeholder="0"
          />
        </label>
        <label className="field">
          <span className="field-label">Ist</span>
          <input
            className="field-input"
            type="text"
            inputMode="decimal"
            value={row.actualInput}
            onChange={(event) => onIstChange(event.target.value)}
            placeholder="0"
          />
        </label>
        <label className="field">
          <span className="field-label">Differenz</span>
          <input
            className="field-input field-input-readonly"
            type="text"
            value={formatQuantity(row.difference)}
            readOnly
          />
        </label>
        <label className="field order-field">
          <span className="field-label">Bestellung</span>
          <div className="order-input-row">
            <div className="number-stepper">
              <input
                className="field-input number-stepper-input"
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                value={row.orderInput}
                onChange={(event) => onOrderChange(event.target.value)}
                placeholder={formatQuantity(row.derivedOrder)}
              />
              <div className="number-stepper-actions">
              <button
                  className="stepper-button"
                  type="button"
                  aria-label="Bestellung erhöhen"
                  onClick={onOrderIncrease}
                >
                  +
                </button>
                <button
                  className="stepper-button"
                  type="button"
                  aria-label="Bestellung verringern"
                  onClick={onOrderDecrease}
                >
                  -
                </button>
              </div>
            </div>
            <button
              title="Auf automatisch berechneten Wert zurücksetzen"
              className="tiny-button auto-button"
              type="button"
              onClick={onResetOrder}
              disabled={!row.hasOrderOverride}
            >
              Auto
            </button>
          </div>
        </label>
      </div>
    </article>
  )
}

function AddInventoryProductCard({
  row,
  onAdd,
}: {
  row: PlanRow
  onAdd: () => void
}) {
  return (
    <article className="add-product-card">
      <div>
        <strong>{row.product.name}</strong>
        <span>{row.product.producer || 'Produzent unbekannt'}</span>
        <span>{buildBulkLabel(row.product)}</span>
      </div>
      <button className="button button-secondary" type="button" onClick={onAdd}>
        Zur Inventur hinzufügen
      </button>
    </article>
  )
}

function CartRow({ row }: { row: PlanRow }) {
  const subtotal =
    row.product.price !== null ? row.product.price * row.order : null

  return (
    <article className="cart-row">
      <div className="cart-row-copy">
        <strong>{row.product.name}</strong>
        <span>{row.product.producer || 'Produzent unbekannt'}</span>
      </div>
      <div className="cart-row-actions">
        <span>
          x {formatQuantity(row.order)}
          {row.actual !== null ? ` / Ist ${formatQuantity(row.actual)}` : ''}
          {row.hasOrderOverride ? ' / manuell' : ''}
        </span>
        <strong>{subtotal !== null ? formatCurrency(subtotal) : ' '}</strong>
      </div>
    </article>
  )
}

function Metric({
  label,
  value,
  highlight = false,
}: {
  label: string
  value: string
  highlight?: boolean
}) {
  return (
    <div className={`metric ${highlight ? 'is-highlight' : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      className={`tab-button ${active ? 'is-active' : ''}`}
      type="button"
      onClick={onClick}
    >
      {label}
    </button>
  )
}

function EmptyState({
  title,
  description,
  compact = false,
}: {
  title: string
  description: string
  compact?: boolean
}) {
  return (
    <div className={`empty-state ${compact ? 'is-compact' : ''}`}>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  )
}

export default App
