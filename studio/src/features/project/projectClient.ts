import { parseRenameFolders } from '../../../vendor/stacki/shared/properties/pageRenameConflicts';
import { parseWorkspaceId } from '../../shared/workspaceIdentity';
import { parseScanPages, type ScanPage } from '../../../vendor/stacki/shared/properties/projectScan';
import { parseNumericBindings, type NumericStyleBinding } from '../preview/numericStyleProtocol';
import { responseError, StudioRequestError } from './responseError';
import { parseField, type PropField } from '../../../vendor/stacki/shared/properties/propSchema';
import { beginOperation } from '../session/activity';
import { record, string } from '../../shared/validation';
import { componentFile } from '../../../vendor/stacki/shared/properties/componentDefaults';
import { parseComponentOrigin, type ComponentOrigin } from '../../../vendor/stacki/shared/properties/componentSources';
import { parseLengthUnit, type LengthUnit } from '../../../vendor/stacki/shared/properties/lengthUnit';

export interface Component {
  readonly origin?: ComponentOrigin;
  readonly importPath?: string;
  readonly numericStyles?: readonly NumericStyleBinding[];
  readonly renderTag?: { readonly tag?: string; readonly prop?: string };
  readonly file: string;
  readonly name: string;
  /** In one of the project's layout folders (.stacki/folders.json; by default src/layouts). */
  readonly isLayout?: true;
  /** The Components panel group, when the project chose its component folders. */
  readonly folder?: string;
  readonly fields: PropField[];
  readonly slots: string[];
  readonly slotText?: boolean;
  /** Whether it forwards arbitrary attributes (`...rest` on Astro.props), so its instances show Attributes. */
  readonly hasRest?: boolean;
}
export interface Project {
  readonly workspaceId?: string;
  readonly name: string;
  readonly pages: string[];
  readonly pageFolders?: readonly string[];
  readonly pageMetadata?: readonly ScanPage[];
  readonly collections: string[];
  readonly assets: string[];
  readonly components: Component[];
  readonly classes: string[];
  /** What the style panel writes lengths in (the same scan Desktop runs). Absent → px. */
  readonly lengthUnit?: LengthUnit;
}
let requestWorkspace = '';
let workspaceRevision = 0;
export async function request(url: string, options?: RequestInit): Promise<unknown> {
  const finish = beginOperation();
  const revision = workspaceRevision;
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        ...Object.fromEntries(new Headers(options?.headers)),
        'x-studio-workspace': requestWorkspace,
      },
      signal: options?.signal ?? AbortSignal.timeout(240_000),
    });
    if (!response.headers.get('Content-Type')?.includes('application/json')) {
      throw responseError(response);
    }
    const data: unknown = await response.json();
    if (response.ok && revision === workspaceRevision && (url.startsWith('/studio/api/git/') || url === '/studio/api/pages/rename')) {
      const identity = response.headers.get('x-studio-workspace');
      if (identity) {
        const parsed = parseWorkspaceId(identity) ?? '';
        if (parsed !== requestWorkspace) {
          requestWorkspace = parsed;
          workspaceRevision++;
        }
      }
    }
    if (!response.ok) {
      throw new StudioRequestError(string(record(data)['error'] ?? responseError(response).message), response.status);
    }
    return data;
  } catch (error) {
    if (error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError')) {
      throw new StudioRequestError('The connection to Studio was interrupted. Please retry shortly.', 0);
    }
    throw error;
  } finally {
    finish();
  }
}
function strings(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > 100_000) {
    throw new Error('Invalid list');
  }
  return input.map((item) => string(item));
}
export async function loadProject(signal?: AbortSignal): Promise<Project> {
  const revision = workspaceRevision;
  const project = parseProject(await request('/studio/api/project', signal ? { signal } : undefined));
  if (revision !== workspaceRevision) {
    throw new StudioRequestError('The shared branch changed while loading. Please retry.', 409);
  }
  requestWorkspace = project.workspaceId ?? '';
  return project;
}

export function parseProject(input: unknown): Project {
  const data = record(input);
  if (!Array.isArray(data['components'])) {
    throw new Error('Missing components');
  }
  const components = data['components'].map((input) => {
    const item = record(input);
    if (!Array.isArray(item['fields'])) {
      throw new Error('Invalid fields');
    }
    if (item['slotText'] !== undefined && typeof item['slotText'] !== 'boolean') {
      throw new Error('Invalid default slot type');
    }
    if (item['hasRest'] !== undefined && typeof item['hasRest'] !== 'boolean') {
      throw new Error('Invalid rest attributes flag');
    }
    return {
      file: componentFile(item['file']),
      origin: parseComponentOrigin(item['origin']),
      ...(item['importPath'] === undefined ? {} : { importPath: string(item['importPath'], 500) }),
      name: string(item['name']),
      ...parseLayoutFlag(item['isLayout']),
      ...(item['folder'] === undefined ? {} : { folder: string(item['folder'], 500) }),
      fields: item['fields'].map((field) => parseField(field, 'component')),
      slots: strings(item['slots']),
      numericStyles: parseNumericBindings(item['numericStyles']),
      slotText: item['slotText'] === true,
      hasRest: item['hasRest'] === true,
      ...parseRenderTag(item['renderTag']),
    };
  });
  const workspaceId = parseWorkspaceId(data['workspaceId']);
  return {
    name: string(data['name']),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    pages: strings(data['pages']),
    pageFolders: parseRenameFolders(data['pageFolders'] ?? []),
    pageMetadata: parseScanPages(data['pageMetadata'] ?? []),
    collections: strings(data['collections']),
    assets: strings(data['assets']),
    classes: strings(data['classes']),
    components,
    ...(data['lengthUnit'] === undefined ? {} : { lengthUnit: parseLengthUnit(data['lengthUnit']) }),
  };
}
function parseLayoutFlag(input: unknown): Pick<Component, 'isLayout'> {
  if (input === undefined) {
    return {};
  }
  if (input !== true) {
    throw new Error('Invalid layout flag');
  }
  return { isLayout: true };
}
function parseRenderTag(input: unknown): Pick<Component, 'renderTag'> {
  if (input === undefined) {
    return {};
  }
  const value = record(input);
  return {
    renderTag: {
      ...(value['tag'] === undefined ? {} : { tag: string(value['tag'], 100) }),
      ...(value['prop'] === undefined ? {} : { prop: string(value['prop'], 100) }),
    },
  };
}
export function routeFor(file: string) {
  if (isDefaultsCanvas(file)) {
    return defaultsCanvasRoute(file);
  }
  const relative = file
    .replace(/^src\/pages\//, '')
    .replace(/\.(astro|md|mdx)$/, '')
    .replace(/(^|\/)index$/, '');
  return '/' + relative;
}
import { isDefaultsCanvas, defaultsCanvasRoute } from '../../../vendor/stacki/shared/properties/defaultsCanvas';
