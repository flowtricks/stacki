// The application menu as data. It is built from `translate`, so the same function serves every language and a test can drive it
// without Electron. `main.ts` owns the actions (sending to the window, the updater, relaunching) and hands them in.
//
// Every item is spelled out with its role and a translated label (the app, View and Window menus included), so the whole bar follows
// the language chosen in Settings instead of mixing it with the operating system's.
import type { MenuItemConstructorOptions } from 'electron';
import type { MainMessageKey } from '../lib/mainLocale';

/** What the View menu's reload items ask for: the site preview refreshed (⌘R, ⇧⌘R), or Stacki itself reloaded (the escape hatch). */
export type ReloadCommand = 'refreshSite' | 'reloadStacki';

export interface ApplicationMenuOptions {
  readonly isMac: boolean;
  readonly isDev: boolean;
  readonly translate: (key: MainMessageKey) => string;
  /** Forwards a menu command to the renderer, which decides between app-level actions and native ones. */
  readonly send: (channel: string) => void;
  readonly checkForUpdates: () => void;
  /** Runs a reload; `main.ts` asks `routeReload` (reloadRouting.ts) whether there is a preview to refresh. */
  readonly reload: (command: ReloadCommand) => void;
}

// ⌘R and ⇧⌘R always refresh the site preview, wherever focus is: the person is looking at the site, and reloading Stacki under
// them lost their place. Stacki's own reload stays reachable for developers (⌥⌘R in a dev run, where it relaunches the process so
// edits to the main side take effect) and, without an accelerator, in a packaged build so a stuck window can still be recovered.
export function buildApplicationMenuTemplate(options: ApplicationMenuOptions): MenuItemConstructorOptions[] {
  const translate = options.translate;
  const send = options.send;
  return [
    ...(options.isMac ? [appMenu(translate)] : []),
    {
      // Spelled out rather than `role: 'fileMenu'`, which takes no additions. What that role provides is one item (Close Window on
      // macOS, Quit everywhere else), so the menu keeps exactly what it had, with the update check above it.
      label: translate('menu.file.title'),
      submenu: [
        { label: translate('menu.file.settings'), accelerator: 'CmdOrCtrl+,', click: () => send('menu:settings') }, // i18n-ignore: keyboard accelerator.
        { type: 'separator' },
        // The only way out of a project used to be closing the app, and on macOS closing the app is not what people think it is: the
        // window goes and the process stays, so coming back lands on the same project and nothing says otherwise.
        { label: translate('menu.file.openProject'), accelerator: 'CmdOrCtrl+O', click: () => send('menu:openProject') }, // i18n-ignore: keyboard accelerator.
        { label: translate('menu.file.closeProject'), accelerator: 'Shift+CmdOrCtrl+W', click: () => send('menu:closeProject') }, // i18n-ignore: keyboard accelerator.
        { type: 'separator' },
        { label: translate('menu.file.checkForUpdates'), click: () => options.checkForUpdates() },
        { type: 'separator' },
        options.isMac ? { role: 'close', label: translate('menu.file.closeWindow') } : { role: 'quit', label: translate('menu.file.quit') },
      ],
    },
    {
      label: translate('menu.edit.title'),
      submenu: [
        { label: translate('menu.edit.undo'), accelerator: 'CmdOrCtrl+Z', click: () => send('menu:undo') }, // i18n-ignore: keyboard accelerator.
        { label: translate('menu.edit.redo'), accelerator: 'Shift+CmdOrCtrl+Z', click: () => send('menu:redo') }, // i18n-ignore: keyboard accelerator.
        { type: 'separator' },
        { role: 'cut', label: translate('menu.edit.cut') },
        { label: translate('menu.edit.copy'), accelerator: 'CmdOrCtrl+C', click: () => send('menu:copy') }, // i18n-ignore: keyboard accelerator.
        { label: translate('menu.edit.paste'), accelerator: 'CmdOrCtrl+V', click: () => send('menu:paste') }, // i18n-ignore: keyboard accelerator.
        { role: 'selectAll', label: translate('menu.edit.selectAll') },
        { type: 'separator' },
        { label: translate('menu.edit.copySelection'), accelerator: 'Shift+CmdOrCtrl+C', click: () => send('menu:copySelection') }, // i18n-ignore: keyboard accelerator.
        { label: translate('menu.edit.insertElement'), accelerator: 'CmdOrCtrl+E', click: () => send('menu:insert') }, // i18n-ignore: keyboard accelerator.
      ],
    },
    {
      label: translate('menu.view.title'),
      submenu: [
        { label: translate('menu.view.reload'), accelerator: 'CmdOrCtrl+R', click: () => options.reload('refreshSite') }, // i18n-ignore: keyboard accelerator.
        { label: translate('menu.view.forceReload'), accelerator: 'Shift+CmdOrCtrl+R', click: () => options.reload('refreshSite') }, // i18n-ignore: keyboard accelerator.
        options.isDev
          ? { label: translate('menu.view.reloadAllCode'), accelerator: 'Alt+CmdOrCtrl+R', click: () => options.reload('reloadStacki') } // i18n-ignore: keyboard accelerator.
          : { label: translate('menu.view.reloadAllCode'), click: () => options.reload('reloadStacki') },
        { type: 'separator' },
        { role: 'toggleDevTools', label: translate('menu.view.toggleDevTools') },
        { type: 'separator' },
        { role: 'resetZoom', label: translate('menu.view.actualSize') },
        { role: 'zoomIn', label: translate('menu.view.zoomIn') },
        { role: 'zoomOut', label: translate('menu.view.zoomOut') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: translate('menu.view.fullScreen') },
      ],
    },
    windowMenu({ isMac: options.isMac, translate }),
  ];
}

// What Electron's `appMenu` role provides, spelled out so its words follow the language chosen in Settings rather than the
// operating system's. macOS shows the application's own name over the label of the first menu whatever it says here.
function appMenu(translate: ApplicationMenuOptions['translate']): MenuItemConstructorOptions {
  return {
    label: 'Stacki', // i18n-ignore: the product name, replaced by macOS with the bundle name anyway.
    submenu: [
      { role: 'about', label: translate('menu.app.about') },
      { type: 'separator' },
      { role: 'services', label: translate('menu.app.services') },
      { type: 'separator' },
      { role: 'hide', label: translate('menu.app.hide') },
      { role: 'hideOthers', label: translate('menu.app.hideOthers') },
      { role: 'unhide', label: translate('menu.app.showAll') },
      { type: 'separator' },
      { role: 'quit', label: translate('menu.app.quit') },
    ],
  };
}

// What the `windowMenu` role provides (Minimize, Zoom, then Bring All to Front on macOS or Close elsewhere).
function windowMenu(options: Pick<ApplicationMenuOptions, 'isMac' | 'translate'>): MenuItemConstructorOptions {
  const { isMac, translate } = options;
  return {
    label: translate('menu.window.title'),
    submenu: [
      { role: 'minimize', label: translate('menu.window.minimize') },
      { role: 'zoom', label: translate('menu.window.zoom') },
      ...(isMac
        ? [{ type: 'separator' as const }, { role: 'front' as const, label: translate('menu.window.bringAllToFront') }]
        : [{ role: 'close' as const, label: translate('menu.window.close') }]),
    ],
  };
}
