// French `menu` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/menu';

export const messages = {
  'menu.app.about': 'À propos de Stacki',
  'menu.app.hide': 'Masquer Stacki',
  'menu.app.hideOthers': 'Masquer les autres',
  'menu.app.quit': 'Quitter Stacki',
  'menu.app.services': 'Services', // same
  'menu.app.showAll': 'Tout afficher',
  'menu.edit.copy': 'Copier',
  'menu.edit.copySelection': 'Copier la sélection',
  'menu.edit.cut': 'Couper',
  'menu.edit.insertElement': 'Insérer un élément…',
  'menu.edit.paste': 'Coller',
  'menu.edit.redo': 'Rétablir',
  'menu.edit.selectAll': 'Tout sélectionner',
  'menu.edit.title': 'Édition',
  'menu.edit.undo': 'Annuler',
  'menu.file.checkForUpdates': 'Rechercher des mises à jour…',
  'menu.file.closeProject': 'Fermer le projet',
  'menu.file.closeWindow': 'Fermer la fenêtre',
  'menu.file.openProject': 'Ouvrir un projet…',
  'menu.file.quit': 'Quitter',
  'menu.file.settings': 'Réglages…',
  'menu.file.title': 'Fichier',
  'menu.view.actualSize': 'Taille réelle',
  'menu.view.forceReload': 'Forcer l’actualisation',
  'menu.view.fullScreen': 'Plein écran',
  'menu.view.reload': 'Actualiser',
  'menu.view.reloadAllCode': 'Recharger tout le code',
  'menu.view.reloadWindow': 'Recharger uniquement la fenêtre',
  'menu.view.title': 'Affichage',
  'menu.view.toggleDevTools': 'Afficher ou masquer les outils de développement',
  'menu.view.zoomIn': 'Zoom avant',
  'menu.view.zoomOut': 'Zoom arrière',
  'menu.window.bringAllToFront': 'Tout ramener au premier plan',
  'menu.window.close': 'Fermer',
  'menu.window.minimize': 'Réduire',
  'menu.window.title': 'Fenêtre',
  'menu.window.zoom': 'Zoom', // same
} as const satisfies CatalogOf<MessageKey>;
