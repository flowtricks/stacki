// The one mapping from a sign-in provider to the icon drawn beside its name, so the "Sign-in: X" line in
// Settings and every row of the Change dialog show the same mark. Companies with a mark in the Central
// icon set (GitHub, Google) wear it; the rest wear a neutral Central icon, because Central has no mark for
// them and an icon from anywhere else is not allowed. Studio and the demo reuse these Desktop components.
import type { ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import { STUDIO_AUTH_KINDS, type StudioAuthKind } from '../../../shared/ipc/studioAuth';
import { centralIcon } from '../../ui/central/CentralIcon';
import { person } from '../../ui/central/centralGeometry';
import { CloudflareIcon, GitHubIcon, GoogleIcon, UsersIcon } from '../../ui/Icons';

type ProviderIcon = (props: { readonly size?: number }) => ReactNode;

/** Every provider the Studio sign-in can name: the kinds, and the custom provider an installed Studio may report. */
export type SignInProvider = StudioAuthKind | 'custom';

const PasskeyIcon = centralIcon(person);

const SIGN_IN_PROVIDER_ICONS: Readonly<Record<SignInProvider, ProviderIcon>> = {
  github: GitHubIcon,
  access: CloudflareIcon,
  google: GoogleIcon,
  oidc: UsersIcon,
  passkey: PasskeyIcon,
  custom: UsersIcon,
};

export const SIGN_IN_PROVIDERS: readonly SignInProvider[] = [...STUDIO_AUTH_KINDS, 'custom'];

/** The icon for a provider. An id outside the table is a programmer error and crashes rather than drawing nothing. */
export function signInProviderIcon(provider: string): ProviderIcon {
  const icon = Object.entries(SIGN_IN_PROVIDER_ICONS).find(([key]) => key === provider)?.[1];
  assert(icon !== undefined, `Sign-in provider has an icon: ${provider}`);
  return icon;
}

export function SignInProviderIcon({ provider, size }: { readonly provider: SignInProvider; readonly size: number }) {
  const Icon = signInProviderIcon(provider);
  return <Icon size={size} />;
}
