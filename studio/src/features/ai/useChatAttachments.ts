import { useState } from 'react';
import { prepareImages } from './chatImages';
import { chatState, updateChat } from './chatState';
export function useChatAttachments(id: string) {
  const [loading, setLoading] = useState(false);
  async function attach(files: readonly File[]) {
    setLoading(true);
    try {
      const images = await prepareImages(files);
      updateChat(id, (thread) => {
        if (thread.images.length + images.length > 4) {
          return { ...thread, error: 'Attach up to four images per message.' };
        }
        const used = chatState().threads.reduce(
          (size, chat) =>
            size +
            chat.images.reduce((n, image) => n + image.url.length, 0) +
            chat.messages.reduce((n, message) => n + message.images.reduce((n, image) => n + image.url.length, 0), 0),
          0,
        );
        if (used + images.reduce((size, image) => size + image.url.length, 0) > 12_000_000) {
          return {
            ...thread,
            error: 'Image history is full. Delete an older chat to attach more images.',
          };
        }
        return { ...thread, images: [...thread.images, ...images], error: '' };
      });
    } catch (error) {
      updateChat(id, (thread) => ({
        ...thread,
        error: error instanceof Error ? error.message : 'Could not attach images.',
      }));
    } finally {
      setLoading(false);
    }
  }

  return { loading, attach };
}
