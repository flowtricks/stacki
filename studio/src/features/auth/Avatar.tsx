import { useState } from 'react';
import { avatarURL } from './profile';

export function Avatar({ id, name }: { id: number | undefined; name: string }) {
  const [failed, setFailed] = useState(false);
  return id && !failed ? (
    <img src={avatarURL(id)} alt={`@${name}`} referrerPolicy="no-referrer" onError={() => setFailed(true)} />
  ) : (
    <>{name.slice(0, 2).toUpperCase()}</>
  );
}

// A person signed in by another provider: the picture it gave, or their initials when there is none or it will not load.
export function AccountAvatar({ name, avatarUrl }: { name: string; avatarUrl: string | undefined }) {
  const [failed, setFailed] = useState(false);
  return avatarUrl && !failed ? (
    <img src={avatarUrl} alt={name} referrerPolicy="no-referrer" onError={() => setFailed(true)} />
  ) : (
    <>{name.slice(0, 2).toUpperCase()}</>
  );
}
