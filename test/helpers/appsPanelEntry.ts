// One bundle for the Apps panel test (test/renderer/apps/appsPanel.test.js): the
// panel and the confirmation host share one ConfirmDialog module, so the
// panel's confirmations reach the host the test mounts; and the panel and the
// commands store share one module, so the commands the test configures are the
// ones the details popup lists.
export { default } from '../../src/features/apps/AppsPanel';
export { ConfirmHost } from '../../src/ui/ConfirmDialog';
export { configureAppCommands } from '../../src/features/apps/appCommands';
