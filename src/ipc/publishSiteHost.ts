// Studio supplies HTTP discovery while Desktop uses its native publishing service.
export const publishedSiteURL = (projectPath: string): Promise<unknown> => window.avb.publishedSiteURL(projectPath);
