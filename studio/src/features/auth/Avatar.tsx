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
