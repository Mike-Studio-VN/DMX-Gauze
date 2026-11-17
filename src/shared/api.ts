// Hợp đồng IPC giữa renderer và main. Renderer chạy web sẽ dùng mock.
export interface AppInfo {
  version: string
  platform: string
  runtime: 'electron' | 'web'
}

export interface GauzeBridge {
  getAppInfo(): Promise<AppInfo>
}
