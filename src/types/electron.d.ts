interface ElectronAPI {
  versions: { electron: string; node: string; chrome: string };
  setTitleBarTheme: (isDark: boolean) => void;
  openExternal: (url: string) => void;
  onOpenFolder: (callback: (path: string) => void) => void;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
