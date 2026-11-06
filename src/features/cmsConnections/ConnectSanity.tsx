// The popup that connects Sanity, as Settings opens it, for other places that
// need a connection: the host's login where it has one, a pasted key otherwise.
import { CMS_CONNECTION_HOST } from '../../ipc/cmsConnectionsBridge';
import { CmsKeyForm } from './CmsKeyForm';
import { SanitySignIn } from './SanitySignIn';

export function ConnectSanity({ projectPath, close }: { readonly projectPath: string; readonly close: () => void }) {
  return CMS_CONNECTION_HOST.sanityLogin === 'none' ? (
    <CmsKeyForm projectPath={projectPath} cms="sanity" close={close} />
  ) : (
    <SanitySignIn projectPath={projectPath} close={close} />
  );
}
