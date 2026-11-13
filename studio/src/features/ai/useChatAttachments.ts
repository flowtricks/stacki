import { useState } from 'react';
import { studioTranslate } from './studioWords';
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
          return { ...thread, error: studioTranslate()('ai.studio.attachLimit', { count: 4 }) };
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
            error: studioTranslate()('ai.studio.imagesFull'),
          };
        }
        return { ...thread, images: [...thread.images, ...images], error: '' };
      });
    } catch (error) {
      updateChat(id, (thread) => ({
        ...thread,
        error: error instanceof Error ? error.message : studioTranslate()('ai.studio.attachFailed'),
      }));
    } finally {
      setLoading(false);
    }
  }

  return { loading, attach };
}
