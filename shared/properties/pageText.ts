// Layouts can delegate metadata to components or a CMS. The rendered values
// cross the iframe boundary as bounded text, never as executable expressions.
import { object, optional, text } from '../core/boundary';

export const parsePageText = object({ title: optional(text), description: optional(text) });
export type PageText = Readonly<ReturnType<typeof parsePageText>>;
