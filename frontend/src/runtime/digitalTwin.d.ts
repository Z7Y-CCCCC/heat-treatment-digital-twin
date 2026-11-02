export type DashboardParameterValue = string | number | boolean | null
export type DashboardParameters = Record<string, DashboardParameterValue>
export interface DashboardContext {
  factoryId: string
  sceneId: string
  viewId: string
  viewMode: string
  workshopId: string
  lineId: string
  deviceId: string
  partId: string
}
export interface DashboardEvents {
  ready: DashboardContext
  contextChanged: DashboardContext
  viewChanged: DashboardContext
  deviceSelected: DashboardContext
  parametersChanged: DashboardParameters
  widgetAction: { widgetId: string; action: string }
}
export interface DigitalTwinInterface {
  readonly version: '1.0'
  ready(): Promise<DashboardContext>
  getContext(): Promise<DashboardContext>
  getParameters(): Promise<DashboardParameters>
  setParameters(patch: DashboardParameters): Promise<DashboardParameters>
  resetParameters(): Promise<DashboardParameters>
  refreshData(): Promise<unknown>
  switchView(id: string): Promise<boolean | null>
  focusDevice(id: string): Promise<boolean | null>
  setVisible(id: string, visible: boolean): Promise<boolean | null>
  on<K extends keyof DashboardEvents>(name: K, listener: (data: DashboardEvents[K]) => void): () => void
  off<K extends keyof DashboardEvents>(name: K, listener: (data: DashboardEvents[K]) => void): void
}
declare global {
  interface Window { DigitalTwin?: DigitalTwinInterface }
}
