// Goal: open the element panel's Settings group from the browser tests whatever state it starts in.
// Since 1.1.0 the group is open by default and remembered, so a test that clicked its header to open
// it closed it instead (the 1.1.7 Studio browser failure). Clicking only when it is collapsed
// works for both the old and the remembered state, and the check reads the header's own aria-expanded.
import type { Page } from 'playwright';

export async function openSettingsGroup(page: Page): Promise<void> {
  const header = page
    .locator('.props-group-head')
    .filter({ hasText: /^Settings/ })
    .first();
  await header.waitFor();
  if ((await header.getAttribute('aria-expanded')) !== 'true') {
    await header.click();
  }
  await page.locator('.props-group-head[aria-expanded="true"]').first().waitFor();
}
