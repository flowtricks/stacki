import { request } from '../project/projectClient';
import { record } from '../../shared/validation';

export async function publishedSiteURL(_projectPath: string): Promise<unknown> {
  return record(await request('/studio/api/publish/site-url'))['url'];
}
